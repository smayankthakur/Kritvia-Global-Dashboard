-- CreateTable
CREATE TABLE "security_events" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "entity_type" TEXT,
  "entity_id" TEXT,
  "user_id" UUID,
  "meta" JSONB,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "security_events"
ADD CONSTRAINT "security_events_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events"
ADD CONSTRAINT "security_events_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "security_events_org_id_severity_created_at_desc_idx"
ON "security_events"("org_id", "severity", "created_at" DESC);
