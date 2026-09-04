import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import {
  addressWatches,
  deadTokens,
  devices,
  notificationLog,
} from "./schema.js";

describe("db/schema", () => {
  it("defines required tables", () => {
    assert.equal(getTableName(devices), "devices");
    assert.equal(getTableName(addressWatches), "address_watches");
    assert.equal(getTableName(notificationLog), "notification_log");
    assert.equal(getTableName(deadTokens), "dead_tokens");
  });

  it("address_watches stores hash only (no address column)", () => {
    const cols = Object.keys(getTableColumns(addressWatches));
    assert.ok(cols.includes("addressHash"));
    assert.equal(cols.includes("address"), false);
    assert.equal(cols.includes("walletAddress"), false);
  });

  it("notification_log has idempotencyKey", () => {
    const cols = getTableColumns(notificationLog);
    assert.ok(cols.idempotencyKey);
  });

  it("dead_tokens has expiresAt for 30-day retention job", () => {
    const cols = getTableColumns(deadTokens);
    assert.ok(cols.expiresAt);
    assert.ok(cols.pushToken);
  });
});
