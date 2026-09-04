/**
 * Vercel Queues push consumer (wake-up only).
 * Topic: zunia-tx-events (see vercel.json).
 *
 * Payload must never include amounts — indexer publishes { chainId, address, txHash }.
 * Address is hashed before DB lookup; push body is wake-up only.
 */
import { handleCallback } from "@vercel/queue";
import { createDb } from "../../src/db/client.js";
import {
  processTxDetectedEvent,
  type TxDetectedEvent,
} from "../../src/push/consumer.js";

let dbHandle: ReturnType<typeof createDb> | undefined;

function getDb() {
  if (!dbHandle) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL required for tx-events consumer");
    }
    dbHandle = createDb(url);
  }
  return dbHandle.db;
}

export const POST = handleCallback(
  async (message: TxDetectedEvent, metadata) => {
    const result = await processTxDetectedEvent(getDb(), message);
    console.log("[tx-events]", metadata.messageId, {
      chainId: message.chainId,
      txHash: message.txHash,
      ...result,
    });
  },
  {
    visibilityTimeoutSeconds: 120,
    retry: (_error, metadata) => {
      if (metadata.deliveryCount > 5) return { acknowledge: true };
      return { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 5) };
    },
  },
);
