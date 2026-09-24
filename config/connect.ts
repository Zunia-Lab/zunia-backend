/**
 * Lifetimes and limits for the zunia.connect.v2 relay.
 * Tests pass overrides; production reads the defaults below plus the env vars documented here.
 */

export interface ConnectRelayConfig {
  /** Seconds an unpaired session waits for the wallet to scan the QR code. */
  unpairedTtlSeconds: number;
  /** Seconds a session lives once the wallet confirms pairing. */
  pairedTtlSeconds: number;
  /** Largest WebSocket frame accepted from a client, in bytes. */
  maxPayloadBytes: number;
  /** Frames one socket may send per window before it is closed. */
  socketFrameLimit: number;
  socketFrameWindowMs: number;
  /** Sessions one client IP may create per window. */
  createLimit: number;
  createWindowMs: number;
  /** WebSocket upgrades one client IP may attempt per window. */
  upgradeLimit: number;
  upgradeWindowMs: number;
  /** Live sessions across the relay. Creation answers 503 beyond this. */
  maxSessions: number;
  /** Frames held for a peer that is offline, per direction. */
  queueMaxFrames: number;
  /** Bytes held for offline peers, per session. */
  queueMaxBytes: number;
  /** Queued frames older than this are dropped. */
  queueTtlMs: number;
  /** Heartbeat interval. A socket that misses one heartbeat is dropped. */
  heartbeatMs: number;
  /** How often expired sessions are removed. */
  sweepMs: number;
}

export const CONNECT_RELAY_CONFIG: ConnectRelayConfig = {
  unpairedTtlSeconds: 600,
  pairedTtlSeconds: 86_400,
  maxPayloadBytes: 512 * 1024,
  socketFrameLimit: 120,
  socketFrameWindowMs: 10_000,
  createLimit: 20,
  createWindowMs: 60_000,
  upgradeLimit: 60,
  upgradeWindowMs: 60_000,
  maxSessions: 10_000,
  queueMaxFrames: 32,
  queueMaxBytes: 1024 * 1024,
  queueTtlMs: 10 * 60_000,
  heartbeatMs: 25_000,
  sweepMs: 30_000,
};

/**
 * Which request data identifies the client for rate limits.
 * - `none`: the TCP peer address (the relay is reached directly).
 * - `cloudflare`: the `CF-Connecting-IP` header. Only safe when the origin accepts Cloudflare traffic only.
 * - `hops`: the address `hops` entries from the right of `X-Forwarded-For`, for that many trusted proxies.
 */
export type ProxyTrust =
  | { mode: "none" }
  | { mode: "cloudflare" }
  | { mode: "hops"; hops: number };

/** Parse `TRUST_PROXY` (`none`, `cloudflare`, or a hop count such as `1`). */
export function loadProxyTrust(value = process.env.TRUST_PROXY): ProxyTrust {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === "none" || raw === "0") return { mode: "none" };
  if (raw === "cloudflare") return { mode: "cloudflare" };
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0 && hops <= 10) {
    return { mode: "hops", hops };
  }
  throw new Error(`TRUST_PROXY must be none, cloudflare or a hop count, got "${value}"`);
}

/** Public WebSocket base, for example `wss://api.zunialab.com`. Derived from the request when unset. */
export function loadPublicWsBase(value = process.env.CONNECT_WS_PUBLIC_URL): string | undefined {
  const raw = value?.trim().replace(/\/$/, "");
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("CONNECT_WS_PUBLIC_URL must start with ws:// or wss://");
  }
  return raw;
}
