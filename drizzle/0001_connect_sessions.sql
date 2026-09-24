-- zunia.connect.v2 relay sessions. Token columns hold SHA-256 hashes only.
-- Apply with `pnpm db:migrate`.

CREATE TABLE IF NOT EXISTS "connect_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "dapp_token_hash" text NOT NULL,
  "wallet_join_token_hash" text,
  "wallet_resume_token_hash" text,
  "verified_origin" text,
  "paired" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connect_sessions_expires_idx" ON "connect_sessions" ("expires_at");
