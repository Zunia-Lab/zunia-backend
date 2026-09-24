import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Hono, type Context } from "hono";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  CONNECT_RELAY_CONFIG,
  type ConnectRelayConfig,
  type ProxyTrust,
} from "../../config/connect.js";
import {
  CLOSE_CODES,
  CONNECT_PATHS,
  FRAME_SENDERS,
  SESSION_ID_PATTERN,
  ZUNIA_CONNECT_PROTOCOL,
  clientFrameSchema,
  type ClientFrame,
  type ConnectRole,
  type CreateSessionResponse,
  type RelayErrorCode,
  type ServerFrame,
  type SessionEndReason,
  type SessionStatusResponse,
} from "./protocol.js";
import { WindowLimiter } from "./limits.js";
import {
  bearerToken,
  clientIp,
  forwardedHttps,
  offeredProtocols,
  tokenFromProtocols,
  verifiedOriginFrom,
} from "./request.js";
import type { ConnectSessionRecord, ConnectStore } from "./store.js";
import { hashToken, newSessionId, newToken, tokenMatches } from "./tokens.js";

export interface ConnectRelayOptions {
  store: ConnectStore;
  config?: Partial<ConnectRelayConfig>;
  proxyTrust?: ProxyTrust;
  /** Public WebSocket base returned to dApps, for example `wss://api.zunialab.com`. */
  publicWsBase?: string;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export interface ConnectRelay {
  routes: Hono;
  attach(server: Server): WebSocketServer;
  /** Remove expired sessions now. Runs on a timer once attached. */
  sweep(): Promise<void>;
  stats(): { liveSessions: number; sockets: number };
  close(): Promise<void>;
}

interface QueuedFrame {
  data: string;
  at: number;
}

interface Room {
  id: string;
  verifiedOrigin: string | null;
  paired: boolean;
  expiresAt: number;
  sockets: Record<ConnectRole, WebSocket | null>;
  /** Frames waiting for a role that is offline. */
  queues: Record<ConnectRole, QueuedFrame[]>;
  queuedBytes: number;
  /** Frames of one session are handled in order, including the async ones. */
  chain: Promise<void>;
  ended: boolean;
}

interface SocketState {
  room: Room;
  role: ConnectRole;
  alive: boolean;
  windowStart: number;
  frames: number;
}

interface Admission {
  record: ConnectSessionRecord;
  role: ConnectRole;
  resumeToken?: string;
}

const ROLES: readonly ConnectRole[] = ["dapp", "wallet"];

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
};

function otherRole(role: ConnectRole): ConnectRole {
  return role === "dapp" ? "wallet" : "dapp";
}

