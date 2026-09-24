import type { IncomingHttpHeaders } from "node:http";
import type { ProxyTrust } from "../../config/connect.js";
import {
  TOKEN_PATTERN,
  TOKEN_PROTOCOL_PREFIX,
  ZUNIA_CONNECT_PROTOCOL,
} from "./protocol.js";

type HeaderSource = IncomingHttpHeaders | Headers;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

/** The client address used for rate limits, following the configured proxy trust. */
export function clientIp(
  headers: HeaderSource,
  remoteAddress: string | undefined,
  trust: ProxyTrust,
): string {
  if (trust.mode === "cloudflare") {
    const forwarded = header(headers, "cf-connecting-ip")?.trim();
    if (forwarded) return forwarded;
  }
  if (trust.mode === "hops") {
    const chain = (header(headers, "x-forwarded-for") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const forwarded = chain[chain.length - trust.hops];
    if (forwarded) return forwarded;
  }
  return remoteAddress ?? "unknown";
}

/** Whether the request reached a trusted proxy over HTTPS. */
export function forwardedHttps(headers: HeaderSource, trust: ProxyTrust): boolean {
  if (trust.mode === "none") return false;
  const proto = header(headers, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}

/**
 * The browser-set `Origin` of the request that created the session.
 * Page scripts cannot choose this header. Anything that is not a plain
 * http(s) origin, including `null`, is treated as unverified.
 */
export function verifiedOriginFrom(value: string | undefined | null): string | null {
  if (!value || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

export function offeredProtocols(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  return raw
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

/** The bearer token from `zunia.token.<token>`, when `zunia.connect.v2` is also offered. */
export function tokenFromProtocols(protocols: readonly string[]): string | null {
  if (!protocols.includes(ZUNIA_CONNECT_PROTOCOL)) return null;
  const tokens = protocols
    .filter((protocol) => protocol.startsWith(TOKEN_PROTOCOL_PREFIX))
    .map((protocol) => protocol.slice(TOKEN_PROTOCOL_PREFIX.length));
  const [token] = tokens;
  return tokens.length === 1 && token && TOKEN_PATTERN.test(token) ? token : null;
}

export function bearerToken(value: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  return match?.[1] ?? null;
}
