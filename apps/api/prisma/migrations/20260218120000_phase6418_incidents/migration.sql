-- AlterTable
ALTER TABLE "alert_rules" ADD COLUMN "auto_create_incident" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "incidents" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "alert_event_id" UUID,
  "title" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "owner_user_id" UUID,
  "acknowledged_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_timeline" (
  "id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "message" TEXT,
  "metadata" JSONB,
  "actor_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_timeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_participants" (
  "id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'PARTICIPANT',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_postmortems" (
  "id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "summary" TEXT,
  "root_cause" TEXT,
  "impact" TEXT,
  "detection_gap" TEXT,
  "corrective_actions" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "incident_postmortems_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incidents_org_id_status_idx" ON "incidents"("org_id", "status");
CREATE INDEX "incidents_org_id_created_at_idx" ON "incidents"("org_id", "created_at");
CREATE INDEX "incidents_alert_event_id_idx" ON "incidents"("alert_event_id");

CREATE INDEX "incident_timeline_incident_id_created_at_idx" ON "incident_timeline"("incident_id", "created_at");

CREATE UNIQUE INDEX "incident_participants_incident_id_user_id_key" ON "incident_participants"("incident_id", "user_id");

CREATE UNIQUE INDEX "incident_postmortems_incident_id_key" ON "incident_postmortems"("incident_id");

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_alert_event_id_fkey" FOREIGN KEY ("alert_event_id") REFERENCES "alert_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "incident_timeline" ADD CONSTRAINT "incident_timeline_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_timeline" ADD CONSTRAINT "incident_timeline_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "incident_participants" ADD CONSTRAINT "incident_participants_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_participants" ADD CONSTRAINT "incident_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "incident_postmortems" ADD CONSTRAINT "incident_postmortems_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_postmortems" ADD CONSTRAINT "incident_postmortems_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
