-- CreateTable
CREATE TABLE "org_health_snapshots" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_key" TEXT NOT NULL,

    CONSTRAINT "org_health_snapshots_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "org_health_snapshots_org_id_date_key_key" ON "org_health_snapshots"("org_id", "date_key");
CREATE INDEX "org_health_snapshots_org_id_computed_at_idx" ON "org_health_snapshots"("org_id", "computed_at");

-- Foreign Keys
ALTER TABLE "org_health_snapshots" ADD CONSTRAINT "org_health_snapshots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
