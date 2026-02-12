-- Alter ActivityEntityType for work items
ALTER TYPE "ActivityEntityType" ADD VALUE IF NOT EXISTS 'WORK_ITEM';

-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- CreateTable
CREATE TABLE "work_items" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkItemStatus" NOT NULL DEFAULT 'TODO',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "due_date" DATE,
    "assigned_to_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "company_id" UUID,
    "deal_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "work_items_org_id_status_idx" ON "work_items"("org_id", "status");
CREATE INDEX "work_items_org_id_assigned_to_user_id_idx" ON "work_items"("org_id", "assigned_to_user_id");
CREATE INDEX "work_items_org_id_due_date_idx" ON "work_items"("org_id", "due_date");
CREATE INDEX "work_items_deal_id_idx" ON "work_items"("deal_id");

-- Foreign Keys
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
