import { readFile } from "node:fs/promises";
import type { PushSendResult, WakeUpPayload } from "./types.js";
import { PRIVACY_CONFIG } from "../../config/privacy.js";

/**
 * APNs token-auth stub (HTTP/2 provider API).
 * TODO: ES256 JWT from APNS_KEY_PATH + APNS_KEY_ID + APNS_TEAM_ID.
 */
export async function sendApns(input: {
  deviceToken: string;
  payload: WakeUpPayload;
  fetchImpl?: typeof fetch;
}): Promise<PushSendResult> {
  assertWakeUpOnly(input.payload);

  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const keyPath = process.env.APNS_KEY_PATH;
  const bundleId = process.env.APNS_BUNDLE_ID ?? "com.zuniawallet.zuniaMobile";
  const host =
    process.env.APNS_HOST ?? "https://api.push.apple.com";

  if (!keyId || !teamId || !keyPath) {
    console.warn("[apns] APNS_KEY_ID / TEAM_ID / KEY_PATH missing — dry-run");
    return { ok: true };
  }

  // Touch key file so misconfig fails early in non-dry runs
  try {
    await readFile(keyPath);
  } catch {
    return { ok: false, dead: false, reason: "apns_key_unreadable" };
  }

  // TODO: sign JWT with .p8 and use undici HTTP/2
  const bearer = process.env.APNS_JWT_STUB;
  if (!bearer) {
    console.warn("[apns] no JWT stub — dry-run (wire jose + http2)");
    return { ok: true };
  }

  const fetchFn = input.fetchImpl ?? fetch;
  const url = `${host}/3/device/${input.deviceToken}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      authorization: `bearer ${bearer}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: {
        // Wake-up only — no amount / address content
        "content-available": 1,
      },
      event: input.payload.event,
      chainId: input.payload.chainId,
      txHash: input.payload.txHash,
    }),
  });

  if (res.status === 410) {
    return { ok: false, dead: true, reason: "apns_unregistered" };
  }
  if (!res.ok) {
    return { ok: false, dead: false, reason: `apns_${res.status}` };
  }
  return { ok: true };
}

function assertWakeUpOnly(payload: WakeUpPayload): void {
  if (PRIVACY_CONFIG.includeAmountsInPushPayload) {
    throw new Error("includeAmountsInPushPayload must be false");
  }
  if (PRIVACY_CONFIG.includeAddressesInPushPayload) {
    throw new Error("includeAddressesInPushPayload must be false");
  }
  void payload;
}
