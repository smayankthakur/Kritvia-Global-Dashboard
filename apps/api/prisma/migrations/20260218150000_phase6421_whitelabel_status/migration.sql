-- Org branding and status settings
ALTER TABLE "orgs"
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "status_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "status_name" TEXT,
  ADD COLUMN "status_logo_url" TEXT,
  ADD COLUMN "status_accent_color" TEXT,
  ADD COLUMN "status_footer_text" TEXT,
  ADD COLUMN "status_visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN "status_access_token_hash" TEXT,
  ADD COLUMN "custom_status_domain" TEXT,
  ADD COLUMN "custom_domain_verify_token" TEXT,
  ADD COLUMN "custom_domain_verified_at" TIMESTAMP(3);

WITH ranked AS (
  SELECT
    id,
    CASE
      WHEN trim(name) = '' THEN 'org'
      ELSE regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')
    END AS base_slug,
    ROW_NUMBER() OVER (
      PARTITION BY regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')
      ORDER BY created_at, id
    ) AS rn
  FROM "orgs"
)
UPDATE "orgs" o
SET "slug" = CASE
  WHEN r.rn = 1 THEN trim(both '-' FROM r.base_slug)
  ELSE concat(trim(both '-' FROM r.base_slug), '-', r.rn::text)
END
FROM ranked r
WHERE o.id = r.id;

UPDATE "orgs"
SET "slug" = concat('org-', substring(replace(id::text, '-', ''), 1, 12))
WHERE "slug" IS NULL OR "slug" = '';

ALTER TABLE "orgs"
  ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "orgs_slug_key" ON "orgs"("slug");
CREATE UNIQUE INDEX "orgs_custom_status_domain_key" ON "orgs"("custom_status_domain");

-- Status components scoped per org
WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "status_components" sc
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "uptime_checks"
  DROP CONSTRAINT IF EXISTS "uptime_checks_component_key_fkey";

DROP INDEX IF EXISTS "status_components_key_key";
ALTER TABLE "status_components"
  ALTER COLUMN "org_id" SET NOT NULL;

CREATE UNIQUE INDEX "status_components_org_id_key_key" ON "status_components"("org_id", "key");

-- Uptime checks scoped per org
ALTER TABLE "uptime_checks" ADD COLUMN "org_id" UUID;

UPDATE "uptime_checks" uc
SET "org_id" = sc."org_id"
FROM "status_components" sc
WHERE sc."key" = uc."component_key";

WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "uptime_checks"
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "uptime_checks"
  ALTER COLUMN "org_id" SET NOT NULL;

DROP INDEX IF EXISTS "uptime_checks_component_key_checked_at_idx";
CREATE INDEX "uptime_checks_org_id_component_key_checked_at_idx"
  ON "uptime_checks"("org_id", "component_key", "checked_at");

ALTER TABLE "uptime_checks"
  ADD CONSTRAINT "uptime_checks_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uptime_checks"
  ADD CONSTRAINT "uptime_checks_org_id_component_key_fkey"
  FOREIGN KEY ("org_id", "component_key")
  REFERENCES "status_components"("org_id", "key")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Incident index for org-scoped public reads
CREATE INDEX "incidents_org_id_is_public_created_at_idx" ON "incidents"("org_id", "is_public", "created_at");

-- Subscriber scoping per org
WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "status_subscribers"
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "status_subscribers"
  ALTER COLUMN "org_id" SET NOT NULL;

ALTER TABLE "status_subscriptions" ADD COLUMN "org_id" UUID;
UPDATE "status_subscriptions" ss
SET "org_id" = s."org_id"
FROM "status_subscribers" s
WHERE s.id = ss."subscriber_id";

ALTER TABLE "status_subscriptions"
  ALTER COLUMN "org_id" SET NOT NULL;

CREATE INDEX "status_subscriptions_org_id_idx" ON "status_subscriptions"("org_id");
ALTER TABLE "status_subscriptions"
  ADD CONSTRAINT "status_subscriptions_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "status_notification_logs" ADD COLUMN "org_id" UUID;
UPDATE "status_notification_logs" snl
SET "org_id" = COALESCE(ss."org_id", i."org_id")
FROM "status_subscribers" ss
LEFT JOIN "incidents" i ON i.id = snl."incident_id"
WHERE ss.id = snl."subscriber_id";

WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "status_notification_logs"
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "status_notification_logs"
  ALTER COLUMN "org_id" SET NOT NULL;

CREATE INDEX "status_notification_logs_org_id_created_at_idx"
  ON "status_notification_logs"("org_id", "created_at");
ALTER TABLE "status_notification_logs"
  ADD CONSTRAINT "status_notification_logs_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
