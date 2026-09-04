import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addressWatchInsertPayload,
  assertNoPlaintextAddress,
  hashAddress,
  normalizeAddress,
  PrivacyError,
} from "./hash.js";

describe("privacy/hash", () => {
  const pepper = "test-pepper-at-least-16-chars";
  const address = "cosmos1abcdefghijklmnopqrstuvwxyz0123456789";

  it("hashes deterministically with pepper", () => {
    const a = hashAddress(address, pepper);
    const b = hashAddress(address.toUpperCase(), pepper);
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.notEqual(a, normalizeAddress(address));
  });

  it("changes when pepper changes", () => {
    const a = hashAddress(address, pepper);
    const b = hashAddress(address, pepper + "-other");
    assert.notEqual(a, b);
  });

  it("addressWatchInsertPayload never contains plaintext address", () => {
    const payload = addressWatchInsertPayload({
      deviceId: "00000000-0000-0000-0000-000000000001",
      chainId: "cosmoshub-4",
      address,
      pepper,
    });

    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(address), false);
    assert.equal(serialized.includes(normalizeAddress(address)), false);
    assert.equal(serialized.includes("cosmos1"), false);
    assert.ok(payload.addressHash);
    assert.equal(payload.addressHash, hashAddress(address, pepper));
    assert.equal("address" in payload, false);
  });

  it("assertNoPlaintextAddress throws when address sneaks into payload", () => {
    assert.throws(
      () =>
        assertNoPlaintextAddress(
          { deviceId: "x", chainId: "c", addressHash: normalizeAddress(address) },
          address,
        ),
      PrivacyError,
    );
  });

  it("refuses forbidden plaintext column names", () => {
    assert.throws(
      () => assertNoPlaintextAddress({ address: "something-else" }, "other"),
      /forbidden plaintext address column/,
    );
  });
});
