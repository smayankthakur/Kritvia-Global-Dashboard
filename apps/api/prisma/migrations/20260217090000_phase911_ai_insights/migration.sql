-- Phase 9.1.1: AI Execution Insight Engine (Deterministic v1)

ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'AI_INSIGHT';

CREATE TABLE IF NOT EXISTS "ai_insights" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "score_impact" INTEGER NOT NULL DEFAULT 0,
  "title" TEXT NOT NULL,
  "explanation" TEXT NOT NULL,
  "entity_type" TEXT,
  "entity_id" TEXT,
  "meta" JSONB,
  "is_resolved" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "ai_insights_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_insights_org_id_severity_idx" ON "ai_insights"("org_id", "severity");
CREATE INDEX IF NOT EXISTS "ai_insights_org_id_is_resolved_idx" ON "ai_insights"("org_id", "is_resolved");
CREATE INDEX IF NOT EXISTS "ai_insights_org_id_created_at_idx" ON "ai_insights"("org_id", "created_at");
CREATE INDEX IF NOT EXISTS "ai_insights_org_id_type_is_resolved_idx" ON "ai_insights"("org_id", "type", "is_resolved");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'ai_insights_org_id_fkey'
      AND table_name = 'ai_insights'
  ) THEN
    ALTER TABLE "ai_insights"
      ADD CONSTRAINT "ai_insights_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
