/**
 * Hono HTTP + WebSocket entrypoint for local / container runs, and for the
 * Hetzner host. There, zunia-indexer delivers tx events to POST
 * /internal/tx-events (src/routes/internal.ts); on Vercel the queue consumer
 * in api/queues/tx-events.ts does the same.
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { createConnectRelay } from "./connect/relay.js";
import { MemoryConnectStore, PgConnectStore } from "./connect/store.js";
import { loadProxyTrust, loadPublicWsBase } from "../config/connect.js";
import { loadInternalEventsToken } from "./routes/internal.js";
import { fcmSenderFromEnv } from "./push/fcm.js";
import { indexerWatchFromEnv } from "./push/indexer-watch.js";

const databaseUrl = process.env.DATABASE_URL;
const dbHandle = databaseUrl ? createDb(databaseUrl) : undefined;

if (!databaseUrl) {
  console.warn("[db] DATABASE_URL unset: device/push routes return 503, relay sessions stay in memory");
} else {
  console.log("[db] postgres");
}

const proxyTrust = loadProxyTrust();
const connectRelay = createConnectRelay({
  store: dbHandle ? new PgConnectStore(dbHandle.db) : new MemoryConnectStore(),
  proxyTrust,
  publicWsBase: loadPublicWsBase(),
});

const internalEventsToken = loadInternalEventsToken();
if (!internalEventsToken) {
  console.warn("[push] INTERNAL_EVENTS_TOKEN unset: tx events from the indexer are refused");
}
// Read the service account now, so a missing or broken key shows at boot.
void fcmSenderFromEnv();

const app = createApp({
  db: dbHandle?.db,
  connectRelay,
  proxyTrust,
  internalEventsToken,
  indexerWatch: indexerWatchFromEnv(),
});

const port = Number(process.env.PORT ?? 8788);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`zunia-backend ${hostname}:${port}`);
  console.log(
    `[connect] ws ${process.env.CONNECT_WS_PUBLIC_URL ?? `ws://localhost:${port}`}/v1/connect/ws`,
  );
}) as unknown as Server;

connectRelay.attach(server);

async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal}`);
  await connectRelay.close();
  server.close();
  await dbHandle?.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
