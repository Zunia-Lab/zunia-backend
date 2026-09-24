import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 128-bit session id, unpadded base64url (22 characters). Public: it appears in the QR code. */
export function newSessionId(): string {
  return randomBytes(16).toString("base64url");
}

/** 256-bit bearer token, unpadded base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only this hash is stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatches(token: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const presented = createHash("sha256").update(token, "utf8").digest();
  const stored = Buffer.from(storedHash, "hex");
  return stored.length === presented.length && timingSafeEqual(presented, stored);
}
