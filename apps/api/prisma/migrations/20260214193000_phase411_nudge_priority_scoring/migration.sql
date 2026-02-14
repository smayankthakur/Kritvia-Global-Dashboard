-- CreateEnum
CREATE TYPE "NudgeType" AS ENUM ('MANUAL', 'OVERDUE_INVOICE', 'OVERDUE_WORK', 'STALE_DEAL');

-- CreateEnum
CREATE TYPE "NudgeSeverity" AS ENUM ('MEDIUM', 'HIGH', 'CRITICAL');

-- AlterTable
ALTER TABLE "nudges"
ADD COLUMN "type" "NudgeType" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "severity" "NudgeSeverity" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN "priority_score" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "meta" JSONB;

-- CreateIndex
CREATE INDEX "nudges_org_id_status_priority_score_idx" ON "nudges"("org_id", "status", "priority_score");

-- CreateIndex
CREATE INDEX "nudges_org_id_type_entity_type_entity_id_status_idx" ON "nudges"("org_id", "type", "entity_type", "entity_id", "status");
