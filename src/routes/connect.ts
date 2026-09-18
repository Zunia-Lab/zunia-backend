import type { Server } from "node:http";
import { Hono } from "hono";
import { z } from "zod";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ZUNIA_CONNECT_PROTOCOL_VERSION,
  ZUNIA_NATIVE_CONNECT,
  type CreateConnectSessionResponse,
  type ZuniaConnectEnvelope,
  type ZuniaConnectRole,
} from "./connect-protocol.js";

type Role = ZuniaConnectRole;

interface Room {
  sessionId: string;
  pairingSecret: string;
  expiresAt: number;
  metadata: {
    name: string;
    description?: string;
    url: string;
    icons?: string[];
  };
  chains: string[];
  methods: string[];
  events: string[];
  dapp?: WebSocket;
  wallet?: WebSocket;
  approved: boolean;
}

const rooms = new Map<string, Room>();

const createSchema = z.object({
  metadata: z.object({
    name: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    url: z.string().url(),
    icons: z.array(z.string().url()).max(8).optional(),
  }),
  chains: z.array(z.string().min(1)).min(1).max(32),
  methods: z.array(z.string()).max(32).optional(),
  events: z.array(z.string()).max(16).optional(),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

function publicWsBase(): string {
  return (
    process.env.CONNECT_WS_PUBLIC_URL?.replace(/\/$/, "") ||
    `ws://localhost:${process.env.PORT ?? 8788}`
  );
}

function publicHttpBase(): string {
  const ws = publicWsBase();
  if (ws.startsWith("wss://")) return `https://${ws.slice(6)}`;
  if (ws.startsWith("ws://")) return `http://${ws.slice(5)}`;
  return `http://localhost:${process.env.PORT ?? 8788}`;
}

function deepLinkFor(sessionId: string, pairingSecret: string): string {
  return `${ZUNIA_NATIVE_CONNECT.deepLinkPath}?sid=${encodeURIComponent(sessionId)}&k=${encodeURIComponent(pairingSecret)}`;
}

function qrPayload(sessionId: string, pairingSecret: string): string {
  return deepLinkFor(sessionId, pairingSecret);
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.expiresAt <= now) {
      try {
        room.dapp?.close();
        room.wallet?.close();
      } catch {
        /* ignore */
      }
      rooms.delete(id);
    }
  }
}

setInterval(purgeExpired, 30_000).unref?.();

function send(ws: WebSocket, envelope: ZuniaConnectEnvelope): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(envelope));
  }
}

function peerOf(room: Room, role: Role): WebSocket | undefined {
  return role === "dapp" ? room.wallet : room.dapp;
}

function attachSocket(room: Room, role: Role, ws: WebSocket): void {
  const existing = role === "dapp" ? room.dapp : room.wallet;
  if (existing && existing !== ws) {
    try {
      existing.close(4000, "replaced");
    } catch {
      /* ignore */
    }
  }
  if (role === "dapp") room.dapp = ws;
  else room.wallet = ws;

  send(ws, {
    v: ZUNIA_CONNECT_PROTOCOL_VERSION,
    type: "hello_ok",
    ts: Date.now(),
    payload: {
      role,
      peers: [
        ...(room.dapp ? (["dapp"] as const) : []),
        ...(room.wallet ? (["wallet"] as const) : []),
      ],
      expiresAt: room.expiresAt,
    },
  });

  ws.on("message", (raw) => {
    let envelope: ZuniaConnectEnvelope;
    try {
      envelope = JSON.parse(String(raw)) as ZuniaConnectEnvelope;
    } catch {
      send(ws, {
        v: ZUNIA_CONNECT_PROTOCOL_VERSION,
        type: "error",
        ts: Date.now(),
        payload: { code: "BAD_JSON", message: "Invalid JSON frame" },
      });
      return;
    }

    if (envelope.v !== ZUNIA_CONNECT_PROTOCOL_VERSION) {
      send(ws, {
        v: ZUNIA_CONNECT_PROTOCOL_VERSION,
        type: "error",
        ts: Date.now(),
        id: envelope.id,
        payload: { code: "BAD_VERSION", message: "Unsupported protocol version" },
      });
      return;
    }

    if (envelope.type === "ping") {
      send(ws, {
        v: ZUNIA_CONNECT_PROTOCOL_VERSION,
        type: "pong",
        id: envelope.id,
        ts: Date.now(),
        payload: {},
      });
      return;
    }

    if (envelope.type === "hello") {
      send(ws, {
        v: ZUNIA_CONNECT_PROTOCOL_VERSION,
        type: "hello_ok",
        id: envelope.id,
        ts: Date.now(),
        payload: {
          role,
          peers: [
            ...(room.dapp ? (["dapp"] as const) : []),
            ...(room.wallet ? (["wallet"] as const) : []),
          ],
          expiresAt: room.expiresAt,
        },
      });
      return;
    }

    if (envelope.type === "connect_approve") {
      room.approved = true;
      room.expiresAt =
        Date.now() + ZUNIA_NATIVE_CONNECT.pairedTtlSeconds * 1000;
    }

    if (envelope.type === "disconnect") {
      const other = peerOf(room, role);
      if (other) send(other, envelope);
      try {
        room.dapp?.close();
        room.wallet?.close();
      } catch {
        /* ignore */
      }
      rooms.delete(room.sessionId);
      return;
    }

    const other = peerOf(room, role);
    if (!other) {
      send(ws, {
        v: ZUNIA_CONNECT_PROTOCOL_VERSION,
        type: "error",
        ts: Date.now(),
        id: envelope.id,
        payload: {
          code: "PEER_MISSING",
          message: "Waiting for the other peer to join",
        },
      });
      return;
    }
    send(other, envelope);
  });

  ws.on("close", () => {
    if (role === "dapp" && room.dapp === ws) room.dapp = undefined;
    if (role === "wallet" && room.wallet === ws) room.wallet = undefined;
    const other = peerOf(room, role);
    if (other) {
      send(other, {
        v: ZUNIA_CONNECT_PROTOCOL_VERSION,
        type: "disconnect",
        ts: Date.now(),
        payload: { reason: "peer_disconnected" },
      });
    }
  });
}

