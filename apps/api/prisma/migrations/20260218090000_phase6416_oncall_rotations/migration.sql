-- CreateTable
CREATE TABLE "on_call_schedules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "start_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handoff_interval" TEXT NOT NULL DEFAULT 'WEEKLY',
    "handoff_hour" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "on_call_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "on_call_rotation_members" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'PRIMARY',
    "order" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "on_call_rotation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "on_call_overrides" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'PRIMARY',
    "from_user_id" UUID,
    "to_user_id" UUID NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "on_call_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "on_call_assignment_logs" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "tier" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    CONSTRAINT "on_call_assignment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "on_call_schedules_org_id_is_enabled_idx" ON "on_call_schedules"("org_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "on_call_rotation_members_schedule_id_tier_order_key" ON "on_call_rotation_members"("schedule_id", "tier", "order");

-- CreateIndex
CREATE INDEX "on_call_rotation_members_schedule_id_tier_idx" ON "on_call_rotation_members"("schedule_id", "tier");

-- CreateIndex
CREATE INDEX "on_call_rotation_members_schedule_id_user_id_idx" ON "on_call_rotation_members"("schedule_id", "user_id");

-- CreateIndex
CREATE INDEX "on_call_overrides_schedule_id_start_at_idx" ON "on_call_overrides"("schedule_id", "start_at");

-- CreateIndex
CREATE INDEX "on_call_overrides_schedule_id_tier_idx" ON "on_call_overrides"("schedule_id", "tier");

-- CreateIndex
CREATE INDEX "on_call_assignment_logs_org_id_effective_at_idx" ON "on_call_assignment_logs"("org_id", "effective_at");

-- CreateIndex
CREATE INDEX "on_call_assignment_logs_schedule_id_effective_at_idx" ON "on_call_assignment_logs"("schedule_id", "effective_at");

-- AddForeignKey
ALTER TABLE "on_call_schedules" ADD CONSTRAINT "on_call_schedules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "on_call_rotation_members" ADD CONSTRAINT "on_call_rotation_members_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "on_call_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "on_call_rotation_members" ADD CONSTRAINT "on_call_rotation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "on_call_overrides" ADD CONSTRAINT "on_call_overrides_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "on_call_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "on_call_overrides" ADD CONSTRAINT "on_call_overrides_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "on_call_overrides" ADD CONSTRAINT "on_call_overrides_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "on_call_assignment_logs" ADD CONSTRAINT "on_call_assignment_logs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "on_call_assignment_logs" ADD CONSTRAINT "on_call_assignment_logs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "on_call_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "on_call_assignment_logs" ADD CONSTRAINT "on_call_assignment_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
