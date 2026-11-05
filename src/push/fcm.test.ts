import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  FCM_SCOPE,
  FcmAccessTokens,
  FcmSender,
  buildFcmMessage,
  classifyFcmError,
  fcmSenderFromEnv,
  parseServiceAccount,
  resetFcmSenderFromEnv,
  sendFcmHttpV1,
  signAssertion,
  type FcmServiceAccount,
} from "./fcm.js";
import type { WakeUpPayload } from "./types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const ACCOUNT: FcmServiceAccount = {
  projectId: "zunia-test",
  clientEmail: "push-sender@zunia-test.iam.gserviceaccount.com",
  privateKey: PRIVATE_PEM,
  privateKeyId: "key-1",
  tokenUri: "https://oauth2.example.test/token",
};

const PAYLOAD: WakeUpPayload = {
  event: "tx_update",
  chainId: "osmosis-1",
  txHash: "A".repeat(64),
};

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch that answers from a script and records every call. */
function scriptedFetch(answers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call to ${call.url}`);
    return next(call);
  }) as typeof fetch;
  return { impl, calls };
}

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("push/fcm: service account", () => {
  it("reads the fields FCM needs, with FCM_PROJECT_ID overriding the file", () => {
    const raw = JSON.stringify({
      type: "service_account",
      project_id: "from-file",
      client_email: ACCOUNT.clientEmail,
      private_key: PRIVATE_PEM,
      private_key_id: "key-1",
    });
    const parsed = parseServiceAccount(raw);
    assert.equal(parsed.projectId, "from-file");
    assert.equal(parsed.tokenUri, "https://oauth2.googleapis.com/token");
    assert.equal(parseServiceAccount(raw, "override").projectId, "override");
  });

  it("refuses an incomplete key and never quotes the file in the error", () => {
    assert.throws(() => parseServiceAccount(JSON.stringify({ type: "service_account" })), /client_email/);
    assert.throws(
      () => parseServiceAccount("not json -----BEGIN PRIVATE KEY----- secret"),
      (err: unknown) => err instanceof Error && !err.message.includes("secret"),
    );
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ type: "authorized_user" })),
      /service_account/,
    );
  });
});

describe("push/fcm: OAuth2 assertion", () => {
  it("is an RS256 JWT for the messaging scope, signed by the service account", () => {
    const jwt = signAssertion(ACCOUNT, 1_800_000_000);
    const [header, claims, signature] = jwt.split(".");
    assert.deepEqual(decodePart(header), { alg: "RS256", typ: "JWT", kid: "key-1" });
    assert.deepEqual(decodePart(claims), {
      iss: ACCOUNT.clientEmail,
      scope: FCM_SCOPE,
      aud: ACCOUNT.tokenUri,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    assert.equal(verifier.verify(publicKey, Buffer.from(signature ?? "", "base64url")), true);
  });
});

describe("push/fcm: access tokens", () => {
  it("exchanges the assertion once and reuses the token until five minutes before expiry", async () => {
    let now = Date.parse("2026-11-05T10:00:00Z");
    const { impl, calls } = scriptedFetch([
      () => json(200, { access_token: "token-1", expires_in: 3600 }),
      () => json(200, { access_token: "token-2", expires_in: 3600 }),
    ]);
    const tokens = new FcmAccessTokens(ACCOUNT, impl, () => now);

    assert.equal(await tokens.get(), "token-1");
    now += 54 * 60_000;
    assert.equal(await tokens.get(), "token-1", "still fresh 54 minutes in");
    assert.equal(calls.length, 1);

    const form = new URLSearchParams(String(calls[0]?.init.body));
    assert.equal(calls[0]?.url, ACCOUNT.tokenUri);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.equal(form.get("assertion")?.split(".").length, 3);

    now += 2 * 60_000; // 56 minutes: inside the five-minute margin
    assert.equal(await tokens.get(), "token-2");
    assert.equal(calls.length, 2);
  });

  it("shares one exchange between concurrent sends", async () => {
    const { impl, calls } = scriptedFetch([() => json(200, { access_token: "shared", expires_in: 3600 })]);
    const tokens = new FcmAccessTokens(ACCOUNT, impl);
    const got = await Promise.all([tokens.get(), tokens.get(), tokens.get()]);
    assert.deepEqual(got, ["shared", "shared", "shared"]);
    assert.equal(calls.length, 1);
  });
});

describe("push/fcm: message", () => {
  it("carries the fixed text and the wake-up fields, nothing else", () => {
    assert.deepEqual(buildFcmMessage("device-token", PAYLOAD), {
      message: {
        token: "device-token",
        notification: { title: "Zunia", body: "New activity in your wallet" },
        data: { event: "tx_update", chainId: "osmosis-1", txHash: "A".repeat(64) },
        android: { priority: "HIGH", notification: { channel_id: "zunia_activity" } },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
      },
    });
  });
});

describe("push/fcm: sending", () => {
  it("posts to the project's messages:send with the bearer token", async () => {
    const { impl, calls } = scriptedFetch([
      () => json(200, { access_token: "token-1", expires_in: 3600 }),
      () => json(200, { name: "projects/zunia-test/messages/1" }),
    ]);
    const result = await new FcmSender(ACCOUNT, impl).send("device-token", PAYLOAD);
    assert.deepEqual(result, { ok: true });
    assert.equal(calls[1]?.url, "https://fcm.googleapis.com/v1/projects/zunia-test/messages:send");
    const headers = calls[1]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer token-1");
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), buildFcmMessage("device-token", PAYLOAD));
  });

  it("retries once with a new token after a 401", async () => {
    const { impl, calls } = scriptedFetch([
      () => json(200, { access_token: "stale", expires_in: 3600 }),
      () => json(401, { error: { status: "UNAUTHENTICATED" } }),
      () => json(200, { access_token: "fresh", expires_in: 3600 }),
      () => json(200, {}),
    ]);
    const result = await new FcmSender(ACCOUNT, impl).send("device-token", PAYLOAD);
    assert.deepEqual(result, { ok: true });
    assert.equal((calls[3]?.init.headers as Record<string, string>).Authorization, "Bearer fresh");
  });

  it("marks a token FCM no longer knows as dead, and keeps it after an outage", async () => {
    const unregistered = scriptedFetch([
      () => json(200, { access_token: "t", expires_in: 3600 }),
      () =>
        json(404, {
          error: {
            status: "NOT_FOUND",
            details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "UNREGISTERED" }],
          },
        }),
    ]);
    assert.deepEqual(await new FcmSender(ACCOUNT, unregistered.impl).send("old", PAYLOAD), {
      ok: false,
      dead: true,
      reason: "fcm_unregistered",
    });

    const outage = scriptedFetch([
      () => json(200, { access_token: "t", expires_in: 3600 }),
      () => json(503, { error: { status: "UNAVAILABLE" } }),
    ]);
    assert.deepEqual(await new FcmSender(ACCOUNT, outage.impl).send("live", PAYLOAD), {
      ok: false,
      dead: false,
      reason: "fcm_unavailable",
    });
  });

  it("classifies FCM's refusals", () => {
    assert.deepEqual(
      classifyFcmError(400, {
        errorCode: "INVALID_ARGUMENT",
        message: "The registration token is not a valid FCM registration token",
      }),
      { ok: false, dead: true, reason: "fcm_invalid_token" },
    );
    // A malformed message of ours is not the device's fault.
    assert.deepEqual(classifyFcmError(400, { errorCode: "INVALID_ARGUMENT", message: "Invalid JSON payload" }), {
      ok: false,
      dead: false,
      reason: "fcm_invalid_argument",
    });
    assert.deepEqual(classifyFcmError(403, { errorCode: "SENDER_ID_MISMATCH" }), {
      ok: false,
      dead: true,
      reason: "fcm_sender_id_mismatch",
    });
  });

  it("reports an unreachable token endpoint as a failure", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.deepEqual(await new FcmSender(ACCOUNT, impl).send("device-token", PAYLOAD), {
      ok: false,
      dead: false,
      reason: "fcm_auth",
    });
  });
});

describe("push/fcm: not configured", () => {
  afterEach(() => resetFcmSenderFromEnv());

  it("is a failure, never a send", async () => {
    assert.deepEqual(await sendFcmHttpV1({ deviceToken: "device-token", payload: PAYLOAD, sender: null }), {
      ok: false,
      dead: false,
      reason: "fcm_not_configured",
    });
  });

  it("has no sender without FCM_SERVICE_ACCOUNT_PATH, or with an unreadable file", async () => {
    assert.equal(await fcmSenderFromEnv({}), null);
    resetFcmSenderFromEnv();
    assert.equal(await fcmSenderFromEnv({ FCM_SERVICE_ACCOUNT_PATH: "/nonexistent/fcm.json" }), null);
  });
});
