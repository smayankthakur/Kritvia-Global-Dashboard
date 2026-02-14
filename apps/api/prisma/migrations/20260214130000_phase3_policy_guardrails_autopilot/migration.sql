-- AlterTable
ALTER TABLE "policies"
ADD COLUMN "default_work_due_days" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "stale_deal_after_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN "lead_stale_after_hours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN "require_deal_owner" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "require_work_owner" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "require_work_due_date" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "auto_lock_invoice_after_days" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "prevent_invoice_unlock_after_partial_payment" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "autopilot_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "autopilot_create_work_on_deal_stage_change" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "autopilot_nudge_on_overdue" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "autopilot_auto_stale_deals" BOOLEAN NOT NULL DEFAULT true;
