/**
 * Rate limiter with Redis-ready interface and in-memory sliding window fallback.
 */

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

export interface RateLimitStore {
  /** Record a hit and return whether the request is allowed. */
  hit(key: string, windowMs: number, max: number): Promise<RateLimitResult>;
}

/** In-memory sliding window — fine for single instance / local scaffold. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  async hit(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const prev = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (prev.length >= max) {
      const oldest = prev[0] ?? now;
      return {
        allowed: false,
        remaining: 0,
        resetAt: oldest + windowMs,
      };
    }
    prev.push(now);
    this.hits.set(key, prev);
    return {
      allowed: true,
      remaining: Math.max(0, max - prev.length),
      resetAt: now + windowMs,
    };
  }

  /** Test helper */
  clear(): void {
    this.hits.clear();
  }
}

/**
 * Redis / Upstash adapter stub.
 * TODO: wire Upstash REST or ioredis when RATE_LIMIT_REDIS_URL is set.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly _redisUrl: string) {}

  async hit(key: string, windowMs: number, max: number): Promise<RateLimitResult> {
    void key;
    void windowMs;
    void max;
    throw new Error(
      "RedisRateLimitStore not implemented — set no RATE_LIMIT_REDIS_URL to use memory",
    );
  }
}

export function createRateLimitStore(): RateLimitStore {
  const redisUrl = process.env.RATE_LIMIT_REDIS_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  if (redisUrl) {
    // Prefer Redis when configured; fall back to memory until implemented.
    console.warn(
      "[rate-limit] RATE_LIMIT_REDIS_URL set but Redis store is stubbed; using memory",
    );
  }
  return new MemoryRateLimitStore();
}

export type RateLimitOptions = {
  windowMs: number;
  max: number;
  store?: RateLimitStore;
  keyFn?: (headers: Headers, path: string) => string;
};

export function defaultRateLimitKey(headers: Headers, _path: string): string {
  return (
    headers.get("x-device-id") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("cf-connecting-ip") ??
    "anon"
  );
}
