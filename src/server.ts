/**
 * Hono HTTP + WebSocket entrypoint for local / container runs.
 * Vercel queue consumer lives in api/queues/tx-events.ts.
 */
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { createDb } from "./db/client.js";
import { createConnectRelay } from "./connect/relay.js";
import { MemoryConnectStore, PgConnectStore } from "./connect/store.js";
import { loadProxyTrust, loadPublicWsBase } from "../config/connect.js";

const databaseUrl = process.env.DATABASE_URL;
const dbHandle = databaseUrl ? createDb(databaseUrl) : undefined;

if (!databaseUrl) {
  console.warn("[db] DATABASE_URL unset: device/push routes return 503, relay sessions stay in memory");
} else {
  console.log("[db] postgres");
}

const connectRelay = createConnectRelay({
  store: dbHandle ? new PgConnectStore(dbHandle.db) : new MemoryConnectStore(),
  proxyTrust: loadProxyTrust(),
  publicWsBase: loadPublicWsBase(),
});

const app = createApp({ db: dbHandle?.db, connectRelay });

const port = Number(process.env.PORT ?? 8788);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`zunia-backend :${port}`);
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
