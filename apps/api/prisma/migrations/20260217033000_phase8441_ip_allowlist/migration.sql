-- Phase 8.4.4.1: org IP allowlist policy fields

ALTER TABLE "policies"
ADD COLUMN IF NOT EXISTS "ip_allowlist" JSONB,
ADD COLUMN IF NOT EXISTS "ip_restriction_enabled" BOOLEAN NOT NULL DEFAULT false;
