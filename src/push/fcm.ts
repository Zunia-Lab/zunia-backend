import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PushSendResult, WakeUpPayload } from "./types.js";
import { NOTIFICATION_CONFIG } from "../../config/notifications.js";
import { PRIVACY_CONFIG } from "../../config/privacy.js";

/**
 * FCM HTTP v1 sender, for Android and iOS alike: the app registers through
 * firebase_messaging on both, so an iPhone hands us an FCM token too, and FCM
 * reaches APNs with the key uploaded to the Firebase project.
 *
 * Auth is the OAuth2 JWT-bearer grant (RFC 7523) of a service account key
 * file (FCM_SERVICE_ACCOUNT_PATH): an RS256 assertion signed here with
 * node:crypto, exchanged at the key's token_uri for an access token that is
 * reused until five minutes before it expires. The legacy server key is
 * deprecated and never used.
 */

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const FCM_API = "https://fcm.googleapis.com/v1/projects";
/** A token is replaced this long before the expiry Google stated. */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** Lifetime asked for in the assertion; Google caps access tokens at one hour. */
const ASSERTION_LIFETIME_SEC = 3600;

/** What the sender reads from a service account key file. */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  tokenUri: string;
}

/** Raised when no access token can be had; never carries key material. */
export class FcmAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FcmAuthError";
  }
}

/**
 * The fields FCM needs from a key file's JSON. Throws on anything missing.
 * Error messages never quote the file: it holds a private key.
 */
export function parseServiceAccount(raw: string, projectIdOverride?: string): FcmServiceAccount {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("service account file is not JSON");
  }
  const field = (key: string): string | undefined => {
    const value = json[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const type = field("type");
  if (type !== undefined && type !== "service_account") {
    throw new Error(`expected a service_account key, got "${type}"`);
  }
  const clientEmail = field("client_email");
  const privateKey = field("private_key");
  const projectId = projectIdOverride?.trim() || field("project_id");
  if (!clientEmail || !privateKey || !projectId) {
    throw new Error("service account needs client_email, private_key and project_id");
  }
  return {
    projectId,
    clientEmail,
    privateKey,
    privateKeyId: field("private_key_id"),
    tokenUri: field("token_uri") ?? DEFAULT_TOKEN_URI,
  };
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/** The RS256 assertion exchanged for an access token. */
export function signAssertion(account: FcmServiceAccount, nowSec: number): string {
  const header = base64url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      ...(account.privateKeyId ? { kid: account.privateKeyId } : {}),
    }),
  );
  const claims = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: account.tokenUri,
      iat: nowSec,
      exp: nowSec + ASSERTION_LIFETIME_SEC,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(account.privateKey).toString("base64url")}`;
}

/** One service account's access token, minted on demand and reused while it is fresh. */
export class FcmAccessTokens {
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly account: FcmServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached token, or a new one when it is near expiry or `refresh` is set (after a 401). */
  async get(refresh = false): Promise<string> {
    if (refresh) {
      this.cached = undefined;
    } else if (this.cached && this.now() < this.cached.expiresAt - EXPIRY_MARGIN_MS) {
      return this.cached.token;
    }
    // Concurrent sends share one exchange.
    this.pending ??= this.mint().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async mint(): Promise<string> {
    const issuedAt = this.now();
    const assertion = signAssertion(this.account, Math.floor(issuedAt / 1000));
    let res: Response;
    try {
      res = await this.fetchImpl(this.account.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
    } catch {
      throw new FcmAuthError("token endpoint unreachable");
    }
    if (!res.ok) {
      throw new FcmAuthError(`token exchange failed with ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new FcmAuthError("token exchange returned no access_token");
    }
    const lifetimeSec =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : ASSERTION_LIFETIME_SEC;
    this.cached = { token: body.access_token, expiresAt: issuedAt + lifetimeSec * 1000 };
    return body.access_token;
  }
}

/**
 * The message for one device: the fixed text of NOTIFICATION_CONFIG.push, so
 * a killed app still shows something, and the wake-up fields as data for the
 * app to fetch the detail itself. No amount, no address (config/privacy.ts).
 */
export function buildFcmMessage(deviceToken: string, payload: WakeUpPayload) {
  const { title, body, androidChannelId } = NOTIFICATION_CONFIG.push;
  return {
    message: {
      token: deviceToken,
      notification: { title, body },
      data: {
        event: payload.event,
        chainId: payload.chainId,
        txHash: payload.txHash,
      },
      android: {
        priority: "HIGH",
        notification: { channel_id: androidChannelId },
      },
      apns: {
        headers: { "apns-priority": "10" },
        payload: { aps: { sound: "default" } },
      },
    },
  };
}

