-- Phase 8.4.1: enterprise controls flag for plan-gated audit export

ALTER TABLE "plans"
ADD COLUMN IF NOT EXISTS "enterprise_controls_enabled" BOOLEAN NOT NULL DEFAULT false;