export function createConnectRoutes() {
  const app = new Hono();

  app.post("/v1/connect/sessions", async (c) => {
    const body = createSchema.parse(await c.req.json());
    purgeExpired();
    const sessionId = crypto.randomUUID();
    const pairingSecret = crypto.randomUUID().replace(/-/g, "");
    const ttl =
      body.ttlSeconds ?? ZUNIA_NATIVE_CONNECT.unpairedTtlSeconds;
    const expiresAt = Date.now() + ttl * 1000;
    const room: Room = {
      sessionId,
      pairingSecret,
      expiresAt,
      metadata: body.metadata,
      chains: body.chains,
      methods: body.methods ?? [...ZUNIA_NATIVE_CONNECT.defaultMethods],
      events: body.events ?? [...ZUNIA_NATIVE_CONNECT.defaultEvents],
      approved: false,
    };
    rooms.set(sessionId, room);

    const httpBase = publicHttpBase();
    const wsBase = publicWsBase();
    const response: CreateConnectSessionResponse = {
      sessionId,
      pairingSecret,
      expiresAt,
      wsUrl: `${wsBase}${ZUNIA_NATIVE_CONNECT.wsPath}?sid=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(pairingSecret)}`,
      deepLink: deepLinkFor(sessionId, pairingSecret),
      qrPayload: qrPayload(sessionId, pairingSecret),
      httpUrl: `${httpBase}${ZUNIA_NATIVE_CONNECT.httpPath}/${sessionId}`,
    };
    return c.json(response, 201);
  });

  app.get("/v1/connect/sessions/:id", (c) => {
    purgeExpired();
    const room = rooms.get(c.req.param("id"));
    if (!room) return c.json({ error: "Session not found" }, 404);
    return c.json({
      sessionId: room.sessionId,
      expiresAt: room.expiresAt,
      metadata: room.metadata,
      chains: room.chains,
      methods: room.methods,
      events: room.events,
      approved: room.approved,
      peers: {
        dapp: Boolean(room.dapp),
        wallet: Boolean(room.wallet),
      },
    });
  });

  app.delete("/v1/connect/sessions/:id", (c) => {
    const room = rooms.get(c.req.param("id"));
    if (!room) return c.json({ error: "Session not found" }, 404);
    try {
      room.dapp?.close();
      room.wallet?.close();
    } catch {
      /* ignore */
    }
    rooms.delete(room.sessionId);
    return c.json({ ok: true });
  });

  return app;
}

export function attachConnectWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== ZUNIA_NATIVE_CONNECT.wsPath) {
      socket.destroy();
      return;
    }
    const sid = url.searchParams.get("sid") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const role = (url.searchParams.get("role") ?? "") as Role;
    const room = rooms.get(sid);
    if (
      !room ||
      room.pairingSecret !== token ||
      (role !== "dapp" && role !== "wallet") ||
      room.expiresAt <= Date.now()
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachSocket(room, role, ws);
    });
  });

  return wss;
}

/** Test helper */
export function _connectRoomsForTests(): Map<string, Room> {
  return rooms;
}
