/**
 * Vercel Queues push consumer (wake-up only).
 * Configure in vercel.json with topic `zunia-tx-events`.
 *
 * Payload must never include amounts — indexer publishes { chainId, address, txHash }.
 */
import { handleCallback } from "@vercel/queue";

export type TxDetectedEvent = {
  chainId: string;
  address: string;
  txHash: string;
  detectedAt?: string;
  source?: string;
};

export const POST = handleCallback(
  async (message: TxDetectedEvent, metadata) => {
    // Idempotent wake-up for push / in-app notification centre
    const wakeUp = {
      event: "tx_update" as const,
      chainId: message.chainId,
      address: message.address,
      txHash: message.txHash,
    };
    // Wire to FCM / Web Push / chrome.notifications here (no amounts).
    console.log("[tx-events]", metadata.messageId, wakeUp);
  },
  {
    visibilityTimeoutSeconds: 120,
    retry: (_error, metadata) => {
      if (metadata.deliveryCount > 5) return { acknowledge: true };
      return { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 5) };
    },
  },
);
