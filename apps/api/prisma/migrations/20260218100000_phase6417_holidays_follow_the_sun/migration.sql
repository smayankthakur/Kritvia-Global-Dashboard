-- AlterTable
ALTER TABLE "on_call_schedules"
  ADD COLUMN "coverage_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "coverage_days" JSONB,
  ADD COLUMN "coverage_start" TEXT,
  ADD COLUMN "coverage_end" TEXT,
  ADD COLUMN "fallback_schedule_id" UUID;

-- CreateTable
CREATE TABLE "holiday_calendars" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "is_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "holiday_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday_entries" (
  "id" UUID NOT NULL,
  "calendar_id" UUID NOT NULL,
  "start_date" TIMESTAMP(3) NOT NULL,
  "end_date" TIMESTAMP(3),
  "title" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "holiday_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "on_call_schedule_calendars" (
  "id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "calendar_id" UUID NOT NULL,
  CONSTRAINT "on_call_schedule_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "on_call_schedules_fallback_schedule_id_idx" ON "on_call_schedules"("fallback_schedule_id");

-- CreateIndex
CREATE INDEX "holiday_calendars_org_id_is_enabled_idx" ON "holiday_calendars"("org_id", "is_enabled");

-- CreateIndex
CREATE INDEX "holiday_entries_calendar_id_start_date_idx" ON "holiday_entries"("calendar_id", "start_date");

-- CreateIndex
CREATE UNIQUE INDEX "on_call_schedule_calendars_schedule_id_calendar_id_key" ON "on_call_schedule_calendars"("schedule_id", "calendar_id");

-- CreateIndex
CREATE INDEX "on_call_schedule_calendars_schedule_id_idx" ON "on_call_schedule_calendars"("schedule_id");

-- CreateIndex
CREATE INDEX "on_call_schedule_calendars_calendar_id_idx" ON "on_call_schedule_calendars"("calendar_id");

-- AddForeignKey
ALTER TABLE "on_call_schedules" ADD CONSTRAINT "on_call_schedules_fallback_schedule_id_fkey" FOREIGN KEY ("fallback_schedule_id") REFERENCES "on_call_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday_calendars" ADD CONSTRAINT "holiday_calendars_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday_entries" ADD CONSTRAINT "holiday_entries_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "on_call_schedule_calendars" ADD CONSTRAINT "on_call_schedule_calendars_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "on_call_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "on_call_schedule_calendars" ADD CONSTRAINT "on_call_schedule_calendars_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "holiday_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;
