import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../app.js";
import type { Db } from "../db/client.js";
import type { TxDetectedEvent } from "../push/consumer.js";
import {
  INTERNAL_TOKEN_HEADER,
  MIN_INTERNAL_TOKEN_LENGTH,
  createInternalRoutes,
  loadInternalEventsToken,
} from "./internal.js";

const TOKEN = "internal-events-token-0123456789abcdef";
const EVENT = {
  chainId: "osmosis-1",
  address: "osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du",
  txHash: "C".repeat(64),
};

/** `null` stands for an unset secret (undefined would take the default). */
function harness(token: string | null = TOKEN) {
  const seen: TxDetectedEvent[] = [];
  const app = createInternalRoutes({
    db: {} as Db,
    token: token ?? undefined,
    process: async (_db, event) => {
      seen.push(event);
      return { skipped: false, sent: 1, failed: 0, coalesced: 0, capped: 0 };
    },
  });
  const post = (headers: Record<string, string>, body: unknown = EVENT) =>
    app.request("/internal/tx-events", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { post, seen };
}

describe("routes/internal: tx events", () => {
  it("refuses a missing or wrong secret", async () => {
    const { post, seen } = harness();
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ [INTERNAL_TOKEN_HEADER]: `${TOKEN}x` })).status, 401);
    assert.equal((await post({ [INTERNAL_TOKEN_HEADER]: "short" })).status, 401);
    assert.equal(seen.length, 0);
  });

  it("runs the fan-out for the right secret", async () => {
    const { post, seen } = harness();
    const res = await post({ [INTERNAL_TOKEN_HEADER]: TOKEN });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, skipped: false, sent: 1, failed: 0, coalesced: 0, capped: 0 });
    assert.deepEqual(seen, [{ ...EVENT, source: "indexer" }]);
  });

  it("does not exist through the public proxy, even with the right secret", async () => {
    const { post, seen } = harness();
    for (const header of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
      const res = await post({ [INTERNAL_TOKEN_HEADER]: TOKEN, [header]: "203.0.113.7" });
      assert.equal(res.status, 404, header);
    }
    assert.equal(seen.length, 0);
  });

  it("stays shut while no secret is configured", async () => {
    const { post } = harness(null);
    assert.equal((await post({ [INTERNAL_TOKEN_HEADER]: TOKEN })).status, 503);
  });

  it("validates the event", async () => {
    const { post, seen } = harness();
    const res = await post({ [INTERNAL_TOKEN_HEADER]: TOKEN }, { ...EVENT, txHash: "not a hash" });
    assert.equal(res.status, 400);
    assert.equal(seen.length, 0);
  });

  it("ignores a secret too short to resist guessing", () => {
    assert.equal(loadInternalEventsToken("x".repeat(MIN_INTERNAL_TOKEN_LENGTH - 1)), undefined);
    assert.equal(loadInternalEventsToken(` ${TOKEN} `), TOKEN);
    assert.equal(loadInternalEventsToken(undefined), undefined);
  });

  it("is outside the anonymous rate limit the public routes share", async () => {
    const app = createApp({ internalEventsToken: TOKEN, corsOrigins: [] });
    let last = 0;
    for (let i = 0; i < 130; i += 1) {
      const res = await app.request("/internal/tx-events", {
        method: "POST",
        headers: { "Content-Type": "application/json", [INTERNAL_TOKEN_HEADER]: TOKEN },
        body: JSON.stringify(EVENT),
      });
      last = res.status;
    }
    // No database in this app: past the limit it still answers 503, never 429.
    assert.equal(last, 503);
  });
});
