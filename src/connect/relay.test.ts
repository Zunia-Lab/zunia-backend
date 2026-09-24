import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { createDb } from "../db/client.js";
import { CLOSE_CODES, ZUNIA_CONNECT_PROTOCOL } from "./protocol.js";
import { PgConnectStore } from "./store.js";
import {
  CIPHERTEXT,
  NONCE,
  PUBLIC_KEY,
  openSocket,
  protocolsFor,
  resetConnectSessionsTable,
  startRelay,
  testDatabaseUrl,
  upgradeStatus,
  type RelayClient,
  type RelayHarness,
} from "./test-support.js";

const DAY_MS = 86_400_000;

describe("connect relay v2", () => {
  let harness: RelayHarness | undefined;
  const clients: RelayClient[] = [];

  async function relay(options: Parameters<typeof startRelay>[0] = {}) {
    harness = await startRelay(options);
    return harness;
  }

  async function open(h: RelayHarness, sid: string, role: string, token: string, autoPong = true) {
    const client = await openSocket(h, sid, role, token, { autoPong });
    clients.push(client);
    return client;
  }

  /** dApp connected and wallet joined through the QR token. */
  async function pairedPeers(h: RelayHarness) {
    const session = await h.createSession();
    const dapp = await open(h, session.sessionId, "dapp", session.dappToken);
    await dapp.next("welcome");
    const wallet = await open(h, session.sessionId, "wallet", session.walletJoinToken);
    const welcome = await wallet.next("welcome");
    await dapp.next("peer");
    return { session, dapp, wallet, resumeToken: welcome.resumeToken! };
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.ws.terminate();
    await harness?.close();
    harness = undefined;
  });

  describe("session creation", () => {
    it("returns separate tokens and records the browser origin", async () => {
      const h = await relay();
      const res = await fetch(`${h.base}/v1/connect/sessions`, {
        method: "POST",
        headers: { Origin: "https://app.example.com" },
      });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example.com");
      const body = (await res.json()) as Awaited<ReturnType<RelayHarness["createSession"]>>;
      assert.equal(body.v, ZUNIA_CONNECT_PROTOCOL);
      assert.match(body.sessionId, /^[A-Za-z0-9_-]{22}$/);
      assert.match(body.dappToken, /^[A-Za-z0-9_-]{43}$/);
      assert.match(body.walletJoinToken, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(body.dappToken, body.walletJoinToken);
      assert.equal(body.verifiedOrigin, "https://app.example.com");
      assert.equal(body.wsUrl, `${h.wsBase}/v1/connect/ws`);
      assert.equal(body.expiresAt, h.clock.now + 600_000);
    });

    it("stores token hashes only", async () => {
      const h = await relay();
      const session = await h.createSession();
      const record = await h.store.get(session.sessionId);
      const sha = (value: string) => createHash("sha256").update(value).digest("hex");
      assert.equal(record?.dappTokenHash, sha(session.dappToken));
      assert.equal(record?.walletJoinTokenHash, sha(session.walletJoinToken));
      const stored = JSON.stringify(record);
      assert.equal(stored.includes(session.dappToken), false);
      assert.equal(stored.includes(session.walletJoinToken), false);
    });

    it("leaves the origin unverified when the header is missing or opaque", async () => {
      const h = await relay();
      assert.equal((await h.createSession({})).verifiedOrigin, null);
      assert.equal((await h.createSession({ Origin: "null" })).verifiedOrigin, null);
      assert.equal((await h.createSession({ Origin: "chrome-extension://abc" })).verifiedOrigin, null);
    });

    it("answers CORS preflights from any dApp origin on connect routes only", async () => {
      const h = await relay();
      const preflight = (path: string) =>
        fetch(`${h.base}${path}`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://any-dapp.example",
            "Access-Control-Request-Method": "POST",
          },
        });
      const connect = await preflight("/v1/connect/sessions");
      assert.equal(connect.headers.get("access-control-allow-origin"), "https://any-dapp.example");
      const other = await preflight("/v1/devices/register");
      assert.equal(other.headers.get("access-control-allow-origin"), null);
    });
  });

  describe("pairing", () => {
    it("pairs a dApp and a wallet and forwards opaque frames both ways", async () => {
      const h = await relay();
      const session = await h.createSession();
      const dapp = await open(h, session.sessionId, "dapp", session.dappToken);
      const dappWelcome = await dapp.next("welcome");
      assert.equal(dappWelcome.role, "dapp");
      assert.equal(dappWelcome.peer, false);
      assert.equal(dappWelcome.paired, false);
      assert.equal(dappWelcome.verifiedOrigin, "https://app.example.com");
      assert.equal(dappWelcome.resumeToken, undefined);

      const wallet = await open(h, session.sessionId, "wallet", session.walletJoinToken);
      const walletWelcome = await wallet.next("welcome");
      assert.equal(walletWelcome.role, "wallet");
      assert.equal(walletWelcome.peer, true);
      assert.equal(walletWelcome.verifiedOrigin, "https://app.example.com");
      assert.match(walletWelcome.resumeToken ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(await dapp.next("peer"), { t: "peer", online: true });

      wallet.send({ t: "hello", pk: PUBLIC_KEY });
      assert.deepEqual(await dapp.next("hello"), { t: "hello", pk: PUBLIC_KEY });

      dapp.send({ t: "msg", n: NONCE, c: CIPHERTEXT });
      assert.deepEqual(await wallet.next("msg"), { t: "msg", n: NONCE, c: CIPHERTEXT });
      wallet.send({ t: "msg", n: NONCE, c: `${CIPHERTEXT}w` });
      assert.deepEqual(await dapp.next("msg"), { t: "msg", n: NONCE, c: `${CIPHERTEXT}w` });
    });

    it("accepts the QR join token once", async () => {
      const h = await relay();
      const { session, wallet } = await pairedPeers(h);
      const second = await open(h, session.sessionId, "wallet", session.walletJoinToken);
      assert.equal((await second.closed).code, CLOSE_CODES.unauthorized);
      await wallet.settle();
    });

    it("lets only the wallet send hello and paired", async () => {
      const h = await relay();
      const { session, dapp, wallet } = await pairedPeers(h);
      dapp.send({ t: "hello", pk: PUBLIC_KEY });
      assert.equal((await dapp.next("error")).code, "FORBIDDEN");
      dapp.send({ t: "paired" });
      assert.equal((await dapp.next("error")).code, "FORBIDDEN");

      wallet.send({ t: "paired" });
      const expected = h.clock.now + DAY_MS;
      assert.deepEqual(await wallet.next("paired"), { t: "paired", expiresAt: expected });
      assert.deepEqual(await dapp.next("paired"), { t: "paired", expiresAt: expected });
      const record = await h.store.get(session.sessionId);
      assert.equal(record?.paired, true);
      assert.equal(record?.expiresAt, expected);

      h.clock.now += 5_000;
      wallet.send({ t: "paired" });
      assert.equal((await wallet.next("paired")).expiresAt, expected);

      wallet.send({ t: "hello", pk: PUBLIC_KEY });
      const locked = await wallet.next("error");
      assert.equal(locked.code, "FORBIDDEN");
      assert.equal(locked.message, "Pairing is locked");
    });

    it("rejects malformed frames and keeps the socket open", async () => {
      const h = await relay();
      const { dapp } = await pairedPeers(h);
      for (const frame of [
        "not json",
        { t: "nope" },
        { t: "msg", n: NONCE, c: CIPHERTEXT, extra: 1 },
        { t: "msg", n: "short", c: CIPHERTEXT },
        { t: "msg", n: NONCE, c: "too-short" },
        { t: "hello", pk: "x" },
      ]) {
        dapp.send(frame);
        assert.equal((await dapp.next("error")).code, "BAD_FRAME");
      }
      dapp.ws.send(Buffer.from([1, 2, 3]));
      assert.equal((await dapp.next("error")).code, "BAD_FRAME");
      await dapp.settle();
    });
  });

  describe("admission", () => {
    it("refuses wrong tokens and swapped roles", async () => {
      const h = await relay();
      const session = await h.createSession();
      const attempts: Array<[string, string]> = [
        ["dapp", session.walletJoinToken],
        ["wallet", session.dappToken],
        ["dapp", "x".repeat(43)],
      ];
      for (const [role, token] of attempts) {
        const client = await open(h, session.sessionId, role, token);
        assert.equal((await client.closed).code, CLOSE_CODES.unauthorized);
      }
      const unknown = await open(h, "Q".repeat(22), "dapp", session.dappToken);
      assert.equal((await unknown.closed).code, CLOSE_CODES.unauthorized);

      const wallet = await open(h, session.sessionId, "wallet", session.walletJoinToken);
      assert.equal((await wallet.next("welcome")).role, "wallet");
    });

    it("refuses malformed upgrades before the handshake", async () => {
      const h = await relay();
      const session = await h.createSession();
      const sid = session.sessionId;
      const token = protocolsFor(session.dappToken);
      assert.equal(await upgradeStatus(h, `/v1/connect/ws?sid=${sid}&role=dapp`, ["zunia.connect.v2"]), 400);
      assert.equal(await upgradeStatus(h, `/v1/connect/ws?sid=bad&role=dapp`, token), 400);
      assert.equal(await upgradeStatus(h, `/v1/connect/ws?sid=${sid}&role=admin`, token), 400);
      assert.equal(await upgradeStatus(h, `/v1/other?sid=${sid}&role=dapp`, token), 404);
      assert.equal(await upgradeStatus(h, `/v1/connect/ws?sid=${sid}&role=dapp`, token), 101);
    });

    it("never echoes the token subprotocol", async () => {
      const h = await relay();
      const session = await h.createSession();
      const dapp = await open(h, session.sessionId, "dapp", session.dappToken);
      assert.equal(dapp.ws.protocol, ZUNIA_CONNECT_PROTOCOL);
    });
  });

  describe("reconnect", () => {
    it("resumes the wallet with its resume token and replaces the old socket", async () => {
      const h = await relay();
      const { session, dapp, wallet, resumeToken } = await pairedPeers(h);
      const resumed = await open(h, session.sessionId, "wallet", resumeToken);
      const welcome = await resumed.next("welcome");
      assert.equal(welcome.resumeToken, undefined);
      assert.equal(welcome.peer, true);
      assert.equal((await wallet.closed).code, CLOSE_CODES.replaced);

      await dapp.settle();
      assert.equal(dapp.unread().some((frame) => frame.t === "peer"), false);
      dapp.send({ t: "msg", n: NONCE, c: CIPHERTEXT });
      assert.equal((await resumed.next("msg")).c, CIPHERTEXT);

      const reuse = await open(h, session.sessionId, "wallet", session.walletJoinToken);
      assert.equal((await reuse.closed).code, CLOSE_CODES.unauthorized);
    });

    it("reconnects the dApp with its token", async () => {
      const h = await relay();
      const { session, dapp, wallet } = await pairedPeers(h);
      const again = await open(h, session.sessionId, "dapp", session.dappToken);
      assert.equal((await again.next("welcome")).peer, true);
      assert.equal((await dapp.closed).code, CLOSE_CODES.replaced);
      wallet.send({ t: "msg", n: NONCE, c: CIPHERTEXT });
      assert.equal((await again.next("msg")).c, CIPHERTEXT);
    });

    it("queues frames for an offline peer and delivers them in order on resume", async () => {
      const h = await relay();
      const { session, dapp, wallet, resumeToken } = await pairedPeers(h);
      wallet.close();
      assert.deepEqual(await dapp.next("peer"), { t: "peer", online: false });
      dapp.send({ t: "msg", n: NONCE, c: `${CIPHERTEXT}1` });
      dapp.send({ t: "msg", n: NONCE, c: `${CIPHERTEXT}2` });
      await dapp.settle();

      const resumed = await open(h, session.sessionId, "wallet", resumeToken);
      await resumed.next("welcome");
      assert.equal((await resumed.next("msg")).c, `${CIPHERTEXT}1`);
      assert.equal((await resumed.next("msg")).c, `${CIPHERTEXT}2`);
    });

    it("bounds the queue and drops stale frames", async () => {
      const h = await relay({ config: { queueMaxFrames: 2, queueTtlMs: 1_000 } });
      const session = await h.createSession();
      const dapp = await open(h, session.sessionId, "dapp", session.dappToken);
      await dapp.next("welcome");
      dapp.send({ t: "msg", n: NONCE, c: `${CIPHERTEXT}1` });
      dapp.send({ t: "msg", n: NONCE, c: `${CIPHERTEXT}2` });
      dapp.send({ t: "msg", n: NONCE, c: `${CIPHERTEXT}3` });
      assert.equal((await dapp.next("error")).code, "QUEUE_FULL");

      h.clock.now += 1_000;
      const wallet = await open(h, session.sessionId, "wallet", session.walletJoinToken);
      await wallet.next("welcome");
      await wallet.settle();
      assert.equal(wallet.unread().some((frame) => frame.t === "msg"), false);
    });
  });

  describe("ending", () => {
    it("ends the session when either side sends close", async () => {
      const h = await relay();
      const { session, dapp, wallet } = await pairedPeers(h);
      wallet.send({ t: "close", reason: "user" });
      assert.deepEqual(await dapp.next("closed"), { t: "closed", reason: "closed" });
      assert.deepEqual(await wallet.next("closed"), { t: "closed", reason: "closed" });
      assert.equal((await dapp.closed).code, CLOSE_CODES.ended);
      assert.equal(await h.store.get(session.sessionId), null);
      const back = await open(h, session.sessionId, "dapp", session.dappToken);
      assert.equal((await back.closed).code, CLOSE_CODES.unauthorized);
    });

    it("reports status and deletes over HTTP with a session token", async () => {
      const h = await relay();
      const { session, dapp, resumeToken } = await pairedPeers(h);
      const url = `${h.base}/v1/connect/sessions/${session.sessionId}`;
      const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

      const status = await fetch(url, { headers: auth(session.dappToken) });
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), {
        v: ZUNIA_CONNECT_PROTOCOL,
        sessionId: session.sessionId,
        role: "dapp",
        verifiedOrigin: "https://app.example.com",
        paired: false,
        peerOnline: true,
        expiresAt: session.expiresAt,
      });
      const walletStatus = (await (await fetch(url, { headers: auth(resumeToken) })).json()) as {
        role: string;
      };
      assert.equal(walletStatus.role, "wallet");

      assert.equal((await fetch(url, { method: "DELETE" })).status, 401);
      assert.equal((await fetch(url, { method: "DELETE", headers: auth("x".repeat(43)) })).status, 401);
      assert.equal(
        (await fetch(url, { method: "DELETE", headers: auth(session.walletJoinToken) })).status,
        401,
      );
      assert.equal((await fetch(url, { method: "DELETE", headers: auth(session.dappToken) })).status, 204);
      assert.deepEqual(await dapp.next("closed"), { t: "closed", reason: "deleted" });
      assert.equal((await fetch(url, { headers: auth(session.dappToken) })).status, 401);
    });

    it("expires unpaired sessions and keeps paired ones", async () => {
      const h = await relay({ config: { unpairedTtlSeconds: 60 } });
      const lonely = await h.createSession();
      const waiting = await open(h, lonely.sessionId, "dapp", lonely.dappToken);
      await waiting.next("welcome");
      const { dapp, wallet } = await pairedPeers(h);
      wallet.send({ t: "paired" });
      await dapp.next("paired");

      h.clock.now += 61_000;
      await h.relay.sweep();
      assert.deepEqual(await waiting.next("closed"), { t: "closed", reason: "expired" });
      assert.equal((await waiting.closed).code, CLOSE_CODES.ended);
      assert.equal(await h.store.get(lonely.sessionId), null);
      const late = await open(h, lonely.sessionId, "wallet", lonely.walletJoinToken);
      assert.equal((await late.closed).code, CLOSE_CODES.unauthorized);
      await dapp.settle();
    });
  });

  describe("limits", () => {
    it("limits session creation per client address", async () => {
      const h = await relay({ config: { createLimit: 2 }, proxyTrust: { mode: "hops", hops: 1 } });
      const post = (forwardedFor: string) =>
        fetch(`${h.base}/v1/connect/sessions`, {
          method: "POST",
          headers: { "X-Forwarded-For": forwardedFor },
        });
      assert.equal((await post("1.1.1.1, 203.0.113.9")).status, 201);
      assert.equal((await post("2.2.2.2, 203.0.113.9")).status, 201);
      const limited = await post("3.3.3.3, 203.0.113.9");
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
      assert.equal((await post("203.0.113.10")).status, 201);
    });

    it("caps live sessions", async () => {
      const h = await relay({ config: { maxSessions: 2 } });
      await h.createSession();
      await h.createSession();
      const res = await fetch(`${h.base}/v1/connect/sessions`, { method: "POST" });
      assert.equal(res.status, 503);
    });

    it("limits upgrade attempts per client address", async () => {
      const h = await relay({ config: { upgradeLimit: 2 } });
      const session = await h.createSession();
      const path = `/v1/connect/ws?sid=${session.sessionId}&role=dapp`;
      const protocols = protocolsFor(session.dappToken);
      assert.equal(await upgradeStatus(h, path, protocols), 101);
      assert.equal(await upgradeStatus(h, path, protocols), 101);
      assert.equal(await upgradeStatus(h, path, protocols), 429);
    });

    it("closes sockets that send too many frames", async () => {
      const h = await relay({ config: { socketFrameLimit: 5 } });
      const { dapp } = await pairedPeers(h);
      for (let i = 0; i < 8; i += 1) dapp.send({ t: "ping" });
      assert.equal((await dapp.closed).code, CLOSE_CODES.rateLimited);
    });

    it("closes sockets that send oversized frames", async () => {
      const h = await relay({ config: { maxPayloadBytes: 1024 } });
      const { dapp } = await pairedPeers(h);
      dapp.send({ t: "msg", n: NONCE, c: "c".repeat(2048) });
      assert.equal((await dapp.closed).code, 1009);
    });

    it("drops sockets that miss a heartbeat", async () => {
      const h = await relay({ config: { heartbeatMs: 40 } });
      const session = await h.createSession();
      const silent = await open(h, session.sessionId, "dapp", session.dappToken, false);
      await silent.next("welcome");
      assert.equal((await silent.closed).code, 1006);
    });
  });
});

