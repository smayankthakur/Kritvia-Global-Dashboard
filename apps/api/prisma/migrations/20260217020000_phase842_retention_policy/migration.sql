-- Phase 8.4.2: retention policy fields

ALTER TABLE "policies"
ADD COLUMN IF NOT EXISTS "audit_retention_days" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN IF NOT EXISTS "security_event_retention_days" INTEGER NOT NULL DEFAULT 180;
