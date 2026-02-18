-- Phase 11.6 1-click fix actions

CREATE TABLE IF NOT EXISTS "fix_action_templates" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "requires_confirmation" BOOLEAN NOT NULL DEFAULT true,
  "allowed_roles" JSONB NOT NULL,
  "config" JSONB,
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fix_action_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "fix_action_runs" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "template_id" UUID NOT NULL,
  "nudge_id" UUID,
  "entity_type" TEXT NOT NULL,
  "entity_id" UUID NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "idempotency_key" TEXT NOT NULL,
  "input" JSONB,
  "result" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fix_action_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fix_action_templates_org_id_key_key"
  ON "fix_action_templates"("org_id", "key");

CREATE UNIQUE INDEX IF NOT EXISTS "fix_action_runs_org_id_idempotency_key_key"
  ON "fix_action_runs"("org_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS "fix_action_runs_org_id_created_at_idx"
  ON "fix_action_runs"("org_id", "created_at");

CREATE INDEX IF NOT EXISTS "fix_action_runs_org_id_status_idx"
  ON "fix_action_runs"("org_id", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fix_action_templates_org_id_fkey'
  ) THEN
    ALTER TABLE "fix_action_templates"
      ADD CONSTRAINT "fix_action_templates_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fix_action_runs_org_id_fkey'
  ) THEN
    ALTER TABLE "fix_action_runs"
      ADD CONSTRAINT "fix_action_runs_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fix_action_runs_template_id_fkey'
  ) THEN
    ALTER TABLE "fix_action_runs"
      ADD CONSTRAINT "fix_action_runs_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "fix_action_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fix_action_runs_nudge_id_fkey'
  ) THEN
    ALTER TABLE "fix_action_runs"
      ADD CONSTRAINT "fix_action_runs_nudge_id_fkey"
      FOREIGN KEY ("nudge_id") REFERENCES "nudges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fix_action_runs_requested_by_user_id_fkey'
  ) THEN
    ALTER TABLE "fix_action_runs"
      ADD CONSTRAINT "fix_action_runs_requested_by_user_id_fkey"
      FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
