import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { addressWatches, devices, notificationLog } from "../db/schema.js";
import { hashAddress } from "../privacy/hash.js";
import { NOTIFICATION_CONFIG } from "../../config/notifications.js";
import { PRIVACY_CONFIG } from "../../config/privacy.js";
import { sendApns } from "./apns.js";
import { sendFcmHttpV1 } from "./fcm.js";
import { sendWebPush } from "./vapid.js";
import { markDeadToken } from "./dead-tokens.js";
import type { WakeUpPayload } from "./types.js";

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
  coalesced: number;
  capped: number;
};

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
    return { skipped: true, reason: "no_watchers", sent: 0, coalesced: 0, capped: 0 };
  }

  let sent = 0;
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

    const result = await dispatchPush({
      platform: watch.platform,
      pushToken: watch.pushToken,
      payload: wakeUp,
    });

    if (!result.ok && result.dead) {
      await markDeadToken(db, {
        platform: watch.platform,
        pushToken: watch.pushToken,
        reason: result.reason,
      });
      await db.delete(devices).where(eq(devices.id, watch.deviceId));
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

    if (result.ok) sent += 1;
  }

  return { skipped: false, sent, coalesced, capped };
}

async function dispatchPush(input: {
  platform: string;
  pushToken: string;
  payload: WakeUpPayload;
}) {
  switch (input.platform) {
    case "web":
    case "extension":
      return sendWebPush({ endpoint: input.pushToken, payload: input.payload });
    case "ios":
      return sendApns({ deviceToken: input.pushToken, payload: input.payload });
    case "android":
      return sendFcmHttpV1({ deviceToken: input.pushToken, payload: input.payload });
    default:
      console.warn(`[push] unknown platform ${input.platform}`);
      return { ok: false as const, dead: false, reason: "unknown_platform" };
  }
}
