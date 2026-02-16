-- Phase 8.4.3: API Tokens (service accounts)

CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'ADMIN',
  "token_hash" TEXT NOT NULL,
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_token_hash_key" ON "api_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "api_tokens_org_id_idx" ON "api_tokens"("org_id");
CREATE INDEX IF NOT EXISTS "api_tokens_revoked_at_idx" ON "api_tokens"("revoked_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_tokens_org_id_fkey'
  ) THEN
    ALTER TABLE "api_tokens"
      ADD CONSTRAINT "api_tokens_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
