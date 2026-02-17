-- CreateTable
CREATE TABLE "escalation_policies" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
    "quiet_hours_start" TEXT,
    "quiet_hours_end" TEXT,
    "business_days_only" BOOLEAN NOT NULL DEFAULT false,
    "sla_critical" INTEGER NOT NULL DEFAULT 10,
    "sla_high" INTEGER NOT NULL DEFAULT 30,
    "sla_medium" INTEGER NOT NULL DEFAULT 180,
    "sla_low" INTEGER NOT NULL DEFAULT 1440,
    "steps" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_escalations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "alert_event_id" UUID NOT NULL,
    "step_number" INTEGER NOT NULL,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routed_to" JSONB NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,

    CONSTRAINT "alert_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "escalation_policies_org_id_key" ON "escalation_policies"("org_id");

-- CreateIndex
CREATE INDEX "escalation_policies_org_id_idx" ON "escalation_policies"("org_id");

-- CreateIndex
CREATE INDEX "escalation_policies_org_id_is_enabled_idx" ON "escalation_policies"("org_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "alert_escalations_alert_event_id_step_number_key" ON "alert_escalations"("alert_event_id", "step_number");

-- CreateIndex
CREATE INDEX "alert_escalations_org_id_attempted_at_idx" ON "alert_escalations"("org_id", "attempted_at");

-- CreateIndex
CREATE INDEX "alert_escalations_alert_event_id_attempted_at_idx" ON "alert_escalations"("alert_event_id", "attempted_at");

-- AddForeignKey
ALTER TABLE "escalation_policies" ADD CONSTRAINT "escalation_policies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_escalations" ADD CONSTRAINT "alert_escalations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_escalations" ADD CONSTRAINT "alert_escalations_alert_event_id_fkey" FOREIGN KEY ("alert_event_id") REFERENCES "alert_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
