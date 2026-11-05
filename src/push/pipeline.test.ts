import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { testDatabaseUrl } from "../connect/test-support.js";
import { createDb } from "../db/client.js";
import { devices } from "../db/schema.js";
import { createInternalRoutes, INTERNAL_TOKEN_HEADER } from "../routes/internal.js";
import { createPushRoutes } from "../routes/push.js";
import { processTxDetectedEvent, type PushSenders } from "./consumer.js";
import type { PushSendResult } from "./types.js";

/** Set TEST_DATABASE_URL to a disposable database to run this file. */
const databaseUrl = testDatabaseUrl("push_pipeline");
const TOKEN = "internal-events-token-0123456789abcdef";
const HUB = "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
const OSMO = "osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";

/** The initial migration, created in the test URL's own schema. */
async function migrate(url: string): Promise<void> {
  const schema = new URL(url).searchParams.get("search_path") ?? "";
  if (!/^[a-z_]+$/.test(schema)) throw new Error("test URLs need a search_path schema");
  const handle = createDb(url);
  try {
    await handle.client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await handle.client.unsafe(`CREATE SCHEMA "${schema}"`);
    const sql = (await readFile(new URL("../../drizzle/0000_initial.sql", import.meta.url), "utf8")).replaceAll(
      '"public".',
      `"${schema}".`,
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.replace(/--.*$/gm, "").trim()) await handle.client.unsafe(statement);
    }
  } finally {
    await handle.close();
  }
}

describe("push pipeline with postgres", { skip: !databaseUrl && "TEST_DATABASE_URL unset" }, () => {
  const url = databaseUrl ?? "";
  let handle: ReturnType<typeof createDb>;
  let pepper: string | undefined;
  const pushes: Array<{ token: string; chainId: string }> = [];
  let answer: PushSendResult = { ok: true };
  const watched: Array<{ chainId: string; subject: string }> = [];

  const senders: PushSenders = {
    fcm: async ({ deviceToken, payload }) => {
      pushes.push({ token: deviceToken, chainId: payload.chainId });
      return answer;
    },
    webPush: async () => ({ ok: true }),
  };

  let app: Hono;

  before(async () => {
    pepper = process.env.ADDRESS_PEPPER;
    process.env.ADDRESS_PEPPER = "pipeline-test-pepper-0123";
    await migrate(url);
    handle = createDb(url);
    app = new Hono();
    app.route(
      "/",
      createPushRoutes(handle.db, {
        maxWatchesPerDevice: 2,
        watch: async ({ chainId, subject }) => {
          watched.push({ chainId, subject });
          return "watching";
        },
      }),
    );
    app.route(
      "/",
      createInternalRoutes({
        db: handle.db,
        token: TOKEN,
        process: (db, event) => processTxDetectedEvent(db, event, new Date(), senders),
      }),
    );
  });

  after(async () => {
    await handle?.close();
    if (pepper === undefined) delete process.env.ADDRESS_PEPPER;
    else process.env.ADDRESS_PEPPER = pepper;
  });

  const subscribe = (pushToken: string, chainId: string, address: string) =>
    app.request("/v1/devices/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "ios", pushToken, locale: "en", prefs: {}, chainId, address }),
    });
  const txEvent = async (chainId: string, address: string, txHash: string) => {
    const res = await app.request("/internal/tx-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", [INTERNAL_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ chainId, address, txHash }),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as { sent: number; failed: number; coalesced: number; skipped: boolean };
  };

  it("pushes a subscribed iPhone once per transaction, through FCM", async () => {
    const res = await subscribe("ios-fcm-token-0001", "osmosis-1", OSMO);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deviceId: string; realtime: string };
    assert.equal(body.realtime, "watching");
    assert.deepEqual(watched.at(-1), { chainId: "osmosis-1", subject: body.deviceId });

    assert.equal((await txEvent("osmosis-1", OSMO, "1".repeat(64))).sent, 1);
    assert.deepEqual(pushes, [{ token: "ios-fcm-token-0001", chainId: "osmosis-1" }]);
    const again = await txEvent("osmosis-1", OSMO, "1".repeat(64));
    assert.equal(again.sent, 0);
    assert.equal(again.coalesced, 1);
    assert.equal((await txEvent("osmosis-1", HUB, "2".repeat(64))).skipped, true, "nobody watches that wallet");
  });

  it("does not log a failed send, so the redelivered event is pushed", async () => {
    await subscribe("ios-fcm-token-0002", "cosmoshub-4", HUB);
    pushes.length = 0;
    answer = { ok: false, dead: false, reason: "fcm_unavailable" };
    assert.equal((await txEvent("cosmoshub-4", HUB, "3".repeat(64))).failed, 1);
    answer = { ok: true };
    assert.equal((await txEvent("cosmoshub-4", HUB, "3".repeat(64))).sent, 1);
    assert.equal(pushes.length, 2);
  });

  it("drops a device whose token FCM no longer knows", async () => {
    await subscribe("ios-fcm-token-dead", "cosmoshub-4", HUB);
    answer = { ok: false, dead: true, reason: "fcm_unregistered" };
    await txEvent("cosmoshub-4", HUB, "4".repeat(64));
    answer = { ok: true };
    const rows = await handle.db.select().from(devices).where(eq(devices.pushToken, "ios-fcm-token-dead"));
    assert.equal(rows.length, 0);
  });

  it("caps the pairs one device watches, and renews a known pair at the indexer", async () => {
    assert.equal((await subscribe("ios-fcm-token-0003", "osmosis-1", OSMO)).status, 200);
    assert.equal((await subscribe("ios-fcm-token-0003", "cosmoshub-4", HUB)).status, 200);
    const watchesBefore = watched.length;
    assert.equal((await subscribe("ios-fcm-token-0003", "osmosis-1", OSMO)).status, 200, "a known pair is not new");
    assert.equal(watched.length, watchesBefore + 1, "it still renews the indexer's watch");
    const third = await subscribe("ios-fcm-token-0003", "noble-1", "noble1qyqszqgpqyqszqgpqyqszqgpqyqszqgpexample");
    assert.equal(third.status, 429);
  });
});