/**
 * FCM's refusal as a send result. A token FCM no longer knows (404 or
 * UNREGISTERED), one from another Firebase project, or one it cannot parse is
 * dead and gets removed; anything else may pass and is retried with the next event.
 */
export function classifyFcmError(
  status: number,
  error: { errorCode?: string; message?: string },
): PushSendResult {
  const code = error.errorCode;
  if (status === 404 || code === "UNREGISTERED") {
    return { ok: false, dead: true, reason: "fcm_unregistered" };
  }
  if (code === "SENDER_ID_MISMATCH") {
    return { ok: false, dead: true, reason: "fcm_sender_id_mismatch" };
  }
  if (status === 400 && code === "INVALID_ARGUMENT" && /registration token/i.test(error.message ?? "")) {
    return { ok: false, dead: true, reason: "fcm_invalid_token" };
  }
  return { ok: false, dead: false, reason: `fcm_${code ? code.toLowerCase() : status}` };
}

async function readFcmError(res: Response): Promise<{ errorCode?: string; message?: string }> {
  try {
    const json = (await res.json()) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ errorCode?: unknown }>;
      };
    };
    const detail = json.error?.details?.find((d) => typeof d?.errorCode === "string");
    return {
      errorCode: (detail?.errorCode as string | undefined) ?? json.error?.status,
      message: json.error?.message,
    };
  } catch {
    return {};
  }
}

/** Sends through one Firebase project, retrying once with a fresh token after a 401. */
export class FcmSender {
  constructor(
    readonly account: FcmServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly tokens: FcmAccessTokens = new FcmAccessTokens(account, fetchImpl),
  ) {}

  async send(deviceToken: string, payload: WakeUpPayload): Promise<PushSendResult> {
    const url = `${FCM_API}/${encodeURIComponent(this.account.projectId)}/messages:send`;
    const body = JSON.stringify(buildFcmMessage(deviceToken, payload));
    let res: Response;
    try {
      res = await this.post(url, body, await this.tokens.get());
      if (res.status === 401) {
        res = await this.post(url, body, await this.tokens.get(true));
      }
    } catch (err) {
      return {
        ok: false,
        dead: false,
        reason: err instanceof FcmAuthError ? "fcm_auth" : "fcm_unreachable",
      };
    }
    if (res.ok) return { ok: true };
    return classifyFcmError(res.status, await readFcmError(res));
  }

  private post(url: string, body: string, accessToken: string): Promise<Response> {
    return this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body,
    });
  }
}

let fromEnv: Promise<FcmSender | null> | undefined;

/**
 * The sender for FCM_SERVICE_ACCOUNT_PATH (FCM_PROJECT_ID overrides the
 * file's project), read once per process. Null when unset or unusable, which
 * is logged once: sends then fail as `fcm_not_configured`, never as sent.
 */
export function fcmSenderFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<FcmSender | null> {
  fromEnv ??= (async () => {
    const path = env.FCM_SERVICE_ACCOUNT_PATH?.trim();
    if (!path) {
      console.warn("[fcm] FCM_SERVICE_ACCOUNT_PATH unset: mobile push is off");
      return null;
    }
    try {
      const account = parseServiceAccount(await readFile(path, "utf8"), env.FCM_PROJECT_ID);
      console.log(`[fcm] project ${account.projectId}`);
      return new FcmSender(account);
    } catch (err) {
      console.error("[fcm] service account unusable:", err instanceof Error ? err.message : "unknown error");
      return null;
    }
  })();
  return fromEnv;
}

/** Tests only: forget the sender read from the environment. */
export function resetFcmSenderFromEnv(): void {
  fromEnv = undefined;
}

/**
 * One device's push. `sender` defaults to the environment's; pass `null` to
 * check the unconfigured path. Not configured is a failure, not a dry run.
 */
export async function sendFcmHttpV1(input: {
  deviceToken: string;
  payload: WakeUpPayload;
  sender?: FcmSender | null;
}): Promise<PushSendResult> {
  assertWakeUpOnly(input.payload);
  const sender = input.sender === undefined ? await fcmSenderFromEnv() : input.sender;
  if (!sender) {
    return { ok: false, dead: false, reason: "fcm_not_configured" };
  }
  return sender.send(input.deviceToken, input.payload);
}

function assertWakeUpOnly(payload: WakeUpPayload): void {
  if (PRIVACY_CONFIG.includeAmountsInPushPayload) {
    throw new Error("includeAmountsInPushPayload must be false");
  }
  if (PRIVACY_CONFIG.includeAddressesInPushPayload) {
    throw new Error("includeAddressesInPushPayload must be false");
  }
  const serialized = JSON.stringify(payload);
  if (/"amount"|"address"/i.test(serialized)) {
    throw new Error("wake-up payload must not include amount or address fields");
  }
}
