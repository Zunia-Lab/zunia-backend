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
import { createInternalRoutes } from "./routes/internal.js";
import type { ConnectRelay } from "./connect/relay.js";
import type { ProxyTrust } from "../config/connect.js";
import type { IndexerWatch } from "./push/indexer-watch.js";

export type AppDeps = {
  db?: Db;
  rateLimitStore?: RateLimitStore;
  corsOrigins?: string[];
  /** zunia.connect.v2 relay. Its WebSocket side is attached to the HTTP server separately. */
  connectRelay?: ConnectRelay;
  /** How client addresses are read behind proxies (TRUST_PROXY), for the device routes' limits. */
  proxyTrust?: ProxyTrust;
  /** INTERNAL_EVENTS_TOKEN: POST /internal/tx-events is refused while it is unset. */
  internalEventsToken?: string;
  /** Asks zunia-indexer to watch the wallets devices subscribe to. */
  indexerWatch?: IndexerWatch;
};

const CONNECT_PREFIX = "/v1/connect/";
const INTERNAL_PREFIX = "/internal/";

export function createApp(deps: AppDeps = {}) {
  const app = new Hono();
  const origins = deps.corsOrigins ?? loadCorsOrigins();
  const rateStore = deps.rateLimitStore ?? createRateLimitStore();

  app.use(
    "*",
    cors({
      // Any dApp may open a relay session: those routes use bearer tokens, never cookies.
      origin: (origin, c) =>
        !origin ||
        c.req.path.startsWith(CONNECT_PREFIX) ||
        origins.includes(origin) ||
        origins.includes("*")
          ? origin || "*"
          : null,
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

  const limit = rateLimitMiddleware({
    windowMs: 60_000,
    max: 120,
    store: rateStore,
  });
  // The indexer's tx events come from 127.0.0.1 with no client headers, so they
  // would share one anonymous bucket; they are authenticated by secret instead.
  app.use("*", (c, next) => (c.req.path.startsWith(INTERNAL_PREFIX) ? next() : limit(c, next)));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "zunia-backend",
      db: deps.db ? "configured" : "unset",
      connect: deps.connectRelay ? "enabled" : "unset",
      time: new Date().toISOString(),
    }),
  );

  app.route(
    "/",
    createInternalRoutes({ db: deps.db, token: deps.internalEventsToken }),
  );

  if (deps.db) {
    app.route(
      "/",
      createPushRoutes(deps.db, { proxyTrust: deps.proxyTrust, watch: deps.indexerWatch }),
    );
  } else {
    app.all("/v1/devices/*", (c) =>
      c.json({ error: "DATABASE_URL required for device routes" }, 503),
    );
  }

  app.route("/", createProxyRoutes());

  if (deps.connectRelay) {
    app.route("/", deps.connectRelay.routes);
  } else {
    app.all(`${CONNECT_PREFIX}*`, (c) => c.json({ error: "Connect relay not configured" }, 503));
  }

  return app;
}
