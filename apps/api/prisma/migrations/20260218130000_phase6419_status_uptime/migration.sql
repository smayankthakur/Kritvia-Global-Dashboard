-- AlterTable
ALTER TABLE "incidents"
  ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "public_summary" TEXT,
  ADD COLUMN "public_updates" JSONB,
  ADD COLUMN "public_slug" TEXT,
  ADD COLUMN "public_component_keys" JSONB;

-- CreateTable
CREATE TABLE "status_components" (
  "id" UUID NOT NULL,
  "org_id" UUID,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPERATIONAL',
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "status_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uptime_checks" (
  "id" UUID NOT NULL,
  "component_key" TEXT NOT NULL,
  "ok" BOOLEAN NOT NULL,
  "status_code" INTEGER,
  "latency_ms" INTEGER,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uptime_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "incidents_public_slug_key" ON "incidents"("public_slug");
CREATE UNIQUE INDEX "status_components_key_key" ON "status_components"("key");
CREATE INDEX "status_components_org_id_idx" ON "status_components"("org_id");
CREATE INDEX "uptime_checks_component_key_checked_at_idx" ON "uptime_checks"("component_key", "checked_at");

-- AddForeignKey
ALTER TABLE "status_components" ADD CONSTRAINT "status_components_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "uptime_checks" ADD CONSTRAINT "uptime_checks_component_key_fkey" FOREIGN KEY ("component_key") REFERENCES "status_components"("key") ON DELETE CASCADE ON UPDATE CASCADE;
