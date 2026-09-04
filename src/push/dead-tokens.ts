import { lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { deadTokens } from "../db/schema.js";
import { PRIVACY_CONFIG } from "../../config/privacy.js";

export function deadTokenExpiresAt(from: Date = new Date()): Date {
  const days = PRIVACY_CONFIG.retainDeadPushTokensDays;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Record a dead token and schedule expiry (default 30 days). */
export async function markDeadToken(
  db: Db,
  input: { platform: string; pushToken: string; reason: string },
): Promise<void> {
  const expiresAt = deadTokenExpiresAt();
  await db
    .insert(deadTokens)
    .values({
      platform: input.platform,
      pushToken: input.pushToken,
      reason: input.reason,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [deadTokens.platform, deadTokens.pushToken],
      set: {
        reason: input.reason,
        expiresAt,
      },
    });
}

/**
 * Purge expired dead tokens. Call from a cron / scheduled function.
 * Retention window: PRIVACY_CONFIG.retainDeadPushTokensDays (30).
 */
export async function expireDeadTokens(
  db: Db,
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const result = await db
    .delete(deadTokens)
    .where(lt(deadTokens.expiresAt, now))
    .returning({ id: deadTokens.id });
  return { deleted: result.length };
}
