import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { addressWatches, devices, notificationLog } from "../db/schema.js";
import { hashAddress } from "../privacy/hash.js";
import { NOTIFICATION_CONFIG } from "../../config/notifications.js";
import { PRIVACY_CONFIG } from "../../config/privacy.js";
import { sendFcmHttpV1 } from "./fcm.js";
import { sendWebPush } from "./vapid.js";
import { markDeadToken } from "./dead-tokens.js";
import type { PushSendResult, WakeUpPayload } from "./types.js";

export type TxDetectedEvent = {
  chainId: string;
  address: string;
  txHash: string;
  detectedAt?: string;
  source?: string;
};

export type ProcessTxEventResult = {
  skipped: boolean;
  reason?: string;
  sent: number;
  /** Sends that failed and were not logged, so a redelivery of the event tries again. */
  failed: number;
  coalesced: number;
  capped: number;
};

/** The transports, swappable in tests. */
export type PushSenders = {
  fcm: (input: { deviceToken: string; payload: WakeUpPayload }) => Promise<PushSendResult>;
  webPush: (input: { endpoint: string; payload: WakeUpPayload }) => Promise<PushSendResult>;
};

const DEFAULT_SENDERS: PushSenders = { fcm: sendFcmHttpV1, webPush: sendWebPush };

function idempotencyKey(chainId: string, txHash: string, deviceId: string): string {
  return `${chainId}:${txHash}:${deviceId}`;
}

function coalesceBucket(chainId: string, addressHash: string, nowMs: number): string {
  const windowMs = NOTIFICATION_CONFIG.delivery.coalesceWindowSec * 1000;
  const bucket = Math.floor(nowMs / windowMs);
  return `${chainId}:${addressHash}:${bucket}`;
}

/**
 * Fan-out a tx-detected event to watching devices with idempotency, coalesce, and caps.
 * Push body is wake-up only (no amounts / addresses).
 */
export async function processTxDetectedEvent(
  db: Db,
  event: TxDetectedEvent,
  now: Date = new Date(),
  senders: PushSenders = DEFAULT_SENDERS,
): Promise<ProcessTxEventResult> {
  if (PRIVACY_CONFIG.includeAmountsInPushPayload) {
    throw new Error("privacy: amounts in push are forbidden");
  }

  const addressHash = hashAddress(event.address);
  const wakeUp: WakeUpPayload = {
    event: "tx_update",
    chainId: event.chainId,
    txHash: event.txHash,
  };

  const watches = await db
    .select({
      deviceId: addressWatches.deviceId,
      platform: devices.platform,
      pushToken: devices.pushToken,
    })
    .from(addressWatches)
    .innerJoin(devices, eq(addressWatches.deviceId, devices.id))
    .where(
      and(
        eq(addressWatches.chainId, event.chainId),
        eq(addressWatches.addressHash, addressHash),
      ),
    );

  if (watches.length === 0) {
    return { skipped: true, reason: "no_watchers", sent: 0, failed: 0, coalesced: 0, capped: 0 };
  }

  let sent = 0;
  let failed = 0;
  let coalesced = 0;
  let capped = 0;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const bucket = coalesceBucket(event.chainId, addressHash, now.getTime());

  for (const watch of watches) {
    const key = idempotencyKey(event.chainId, event.txHash, watch.deviceId);

    // Idempotency
    const existing = await db
      .select({ id: notificationLog.id })
      .from(notificationLog)
      .where(eq(notificationLog.idempotencyKey, key))
      .limit(1);
    if (existing[0]) {
      coalesced += 1;
      continue;
    }

    // Coalesce: another send in the same window for this device+bucket
    const recentCoalesce = await db
      .select({ id: notificationLog.id })
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.deviceId, watch.deviceId),
          eq(notificationLog.coalesceBucket, bucket),
        ),
      )
      .limit(1);
    if (recentCoalesce[0]) {
      coalesced += 1;
      await db
        .insert(notificationLog)
        .values({
          idempotencyKey: key,
          deviceId: watch.deviceId,
          coalesceBucket: bucket,
        })
        .onConflictDoNothing();
      continue;
    }

    // Per-user (device) hourly cap
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationLog)
      .where(
        and(
          eq(notificationLog.deviceId, watch.deviceId),
          gte(notificationLog.createdAt, hourAgo),
        ),
      );
    const count = countRows[0]?.count ?? 0;
    if (count >= NOTIFICATION_CONFIG.delivery.maxPerUserPerHour) {
      capped += 1;
      continue;
    }

    const result = await dispatchPush(
      {
        platform: watch.platform,
        pushToken: watch.pushToken,
        payload: wakeUp,
      },
      senders,
    );

    if (!result.ok) {
      // Never the token: it addresses one device.
      console.warn(`[push] ${watch.platform} send failed: ${result.reason}`);
      if (result.dead) {
        await markDeadToken(db, {
          platform: watch.platform,
          pushToken: watch.pushToken,
          reason: result.reason,
        });
        await db.delete(devices).where(eq(devices.id, watch.deviceId));
      }
      // Not logged: a failure is neither a delivery to dedupe nor a window to coalesce into.
      failed += 1;
      continue;
    }

    await db
      .insert(notificationLog)
      .values({
        idempotencyKey: key,
        deviceId: watch.deviceId,
        coalesceBucket: bucket,
      })
      .onConflictDoNothing();
    sent += 1;
  }

  return { skipped: false, sent, failed, coalesced, capped };
}

/**
 * One device's push. Android and iOS both go through FCM: the app registers
 * with firebase_messaging on both, so an iOS token is an FCM token and FCM
 * relays it to APNs (src/push/apns.ts stays for raw APNs tokens, unused).
 */
export async function dispatchPush(
  input: {
    platform: string;
    pushToken: string;
    payload: WakeUpPayload;
  },
  senders: PushSenders = DEFAULT_SENDERS,
): Promise<PushSendResult> {
  switch (input.platform) {
    case "web":
    case "extension":
      return senders.webPush({ endpoint: input.pushToken, payload: input.payload });
    case "ios":
    case "android":
      return senders.fcm({ deviceToken: input.pushToken, payload: input.payload });
    default:
      console.warn(`[push] unknown platform ${input.platform}`);
      return { ok: false, dead: false, reason: "unknown_platform" };
  }
}
