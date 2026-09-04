import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Db } from "./db/client.js";
import { loadCorsOrigins } from "../config/cors.js";
import { rateLimitMiddleware } from "./middleware/rate-limit-hono.js";
import {
  createRateLimitStore,
  type RateLimitStore,
} from "./middleware/rate-limit.js";
import { createPushRoutes } from "./routes/push.js";
import { createProxyRoutes } from "./routes/proxy.js";

export type AppDeps = {
  db?: Db;
  rateLimitStore?: RateLimitStore;
  corsOrigins?: string[];
};

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();
  const origins = deps.corsOrigins ?? loadCorsOrigins();
  const rateStore = deps.rateLimitStore ?? createRateLimitStore();

  app.use(
    "*",
    cors({
      origin: (origin) => (origins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Device-Id",
        "X-Zunia-Session",
      ],
      maxAge: 600,
    }),
  );

  app.use(
    "*",
    rateLimitMiddleware({
      windowMs: 60_000,
      max: 120,
      store: rateStore,
    }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "zunia-backend",
      db: deps.db ? "configured" : "unset",
      time: new Date().toISOString(),
    }),
  );

  if (deps.db) {
    app.route("/", createPushRoutes(deps.db));
  } else {
    app.all("/v1/devices/*", (c) =>
      c.json({ error: "DATABASE_URL required for device routes" }, 503),
    );
  }

  app.route("/", createProxyRoutes());

  return app;
}