function send(ws: WebSocket | null, frame: ServerFrame): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function sendError(ws: WebSocket, code: RelayErrorCode, message: string): void {
  send(ws, { t: "error", code, message });
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function rejectUpgrade(socket: Duplex, status: number): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function remoteAddressOf(c: Context): string | undefined {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return env?.incoming?.socket.remoteAddress;
}

export function createConnectRelay(options: ConnectRelayOptions): ConnectRelay {
  const cfg: ConnectRelayConfig = { ...CONNECT_RELAY_CONFIG, ...options.config };
  const store = options.store;
  const trust: ProxyTrust = options.proxyTrust ?? { mode: "none" };
  const clock = options.now ?? Date.now;
  const log = options.log ?? ((message, error) => console.warn(`[connect] ${message}`, error ?? ""));

  const rooms = new Map<string, Room>();
  const sockets = new Map<WebSocket, SocketState>();
  const createLimiter = new WindowLimiter(cfg.createLimit, cfg.createWindowMs);
  const upgradeLimiter = new WindowLimiter(cfg.upgradeLimit, cfg.upgradeWindowMs);
  const timers: NodeJS.Timeout[] = [];
  const servers: WebSocketServer[] = [];

  function wsBaseFor(c: Context): string {
    if (options.publicWsBase) return options.publicWsBase;
    const url = new URL(c.req.url);
    const secure = url.protocol === "https:" || forwardedHttps(c.req.raw.headers, trust);
    return `${secure ? "wss:" : "ws:"}//${url.host}`;
  }

  function pruneQueues(room: Room, now: number): void {
    let bytes = 0;
    for (const role of ROLES) {
      room.queues[role] = room.queues[role].filter((frame) => now - frame.at < cfg.queueTtlMs);
      for (const frame of room.queues[role]) bytes += frame.data.length;
    }
    room.queuedBytes = bytes;
  }

  function closeRoom(room: Room, reason: SessionEndReason): void {
    if (room.ended) return;
    room.ended = true;
    rooms.delete(room.id);
    for (const role of ROLES) {
      const ws = room.sockets[role];
      room.sockets[role] = null;
      if (!ws) continue;
      sockets.delete(ws);
      send(ws, { t: "closed", reason });
      ws.close(CLOSE_CODES.ended, reason);
    }
  }

  async function endSession(id: string, reason: SessionEndReason): Promise<void> {
    const room = rooms.get(id);
    if (room) closeRoom(room, reason);
    await store.remove(id);
  }

  function deliver(room: Room, to: ConnectRole, frame: ServerFrame, sender: WebSocket): void {
    const data = JSON.stringify(frame);
    const target = room.sockets[to];
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(data);
      return;
    }
    const now = clock();
    pruneQueues(room, now);
    if (
      room.queues[to].length >= cfg.queueMaxFrames ||
      room.queuedBytes + data.length > cfg.queueMaxBytes
    ) {
      sendError(sender, "QUEUE_FULL", "The other side is offline and its queue is full");
      return;
    }
    room.queues[to].push({ data, at: now });
    room.queuedBytes += data.length;
  }

  function flushQueue(room: Room, role: ConnectRole): void {
    pruneQueues(room, clock());
    const ws = room.sockets[role];
    if (!ws) return;
    for (const frame of room.queues[role]) ws.send(frame.data);
    room.queues[role] = [];
    pruneQueues(room, clock());
  }

  async function handleFrame(room: Room, role: ConnectRole, ws: WebSocket, frame: ClientFrame): Promise<void> {
    if (room.ended || room.sockets[role] !== ws) return;
    switch (frame.t) {
      case "ping":
        send(ws, { t: "pong" });
        return;
      case "hello":
        if (room.paired) {
          sendError(ws, "FORBIDDEN", "Pairing is locked");
          return;
        }
        deliver(room, "dapp", { t: "hello", pk: frame.pk }, ws);
        return;
      case "msg":
        deliver(room, otherRole(role), { t: "msg", n: frame.n, c: frame.c }, ws);
        return;
      case "paired": {
        if (!room.paired) {
          const expiresAt = clock() + cfg.pairedTtlSeconds * 1000;
          await store.markPaired(room.id, expiresAt);
          room.paired = true;
          room.expiresAt = expiresAt;
          for (const peer of ROLES) send(room.sockets[peer], { t: "paired", expiresAt });
        } else {
          send(ws, { t: "paired", expiresAt: room.expiresAt });
        }
        return;
      }
      case "close":
        await endSession(room.id, "closed");
        return;
    }
  }

  function onFrame(ws: WebSocket, data: RawData, isBinary: boolean): void {
    const state = sockets.get(ws);
    if (!state) return;
    const now = clock();
    if (now - state.windowStart >= cfg.socketFrameWindowMs) {
      state.windowStart = now;
      state.frames = 0;
    }
    state.frames += 1;
    if (state.frames > cfg.socketFrameLimit) {
      ws.close(CLOSE_CODES.rateLimited, "rate_limited");
      return;
    }
    if (isBinary) {
      sendError(ws, "BAD_FRAME", "Frames must be JSON text");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText(data));
    } catch {
      sendError(ws, "BAD_FRAME", "Frame is not valid JSON");
      return;
    }
    const result = clientFrameSchema.safeParse(parsed);
    if (!result.success) {
      sendError(ws, "BAD_FRAME", "Unknown or malformed frame");
      return;
    }
    const frame = result.data;
    if (!FRAME_SENDERS[frame.t].includes(state.role)) {
      sendError(ws, "FORBIDDEN", `The ${state.role} may not send ${frame.t}`);
      return;
    }
    const { room, role } = state;
    room.chain = room.chain
      .then(() => handleFrame(room, role, ws, frame))
      .catch((error: unknown) => log("frame handling failed", error));
  }

  function onSocketClose(ws: WebSocket): void {
    const state = sockets.get(ws);
    sockets.delete(ws);
    if (!state) return;
    const { room, role } = state;
    if (room.sockets[role] !== ws) return;
    room.sockets[role] = null;
    send(room.sockets[otherRole(role)], { t: "peer", online: false });
    if (!room.sockets.dapp && !room.sockets.wallet && room.queuedBytes === 0) {
      rooms.delete(room.id);
    }
  }

  function attachSocket(ws: WebSocket, admission: Admission): void {
    const { record, role, resumeToken } = admission;
    let room = rooms.get(record.id);
    if (!room) {
      room = {
        id: record.id,
        verifiedOrigin: record.verifiedOrigin,
        paired: record.paired,
        expiresAt: record.expiresAt,
        sockets: { dapp: null, wallet: null },
        queues: { dapp: [], wallet: [] },
        queuedBytes: 0,
        chain: Promise.resolve(),
        ended: false,
      };
      rooms.set(room.id, room);
    }
    if (room.expiresAt <= clock()) {
      ws.close(CLOSE_CODES.unauthorized, "unauthorized");
      return;
    }

    const previous = room.sockets[role];
    room.sockets[role] = ws;
    sockets.set(ws, { room, role, alive: true, windowStart: clock(), frames: 0 });
    if (previous) {
      sockets.delete(previous);
      previous.close(CLOSE_CODES.replaced, "replaced");
    }

    ws.on("message", (data, isBinary) => onFrame(ws, data, isBinary));
    ws.on("pong", () => {
      const state = sockets.get(ws);
      if (state) state.alive = true;
    });
    ws.on("close", () => onSocketClose(ws));
    ws.on("error", () => ws.terminate());

    const peer = room.sockets[otherRole(role)];
    send(ws, {
      t: "welcome",
      v: ZUNIA_CONNECT_PROTOCOL,
      role,
      sessionId: room.id,
      verifiedOrigin: room.verifiedOrigin,
      paired: room.paired,
      peer: peer !== null,
      expiresAt: room.expiresAt,
      ...(resumeToken ? { resumeToken } : {}),
    });
    if (!previous) send(peer, { t: "peer", online: true });
    flushQueue(room, role);
  }

  async function admit(sessionId: string, role: ConnectRole, token: string): Promise<Admission | null> {
    const record = await store.get(sessionId);
    if (!record || record.expiresAt <= clock()) return null;
    if (role === "dapp") {
      return tokenMatches(token, record.dappTokenHash) ? { record, role } : null;
    }
    if (tokenMatches(token, record.walletResumeTokenHash)) return { record, role };
    if (!tokenMatches(token, record.walletJoinTokenHash)) return null;
    const resumeToken = newToken();
    const resumeTokenHash = hashToken(resumeToken);
    if (!(await store.consumeJoin(sessionId, resumeTokenHash))) return null;
    return {
      record: { ...record, walletJoinTokenHash: null, walletResumeTokenHash: resumeTokenHash },
      role,
      resumeToken,
    };
  }

  async function onUpgrade(
    wss: WebSocketServer,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay.invalid");
    if (url.pathname !== CONNECT_PATHS.ws) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!upgradeLimiter.hit(clientIp(req.headers, req.socket.remoteAddress, trust), clock())) {
      rejectUpgrade(socket, 429);
      return;
    }
    const sessionId = url.searchParams.get("sid") ?? "";
    const role = url.searchParams.get("role");
    const token = tokenFromProtocols(offeredProtocols(req.headers["sec-websocket-protocol"]));
    if (!SESSION_ID_PATTERN.test(sessionId) || (role !== "dapp" && role !== "wallet") || !token) {
      rejectUpgrade(socket, 400);
      return;
    }
    const admission = await admit(sessionId, role, token);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!admission) {
        ws.close(CLOSE_CODES.unauthorized, "unauthorized");
        return;
      }
      attachSocket(ws, admission);
    });
  }

  async function authorize(c: Context): Promise<{ record: ConnectSessionRecord; role: ConnectRole } | null> {
    const id = c.req.param("id") ?? "";
    const token = bearerToken(c.req.header("authorization"));
    if (!SESSION_ID_PATTERN.test(id) || !token) return null;
    const record = await store.get(id);
    if (!record || record.expiresAt <= clock()) return null;
    if (tokenMatches(token, record.dappTokenHash)) return { record, role: "dapp" };
    if (tokenMatches(token, record.walletResumeTokenHash)) return { record, role: "wallet" };
    return null;
  }

  const routes = new Hono();

  routes.post(CONNECT_PATHS.sessions, async (c) => {
    const now = clock();
    c.header("Cache-Control", "no-store");
    const ip = clientIp(c.req.raw.headers, remoteAddressOf(c), trust);
    if (!createLimiter.hit(ip, now)) {
      c.header("Retry-After", String(Math.ceil(cfg.createWindowMs / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    if ((await store.countLive(now)) >= cfg.maxSessions) {
      return c.json({ error: "capacity" }, 503);
    }
    const sessionId = newSessionId();
    const dappToken = newToken();
    const walletJoinToken = newToken();
    const verifiedOrigin = verifiedOriginFrom(c.req.header("origin"));
    const expiresAt = now + cfg.unpairedTtlSeconds * 1000;
    await store.insert({
      id: sessionId,
      dappTokenHash: hashToken(dappToken),
      walletJoinTokenHash: hashToken(walletJoinToken),
      walletResumeTokenHash: null,
      verifiedOrigin,
      paired: false,
      expiresAt,
      createdAt: now,
    });
    const body: CreateSessionResponse = {
      v: ZUNIA_CONNECT_PROTOCOL,
      sessionId,
      dappToken,
      walletJoinToken,
      verifiedOrigin,
      expiresAt,
      wsUrl: `${wsBaseFor(c)}${CONNECT_PATHS.ws}`,
    };
    return c.json(body, 201);
  });

  routes.get(`${CONNECT_PATHS.sessions}/:id`, async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = await authorize(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const room = rooms.get(auth.record.id);
    const body: SessionStatusResponse = {
      v: ZUNIA_CONNECT_PROTOCOL,
      sessionId: auth.record.id,
      role: auth.role,
      verifiedOrigin: auth.record.verifiedOrigin,
      paired: room?.paired ?? auth.record.paired,
      peerOnline: Boolean(room?.sockets[otherRole(auth.role)]),
      expiresAt: room?.expiresAt ?? auth.record.expiresAt,
    };
    return c.json(body);
  });

  routes.delete(`${CONNECT_PATHS.sessions}/:id`, async (c) => {
    c.header("Cache-Control", "no-store");
    const auth = await authorize(c);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    await endSession(auth.record.id, "deleted");
    return c.body(null, 204);
  });

  async function sweep(): Promise<void> {
    const now = clock();
    for (const id of await store.removeExpired(now)) {
      const room = rooms.get(id);
      if (room) closeRoom(room, "expired");
    }
    for (const room of [...rooms.values()]) {
      if (room.expiresAt <= now) {
        closeRoom(room, "expired");
        await store.remove(room.id);
      } else {
        pruneQueues(room, now);
      }
    }
    createLimiter.prune(now);
    upgradeLimiter.prune(now);
  }

  function heartbeat(): void {
    for (const [ws, state] of sockets) {
      if (!state.alive) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }

  function attach(server: Server): WebSocketServer {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: cfg.maxPayloadBytes,
      perMessageDeflate: false,
      handleProtocols: (protocols) =>
        protocols.has(ZUNIA_CONNECT_PROTOCOL) ? ZUNIA_CONNECT_PROTOCOL : false,
    });
    servers.push(wss);
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on("error", () => socket.destroy());
      onUpgrade(wss, req, socket, head).catch((error: unknown) => {
        log("upgrade failed", error);
        rejectUpgrade(socket, 500);
      });
    });
    if (timers.length === 0) {
      const sweeper = setInterval(() => {
        sweep().catch((error: unknown) => log("sweep failed", error));
      }, cfg.sweepMs);
      const pinger = setInterval(heartbeat, cfg.heartbeatMs);
      sweeper.unref();
      pinger.unref();
      timers.push(sweeper, pinger);
    }
    return wss;
  }

  async function close(): Promise<void> {
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const ws of sockets.keys()) ws.terminate();
    sockets.clear();
    rooms.clear();
    await Promise.all(
      servers.splice(0).map((wss) => new Promise<void>((resolve) => wss.close(() => resolve()))),
    );
  }

  return {
    routes,
    attach,
    sweep,
    stats: () => ({ liveSessions: rooms.size, sockets: sockets.size }),
    close,
  };
}
