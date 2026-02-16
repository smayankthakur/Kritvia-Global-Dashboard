-- Phase 9.3: LLM Explainability Layer (Grounded, JSON-only)

CREATE TABLE IF NOT EXISTS "llm_reports" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "period_start" TIMESTAMP(3),
  "period_end" TIMESTAMP(3),
  "input_hash" TEXT NOT NULL,
  "model" TEXT,
  "provider" TEXT,
  "content_json" JSONB NOT NULL,
  "content_text" TEXT,
  "tokens_in" INTEGER,
  "tokens_out" INTEGER,
  "latency_ms" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "llm_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "llm_reports_org_id_type_created_at_idx" ON "llm_reports"("org_id", "type", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "llm_reports_org_id_type_input_hash_key" ON "llm_reports"("org_id", "type", "input_hash");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'llm_reports_org_id_fkey'
      AND table_name = 'llm_reports'
  ) THEN
    ALTER TABLE "llm_reports"
      ADD CONSTRAINT "llm_reports_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
