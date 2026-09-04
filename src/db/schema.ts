import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";

/** Registered push endpoints. Tokens may be marked dead and moved to dead_tokens. */
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    platform: text("platform").notNull(), // web | extension | ios | android
    pushToken: text("push_token").notNull(),
    locale: text("locale").notNull().default("en"),
    /** Category prefs / quiet hours — opaque JSON, never addresses */
    prefs: jsonb("prefs").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("devices_platform_token_uidx").on(t.platform, t.pushToken),
    index("devices_platform_idx").on(t.platform),
  ],
);

/**
 * Opt-in address watches. ONLY peppered hashes — never plaintext bech32/hex.
 * See src/privacy/hash.ts and config/privacy.ts.
 */
export const addressWatches = pgTable(
  "address_watches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    chainId: text("chain_id").notNull(),
    /** sha256(ADDRESS_PEPPER || normalize(address)) hex */
    addressHash: text("address_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("address_watches_device_chain_hash_uidx").on(
      t.deviceId,
      t.chainId,
      t.addressHash,
    ),
    index("address_watches_chain_hash_idx").on(t.chainId, t.addressHash),
  ],
);

/**
 * Delivery log for idempotency + coalesce / per-user caps.
 * idempotency_key = `${chainId}:${txHash}:${deviceId}`.
 */
export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    coalesceBucket: text("coalesce_bucket"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("notification_log_idempotency_uidx").on(t.idempotencyKey),
    index("notification_log_device_created_idx").on(t.deviceId, t.createdAt),
  ],
);

/** Invalid / unregistered push tokens retained for PRIVACY_CONFIG.retainDeadPushTokensDays. */
export const deadTokens = pgTable(
  "dead_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    platform: text("platform").notNull(),
    pushToken: text("push_token").notNull(),
    reason: text("reason").notNull().default("unregistered"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("dead_tokens_platform_token_uidx").on(t.platform, t.pushToken),
    index("dead_tokens_expires_idx").on(t.expiresAt),
  ],
);

export type Device = typeof devices.$inferSelect;
export type AddressWatch = typeof addressWatches.$inferSelect;
export type NotificationLogRow = typeof notificationLog.$inferSelect;
export type DeadToken = typeof deadTokens.$inferSelect;
