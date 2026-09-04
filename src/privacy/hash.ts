import { createHash } from "node:crypto";
import { PRIVACY_CONFIG } from "../../config/privacy.js";

export class PrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyError";
  }
}

/** Normalize address before hashing (trim + lowercase). */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function requireAddressPepper(): string {
  const pepper = process.env.ADDRESS_PEPPER;
  if (!pepper || pepper.length < 16) {
    throw new PrivacyError(
      "ADDRESS_PEPPER must be set to a secret of at least 16 characters",
    );
  }
  return pepper;
}

/**
 * Peppered SHA-256 of a wallet address.
 * Output is hex; never log or persist the plaintext address alongside this hash.
 */
export function hashAddress(
  address: string,
  pepper: string = requireAddressPepper(),
): string {
  if (!PRIVACY_CONFIG.storeAddressAsHash) {
    throw new PrivacyError("storeAddressAsHash is required; plaintext storage is forbidden");
  }
  const normalized = normalizeAddress(address);
  if (!normalized) {
    throw new PrivacyError("address is empty");
  }
  return createHash("sha256")
    .update(pepper, "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}

/**
 * Build an address_watches insert payload that contains ONLY the hash.
 * Refuses if any field looks like a raw address column.
 */
export function addressWatchInsertPayload(input: {
  deviceId: string;
  chainId: string;
  address: string;
  pepper?: string;
}): { deviceId: string; chainId: string; addressHash: string } {
  const addressHash = hashAddress(input.address, input.pepper);
  const payload = {
    deviceId: input.deviceId,
    chainId: input.chainId,
    addressHash,
  };
  assertNoPlaintextAddress(payload, input.address);
  return payload;
}

/** Guard: plaintext must not appear in any string field of a DB insert payload. */
export function assertNoPlaintextAddress(
  payload: Record<string, unknown>,
  plaintext: string,
): void {
  const needle = normalizeAddress(plaintext);
  if (!needle) return;
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== "string") continue;
    if (normalizeAddress(value) === needle) {
      throw new PrivacyError(
        `refusing to persist plaintext address in field "${key}"`,
      );
    }
    if (key === "address" || key === "walletAddress" || key === "bech32") {
      throw new PrivacyError(`forbidden plaintext address column "${key}"`);
    }
  }
}
