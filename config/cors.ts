/**
 * Allowed browser / extension origins for CORS.
 * Override with CORS_ORIGINS (comma-separated) in non-prod.
 */

export const DEFAULT_CORS_ORIGINS = [
  "https://wallet.zuniawallet.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
] as const;

/** Chrome / Firefox extension IDs are added via CORS_EXTENSION_ORIGINS env. */
export function loadCorsOrigins(): string[] {
  const fromEnv = process.env.CORS_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const extensionOrigins = process.env.CORS_EXTENSION_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    ...(fromEnv?.length ? fromEnv : [...DEFAULT_CORS_ORIGINS]),
    ...(extensionOrigins ?? []),
  ];
}
