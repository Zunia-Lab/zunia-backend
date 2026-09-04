/** Public package exports. */

export { createApp } from "./app.js";
export { createDb, requireDatabaseUrl } from "./db/client.js";
export * from "./db/schema.js";
export {
  hashAddress,
  addressWatchInsertPayload,
  assertNoPlaintextAddress,
  normalizeAddress,
  PrivacyError,
} from "./privacy/hash.js";
export {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  createRateLimitStore,
} from "./middleware/rate-limit.js";
export { processTxDetectedEvent } from "./push/consumer.js";
export { expireDeadTokens, markDeadToken, deadTokenExpiresAt } from "./push/dead-tokens.js";
export { NOTIFICATION_CONFIG } from "../config/notifications.js";
export { PRIVACY_CONFIG } from "../config/privacy.js";
export {
  INDEXER_PROXY_CONFIG,
  proxyWalletHistory,
} from "../config/indexer.js";
export { loadCorsOrigins, DEFAULT_CORS_ORIGINS } from "../config/cors.js";
