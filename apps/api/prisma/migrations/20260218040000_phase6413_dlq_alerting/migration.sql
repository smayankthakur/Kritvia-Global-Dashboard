-- AlterEnum
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'WEBHOOK';
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'ALERT';

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "threshold_count" INTEGER NOT NULL DEFAULT 5,
    "window_minutes" INTEGER NOT NULL DEFAULT 10,
    "severity" TEXT NOT NULL DEFAULT 'HIGH',
    "auto_mitigation" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "rule_id" UUID,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "is_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_by_user_id" UUID,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failed_jobs" (
    "id" UUID NOT NULL,
    "org_id" UUID,
    "queue" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "attempts_made" INTEGER NOT NULL DEFAULT 0,
    "payload_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rules_org_id_type_idx" ON "alert_rules"("org_id", "type");

-- CreateIndex
CREATE INDEX "alert_events_org_id_created_at_idx" ON "alert_events"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "alert_events_org_id_is_acknowledged_idx" ON "alert_events"("org_id", "is_acknowledged");

-- CreateIndex
CREATE INDEX "failed_jobs_created_at_idx" ON "failed_jobs"("created_at");

-- CreateIndex
CREATE INDEX "failed_jobs_queue_idx" ON "failed_jobs"("queue");

-- CreateIndex
CREATE INDEX "failed_jobs_org_id_idx" ON "failed_jobs"("org_id");

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failed_jobs" ADD CONSTRAINT "failed_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
