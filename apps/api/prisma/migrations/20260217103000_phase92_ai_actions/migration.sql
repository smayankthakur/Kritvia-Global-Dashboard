-- Phase 9.2: AI Action Layer

ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'AI_ACTION';

CREATE TABLE IF NOT EXISTS "ai_actions" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "insight_id" UUID,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED',
  "title" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "approved_by_user_id" UUID,
  "approved_at" TIMESTAMP(3),
  "executed_by_user_id" UUID,
  "executed_at" TIMESTAMP(3),
  "undo_data" JSONB,
  "undo_expires_at" TIMESTAMP(3),
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_actions_org_id_status_created_at_idx" ON "ai_actions"("org_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "ai_actions_org_id_type_idx" ON "ai_actions"("org_id", "type");
CREATE INDEX IF NOT EXISTS "ai_actions_org_id_insight_id_idx" ON "ai_actions"("org_id", "insight_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'ai_actions_org_id_fkey'
      AND table_name = 'ai_actions'
  ) THEN
    ALTER TABLE "ai_actions"
      ADD CONSTRAINT "ai_actions_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'ai_actions_insight_id_fkey'
      AND table_name = 'ai_actions'
  ) THEN
    ALTER TABLE "ai_actions"
      ADD CONSTRAINT "ai_actions_insight_id_fkey"
      FOREIGN KEY ("insight_id") REFERENCES "ai_insights"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