const relayDatabaseUrl = testDatabaseUrl("connect_relay_test");

describe("connect relay v2 with postgres", { skip: !relayDatabaseUrl && "TEST_DATABASE_URL unset" }, () => {
  const databaseUrl = relayDatabaseUrl!;

  before(async () => {
    await resetConnectSessionsTable(databaseUrl);
  });

  it("keeps a session across a relay restart", async () => {
    const firstDb = createDb(databaseUrl);
    const first = await startRelay({ store: new PgConnectStore(firstDb.db) });
    const session = await first.createSession();
    await first.close();
    await firstDb.close();

    const secondDb = createDb(databaseUrl);
    const second = await startRelay({ store: new PgConnectStore(secondDb.db) });
    try {
      const wallet = await openSocket(second, session.sessionId, "wallet", session.walletJoinToken);
      const welcome = await wallet.next("welcome");
      assert.equal(welcome.verifiedOrigin, "https://app.example.com");
      assert.match(welcome.resumeToken ?? "", /^[A-Za-z0-9_-]{43}$/);
      wallet.ws.terminate();
    } finally {
      await second.close();
      await secondDb.close();
    }
  });

  after(async () => {
    const handle = createDb(databaseUrl);
    await handle.client.unsafe('TRUNCATE "connect_sessions"');
    await handle.close();
  });
});
