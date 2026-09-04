import type { PushSendResult, WakeUpPayload } from "./types.js";
import { PRIVACY_CONFIG } from "../../config/privacy.js";

/**
 * Web Push (VAPID) stub — real HTTP to a push service endpoint.
 * TODO: load VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT and sign Authorization.
 */
export async function sendWebPush(input: {
  endpoint: string;
  payload: WakeUpPayload;
  fetchImpl?: typeof fetch;
}): Promise<PushSendResult> {
  assertWakeUpOnly(input.payload);

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    // TODO: fail closed in production once credentials are provisioned
    console.warn("[web-push] VAPID keys missing — dry-run");
    return { ok: true };
  }

  const fetchFn = input.fetchImpl ?? fetch;
  // TODO: encrypt payload with subscriber keys + add VAPID JWT Authorization header
  const res = await fetchFn(input.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      TTL: "60",
      Urgency: "high",
      // Authorization: `vapid t=${jwt}, k=${publicKey}`
    },
    body: JSON.stringify(input.payload),
  });

  if (res.status === 404 || res.status === 410) {
    return { ok: false, dead: true, reason: `web_push_${res.status}` };
  }
  if (!res.ok) {
    return { ok: false, dead: false, reason: `web_push_${res.status}` };
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
  const serialized = JSON.stringify(payload);
  if (/"amount"|"address"/i.test(serialized)) {
    throw new Error("wake-up payload must not include amount or address fields");
  }
}
