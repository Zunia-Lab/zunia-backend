import { readFile } from "node:fs/promises";
import type { PushSendResult, WakeUpPayload } from "./types.js";
import { PRIVACY_CONFIG } from "../../config/privacy.js";

/**
 * FCM HTTP v1 stub.
 * TODO: obtain OAuth2 access token from service account at FCM_SERVICE_ACCOUNT_PATH.
 */
export async function sendFcmHttpV1(input: {
  deviceToken: string;
  payload: WakeUpPayload;
  projectId?: string;
  fetchImpl?: typeof fetch;
}): Promise<PushSendResult> {
  assertWakeUpOnly(input.payload);

  const saPath = process.env.FCM_SERVICE_ACCOUNT_PATH;
  const projectId =
    input.projectId ?? process.env.FCM_PROJECT_ID ?? (await peekProjectId(saPath));

  if (!saPath || !projectId) {
    console.warn("[fcm] FCM_SERVICE_ACCOUNT_PATH / project missing — dry-run");
    return { ok: true };
  }

  // TODO: google-auth JWT bearer from service account JSON
  const accessToken = process.env.FCM_ACCESS_TOKEN_STUB;
  if (!accessToken) {
    console.warn("[fcm] no access token stub — dry-run (wire google-auth)");
    return { ok: true };
  }

  const fetchFn = input.fetchImpl ?? fetch;
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token: input.deviceToken,
        data: {
          event: input.payload.event,
          chainId: input.payload.chainId,
          txHash: input.payload.txHash,
        },
        android: { priority: "HIGH" },
        apns: { headers: { "apns-priority": "10" } },
      },
    }),
  });

  if (res.status === 404) {
    return { ok: false, dead: true, reason: "fcm_unregistered" };
  }
  if (!res.ok) {
    return { ok: false, dead: false, reason: `fcm_${res.status}` };
  }
  return { ok: true };
}

async function peekProjectId(saPath: string | undefined): Promise<string | undefined> {
  if (!saPath) return undefined;
  try {
    const raw = await readFile(saPath, "utf8");
    const json = JSON.parse(raw) as { project_id?: string };
    return json.project_id;
  } catch {
    return undefined;
  }
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
