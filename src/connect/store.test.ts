import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDb } from "../db/client.js";
import {
  MemoryConnectStore,
  PgConnectStore,
  type ConnectSessionRecord,
  type ConnectStore,
} from "./store.js";
import { resetConnectSessionsTable, testDatabaseUrl } from "./test-support.js";

/** Set TEST_DATABASE_URL to a disposable database to run the Postgres cases. */
const databaseUrl = testDatabaseUrl("connect_store_test");

function record(id: string, overrides: Partial<ConnectSessionRecord> = {}): ConnectSessionRecord {
  return {
    id,
    dappTokenHash: "d".repeat(64),
    walletJoinTokenHash: "j".repeat(64),
    walletResumeTokenHash: null,
    verifiedOrigin: "https://app.example.com",
    paired: false,
    expiresAt: 2_000_000_000_000,
    createdAt: 1_900_000_000_000,
    ...overrides,
  };
}

function storeContract(name: string, makeStore: () => Promise<ConnectStore>) {
  describe(`connect store contract: ${name}`, () => {
    it("round-trips a record and misses unknown ids", async () => {
      const store = await makeStore();
      await store.insert(record("A".repeat(22)));
      assert.deepEqual(await store.get("A".repeat(22)), record("A".repeat(22)));
      assert.equal(await store.get("B".repeat(22)), null);
      await assert.rejects(store.insert(record("A".repeat(22))));
    });

    it("consumes the join token once", async () => {
      const store = await makeStore();
      await store.insert(record("C".repeat(22)));
      assert.equal(await store.consumeJoin("C".repeat(22), "r".repeat(64)), true);
      assert.equal(await store.consumeJoin("C".repeat(22), "s".repeat(64)), false);
      const after = await store.get("C".repeat(22));
      assert.equal(after?.walletJoinTokenHash, null);
      assert.equal(after?.walletResumeTokenHash, "r".repeat(64));
      assert.equal(await store.consumeJoin("Z".repeat(22), "r".repeat(64)), false);
    });

    it("lets exactly one of two concurrent joins win", async () => {
      const store = await makeStore();
      await store.insert(record("D".repeat(22)));
      const results = await Promise.all([
        store.consumeJoin("D".repeat(22), "1".repeat(64)),
        store.consumeJoin("D".repeat(22), "2".repeat(64)),
      ]);
      assert.deepEqual(results.filter(Boolean).length, 1);
    });

    it("marks pairing with the new expiry", async () => {
      const store = await makeStore();
      await store.insert(record("E".repeat(22)));
      await store.markPaired("E".repeat(22), 2_100_000_000_000);
      const paired = await store.get("E".repeat(22));
      assert.equal(paired?.paired, true);
      assert.equal(paired?.expiresAt, 2_100_000_000_000);
    });

    it("counts live sessions and removes expired ones", async () => {
      const store = await makeStore();
      await store.insert(record("F".repeat(22), { expiresAt: 1_000 }));
      await store.insert(record("G".repeat(22), { expiresAt: 5_000 }));
      await store.insert(record("H".repeat(22), { expiresAt: 9_000 }));
      assert.equal(await store.countLive(4_000), 2);
      assert.deepEqual((await store.removeExpired(5_000)).sort(), ["F".repeat(22), "G".repeat(22)]);
      assert.equal(await store.get("G".repeat(22)), null);
      await store.remove("H".repeat(22));
      assert.equal(await store.get("H".repeat(22)), null);
    });
  });
}

storeContract("memory", async () => new MemoryConnectStore());

describe("connect store contract: postgres", { skip: !databaseUrl && "TEST_DATABASE_URL unset" }, () => {
  let handle: ReturnType<typeof createDb> | undefined;

  before(async () => {
    await resetConnectSessionsTable(databaseUrl!);
    handle = createDb(databaseUrl!);
  });

  after(async () => {
    await handle?.close();
  });

  storeContract("postgres", async () => {
    await handle!.client.unsafe('TRUNCATE "connect_sessions"');
    return new PgConnectStore(handle!.db);
  });
});
