-- CreateEnum
CREATE TYPE "NudgeStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "nudges" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "entity_type" "ActivityEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "NudgeStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "nudges_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "nudges_org_id_target_user_id_status_idx" ON "nudges"("org_id", "target_user_id", "status");
CREATE INDEX "nudges_org_id_entity_type_entity_id_idx" ON "nudges"("org_id", "entity_type", "entity_id");

-- Foreign Keys
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "nudges" ADD CONSTRAINT "nudges_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
