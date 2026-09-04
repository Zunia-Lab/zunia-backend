-- Initial schema for zunia-backend push / watch / notification tables.
-- Generated for drizzle-kit; apply with `pnpm db:migrate`.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "platform" text NOT NULL,
  "push_token" text NOT NULL,
  "locale" text DEFAULT 'en' NOT NULL,
  "prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "devices_platform_token_uidx" ON "devices" ("platform","push_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "devices_platform_idx" ON "devices" ("platform");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "address_watches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_id" uuid NOT NULL,
  "chain_id" text NOT NULL,
  "address_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "address_watches_device_chain_hash_uidx" ON "address_watches" ("device_id","chain_id","address_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "address_watches_chain_hash_idx" ON "address_watches" ("chain_id","address_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "device_id" uuid,
  "coalesce_bucket" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_log_idempotency_uidx" ON "notification_log" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_log_device_created_idx" ON "notification_log" ("device_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dead_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "platform" text NOT NULL,
  "push_token" text NOT NULL,
  "reason" text DEFAULT 'unregistered' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dead_tokens_platform_token_uidx" ON "dead_tokens" ("platform","push_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dead_tokens_expires_idx" ON "dead_tokens" ("expires_at");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "address_watches" ADD CONSTRAINT "address_watches_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
