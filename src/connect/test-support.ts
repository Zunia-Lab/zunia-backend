/** Shared helpers for the relay tests. Excluded from the build. */
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import type { ConnectRelayConfig, ProxyTrust } from "../../config/connect.js";
import { createApp } from "../app.js";
import { createDb } from "../db/client.js";
import {
  TOKEN_PROTOCOL_PREFIX,
  ZUNIA_CONNECT_PROTOCOL,
  type ConnectRole,
  type CreateSessionResponse,
  type ServerFrame,
} from "./protocol.js";
import { createConnectRelay, type ConnectRelay } from "./relay.js";
import { MemoryConnectStore, type ConnectStore } from "./store.js";

/**
 * The test database URL with its own schema, so test files running in parallel
 * never share a table. Undefined when TEST_DATABASE_URL is unset.
 */
export function testDatabaseUrl(schema: string): string | undefined {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return undefined;
  const url = new URL(base);
  url.searchParams.set("search_path", schema);
  return url.toString();
}

/** Recreate `connect_sessions` from the migration in the URL's schema, in a disposable database. */
export async function resetConnectSessionsTable(databaseUrl: string): Promise<void> {
  const schema = new URL(databaseUrl).searchParams.get("search_path");
  if (!schema || !/^[a-z_]+$/.test(schema)) throw new Error("Test URLs need a search_path schema");
  const handle = createDb(databaseUrl);
  try {
    await handle.client.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await handle.client.unsafe('DROP TABLE IF EXISTS "connect_sessions"');
    const migration = await readFile(
      new URL("../../drizzle/0001_connect_sessions.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.replace(/--.*$/gm, "").trim()) await handle.client.unsafe(statement);
    }
  } finally {
    await handle.close();
  }
}

export interface RelayHarness {
  base: string;
  wsBase: string;
  relay: ConnectRelay;
  store: ConnectStore;
  clock: { now: number };
  createSession(headers?: Record<string, string>): Promise<CreateSessionResponse>;
  close(): Promise<void>;
}

export async function startRelay(
  options: {
    config?: Partial<ConnectRelayConfig>;
    store?: ConnectStore;
    proxyTrust?: ProxyTrust;
  } = {},
): Promise<RelayHarness> {
  const store = options.store ?? new MemoryConnectStore();
  const clock = { now: Date.now() };
  const relay = createConnectRelay({
    store,
    config: options.config,
    proxyTrust: options.proxyTrust,
    now: () => clock.now,
    log: () => undefined,
  });
  const app = createApp({ connectRelay: relay, corsOrigins: ["https://wallet.zunialab.com"] });
  const server = await new Promise<Server>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(started as unknown as Server),
    );
  });
  relay.attach(server);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    wsBase: `ws://127.0.0.1:${port}`,
    relay,
    store,
    clock,
    async createSession(headers = { Origin: "https://app.example.com" }) {
      const res = await fetch(`${base}/v1/connect/sessions`, { method: "POST", headers });
      if (res.status !== 201) throw new Error(`createSession answered ${res.status}`);
      return (await res.json()) as CreateSessionResponse;
    },
    async close() {
      await relay.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A relay client that records frames and lets a test await them in order. */
export class RelayClient {
  private readonly inbox: ServerFrame[] = [];
  private readonly waiters: Array<{
    type: ServerFrame["t"];
    resolve: (frame: ServerFrame) => void;
  }> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    ws.on("error", () => undefined);
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as ServerFrame;
      const index = this.waiters.findIndex((waiter) => waiter.type === frame.t);
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(frame);
      } else {
        this.inbox.push(frame);
      }
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  /** The next unread frame of this type. */
  next<T extends ServerFrame["t"]>(type: T, timeoutMs = 2000): Promise<Extract<ServerFrame, { t: T }>> {
    const index = this.inbox.findIndex((frame) => frame.t === type);
    if (index >= 0) {
      const [frame] = this.inbox.splice(index, 1);
      return Promise.resolve(frame as Extract<ServerFrame, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve: (frame: ServerFrame) => {
          clearTimeout(timer);
          resolve(frame as Extract<ServerFrame, { t: T }>);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`No ${type} frame within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Frames received and not awaited yet. */
  unread(): readonly ServerFrame[] {
    return this.inbox;
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** Round trip through the relay, so every frame sent before has been handled. */
  async settle(): Promise<void> {
    this.send({ t: "ping" });
    await this.next("pong");
  }

  close(): void {
    this.ws.close();
  }
}

export function protocolsFor(token: string): string[] {
  return [ZUNIA_CONNECT_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`];
}

/** Open a relay socket. Resolves once the handshake completes, before any admission close. */
export function openSocket(
  harness: RelayHarness,
  sessionId: string,
  role: ConnectRole | string,
  token: string,
  options: { autoPong?: boolean } = {},
): Promise<RelayClient> {
  const url = `${harness.wsBase}/v1/connect/ws?sid=${encodeURIComponent(sessionId)}&role=${role}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocolsFor(token), { autoPong: options.autoPong ?? true });
    const client = new RelayClient(ws);
    ws.once("open", () => resolve(client));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", (error) => reject(error));
  });
}

/** Raw upgrade that returns the HTTP status when the relay refuses before the handshake. */
export function upgradeStatus(harness: RelayHarness, path: string, protocols: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${harness.wsBase}${path}`, protocols);
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", (error) => reject(error));
  });
}

export const NONCE = "AAAAAAAAAAAAAAAA";
export const CIPHERTEXT = "c".repeat(40);
export const PUBLIC_KEY = "p".repeat(43);
