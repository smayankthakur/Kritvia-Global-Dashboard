-- Phase 8.4.4.3: Scoped API token permissions

ALTER TABLE "api_tokens"
ADD COLUMN IF NOT EXISTS "scopes" JSONB;
