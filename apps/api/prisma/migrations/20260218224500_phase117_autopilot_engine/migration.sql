-- Phase 11.7 Autopilot policies and runs

CREATE TABLE IF NOT EXISTS "autopilot_policies" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "entity_type" TEXT NOT NULL,
  "condition" JSONB NOT NULL,
  "action_template_key" TEXT NOT NULL,
  "risk_threshold" INTEGER,
  "auto_execute" BOOLEAN NOT NULL DEFAULT false,
  "max_executions_per_hour" INTEGER NOT NULL DEFAULT 10,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "autopilot_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "autopilot_runs" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "policy_id" UUID NOT NULL,
  "fix_action_run_id" UUID,
  "entity_type" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRY_RUN',
  "preview" JSONB,
  "result" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "autopilot_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "autopilot_policies_org_id_entity_type_is_enabled_idx"
  ON "autopilot_policies"("org_id", "entity_type", "is_enabled");

CREATE INDEX IF NOT EXISTS "autopilot_runs_org_id_created_at_idx"
  ON "autopilot_runs"("org_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autopilot_policies_org_id_fkey') THEN
    ALTER TABLE "autopilot_policies"
      ADD CONSTRAINT "autopilot_policies_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autopilot_runs_org_id_fkey') THEN
    ALTER TABLE "autopilot_runs"
      ADD CONSTRAINT "autopilot_runs_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autopilot_runs_policy_id_fkey') THEN
    ALTER TABLE "autopilot_runs"
      ADD CONSTRAINT "autopilot_runs_policy_id_fkey"
      FOREIGN KEY ("policy_id") REFERENCES "autopilot_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'autopilot_runs_fix_action_run_id_fkey') THEN
    ALTER TABLE "autopilot_runs"
      ADD CONSTRAINT "autopilot_runs_fix_action_run_id_fkey"
      FOREIGN KEY ("fix_action_run_id") REFERENCES "fix_action_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
