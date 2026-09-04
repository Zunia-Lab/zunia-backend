import { createMiddleware } from "hono/factory";
import {
  createRateLimitStore,
  defaultRateLimitKey,
  type RateLimitOptions,
  type RateLimitStore,
} from "./rate-limit.js";

export function rateLimitMiddleware(options: RateLimitOptions) {
  const store: RateLimitStore = options.store ?? createRateLimitStore();
  const keyFn = options.keyFn ?? defaultRateLimitKey;

  return createMiddleware(async (c, next) => {
    const key = keyFn(c.req.raw.headers, c.req.path);
    const result = await store.hit(key, options.windowMs, options.max);
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
}
