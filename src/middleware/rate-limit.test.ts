import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRateLimitStore } from "./rate-limit.js";

describe("rate-limit MemoryRateLimitStore", () => {
  it("allows up to max within window", async () => {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 3; i++) {
      const r = await store.hit("k", 60_000, 3);
      assert.equal(r.allowed, true);
    }
    const blocked = await store.hit("k", 60_000, 3);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
  });

  it("isolates keys", async () => {
    const store = new MemoryRateLimitStore();
    await store.hit("a", 60_000, 1);
    const b = await store.hit("b", 60_000, 1);
    assert.equal(b.allowed, true);
  });
});
