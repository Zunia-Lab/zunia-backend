import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  processTxDetectedEvent,
  type ProcessTxEventResult,
  type TxDetectedEvent,
} from "../push/consumer.js";

/**
 * Event intake for the always-on host: zunia-indexer, on the same machine,
 * POSTs each transaction it sees for a watched wallet here, and the push
 * fan-out runs as it would from the Vercel queue (api/queues/tx-events.ts).
 */

/** Header carrying INTERNAL_EVENTS_TOKEN. */
export const INTERNAL_TOKEN_HEADER = "x-zunia-internal-token";
/** A shorter secret is treated as unset: a guessable door is worse than a closed one. */
export const MIN_INTERNAL_TOKEN_LENGTH = 32;
/**
 * Set by nginx (X-Real-IP, X-Forwarded-For) or Cloudflare (CF-Connecting-IP).
 * The indexer calls 127.0.0.1 directly, so a request carrying one came in
 * from the internet, and for it these routes do not exist.
 */
const PROXY_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;

const txEventSchema = z.object({
  chainId: z.string().min(1).max(128),
  address: z.string().min(8).max(128),
  txHash: z.string().regex(/^[0-9A-Za-z]{16,128}$/),
});

/** INTERNAL_EVENTS_TOKEN, or undefined when unset or too short (logged). */
export function loadInternalEventsToken(
  value: string | undefined = process.env.INTERNAL_EVENTS_TOKEN,
): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (token.length < MIN_INTERNAL_TOKEN_LENGTH) {
    console.warn(
      `[internal] INTERNAL_EVENTS_TOKEN is shorter than ${MIN_INTERNAL_TOKEN_LENGTH} characters: tx events are refused`,
    );
    return undefined;
  }
  return token;
}

/** Constant time, whatever the lengths: both sides are hashed first. */
function sameSecret(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export type ProcessTxEvent = (db: Db, event: TxDetectedEvent) => Promise<ProcessTxEventResult>;

export function createInternalRoutes(deps: {
  db?: Db;
  /** INTERNAL_EVENTS_TOKEN; every call is refused while it is unset. */
  token?: string;
  /** Tests swap the fan-out. */
  process?: ProcessTxEvent;
}) {
  const app = new Hono();
  const handle: ProcessTxEvent = deps.process ?? ((db, event) => processTxDetectedEvent(db, event));

  app.use("/internal/*", async (c, next) => {
    if (PROXY_HEADERS.some((name) => c.req.header(name))) {
      return c.json({ error: "not_found" }, 404);
    }
    if (!deps.token) {
      return c.json({ error: "internal_events_not_configured" }, 503);
    }
    const presented = c.req.header(INTERNAL_TOKEN_HEADER);
    if (!presented || !sameSecret(presented, deps.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.post("/internal/tx-events", zValidator("json", txEventSchema), async (c) => {
    if (!deps.db) {
      return c.json({ error: "DATABASE_URL required for tx events" }, 503);
    }
    const event = c.req.valid("json");
    try {
      const result = await handle(deps.db, { ...event, source: "indexer" });
      // The address stays out of the log, as it stays out of the push.
      console.log("[tx-events]", { chainId: event.chainId, txHash: event.txHash, ...result });
      return c.json({ ok: true, ...result });
    } catch (err) {
      console.error(
        "[tx-events] failed:",
        { chainId: event.chainId, txHash: event.txHash },
        err instanceof Error ? err.message : err,
      );
      return c.json({ error: "processing_failed" }, 500);
    }
  });

  return app;
}
