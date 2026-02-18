-- Phase 11.4 Risk propagation snapshots

CREATE TABLE "org_risk_snapshots" (
  "id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "as_of_date" DATE NOT NULL,
  "risk_score" INTEGER NOT NULL,
  "drivers" JSONB NOT NULL,
  "meta" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_risk_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "org_risk_snapshots_org_id_as_of_date_key"
  ON "org_risk_snapshots"("org_id", "as_of_date");

CREATE INDEX "org_risk_snapshots_org_id_as_of_date_idx"
  ON "org_risk_snapshots"("org_id", "as_of_date");

ALTER TABLE "org_risk_snapshots"
  ADD CONSTRAINT "org_risk_snapshots_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
