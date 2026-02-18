ALTER TABLE "orgs"
  ADD COLUMN "status_allowed_email_domains" JSONB,
  ADD COLUMN "status_session_ttl_minutes" INTEGER NOT NULL DEFAULT 720;

UPDATE "orgs"
SET "status_visibility" = 'PRIVATE_TOKEN'
WHERE "status_visibility" = 'PRIVATE';

CREATE TABLE "status_auth_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "status_auth_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "status_auth_tokens_org_id_created_at_idx"
  ON "status_auth_tokens"("org_id", "created_at");

CREATE INDEX "status_auth_tokens_expires_at_idx"
  ON "status_auth_tokens"("expires_at");

ALTER TABLE "status_auth_tokens"
  ADD CONSTRAINT "status_auth_tokens_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
