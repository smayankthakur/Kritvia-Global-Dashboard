-- Phase 8.1.1 Plans + Subscriptions

CREATE TABLE IF NOT EXISTS "plans" (
  "id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price_monthly" INTEGER NOT NULL DEFAULT 0,
  "seat_limit" INTEGER,
  "org_limit" INTEGER,
  "autopilot_enabled" BOOLEAN NOT NULL DEFAULT false,
  "shield_enabled" BOOLEAN NOT NULL DEFAULT false,
  "portfolio_enabled" BOOLEAN NOT NULL DEFAULT false,
  "revenue_intelligence_enabled" BOOLEAN NOT NULL DEFAULT false,
  "max_work_items" INTEGER,
  "max_invoices" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plans_key_key" ON "plans"("key");

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "plan_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'TRIAL',
  "stripe_customer_id" TEXT,
  "stripe_subscription_id" TEXT,
  "trial_ends_at" TIMESTAMP(3),
  "current_period_end" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_org_id_key" ON "subscriptions"("org_id");
CREATE INDEX IF NOT EXISTS "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON "subscriptions"("status");

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
