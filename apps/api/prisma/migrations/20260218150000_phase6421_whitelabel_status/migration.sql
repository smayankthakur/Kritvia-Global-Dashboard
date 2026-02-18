-- Phase 6.4.21 white-label status migration
-- Idempotent/repair-safe version for partially applied databases.

-- Org branding and status settings
ALTER TABLE "orgs"
  ADD COLUMN IF NOT EXISTS "slug" TEXT,
  ADD COLUMN IF NOT EXISTS "status_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "status_name" TEXT,
  ADD COLUMN IF NOT EXISTS "status_logo_url" TEXT,
  ADD COLUMN IF NOT EXISTS "status_accent_color" TEXT,
  ADD COLUMN IF NOT EXISTS "status_footer_text" TEXT,
  ADD COLUMN IF NOT EXISTS "status_visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN IF NOT EXISTS "status_access_token_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "custom_status_domain" TEXT,
  ADD COLUMN IF NOT EXISTS "custom_domain_verify_token" TEXT,
  ADD COLUMN IF NOT EXISTS "custom_domain_verified_at" TIMESTAMP(3);

-- Normalize and backfill slugs for missing/empty values
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
WHERE o.id = r.id
  AND (o."slug" IS NULL OR o."slug" = '');

UPDATE "orgs"
SET "slug" = concat('org-', substring(replace(id::text, '-', ''), 1, 12))
WHERE "slug" IS NULL OR "slug" = '';

-- Normalize non-empty slugs and dedupe collisions before unique index creation
UPDATE "orgs"
SET "slug" = trim(both '-' FROM regexp_replace(lower(trim("slug")), '[^a-z0-9]+', '-', 'g'))
WHERE "slug" IS NOT NULL AND "slug" <> '';

WITH slug_dupes AS (
  SELECT
    id,
    "slug",
    ROW_NUMBER() OVER (PARTITION BY "slug" ORDER BY created_at, id) AS rn
  FROM "orgs"
  WHERE "slug" IS NOT NULL AND "slug" <> ''
)
UPDATE "orgs" o
SET "slug" = concat(o."slug", '-', sd.rn::text)
FROM slug_dupes sd
WHERE o.id = sd.id
  AND sd.rn > 1;

UPDATE "orgs"
SET "slug" = concat('org-', substring(replace(id::text, '-', ''), 1, 12))
WHERE "slug" IS NULL OR "slug" = '';

-- Deduplicate custom domains (keep oldest row, null out duplicates)
WITH domain_dupes AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY "custom_status_domain" ORDER BY created_at, id) AS rn
  FROM "orgs"
  WHERE "custom_status_domain" IS NOT NULL
)
UPDATE "orgs" o
SET "custom_status_domain" = NULL
FROM domain_dupes dd
WHERE o.id = dd.id
  AND dd.rn > 1;

ALTER TABLE "orgs"
  ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "orgs_slug_key" ON "orgs"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "orgs_custom_status_domain_key" ON "orgs"("custom_status_domain");

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

CREATE UNIQUE INDEX IF NOT EXISTS "status_components_org_id_key_key"
  ON "status_components"("org_id", "key");

-- Uptime checks scoped per org
ALTER TABLE "uptime_checks" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "uptime_checks" uc
SET "org_id" = sc."org_id"
FROM "status_components" sc
WHERE sc."key" = uc."component_key"
  AND uc."org_id" IS NULL;

WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "uptime_checks"
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "uptime_checks"
  ALTER COLUMN "org_id" SET NOT NULL;

DROP INDEX IF EXISTS "uptime_checks_component_key_checked_at_idx";
CREATE INDEX IF NOT EXISTS "uptime_checks_org_id_component_key_checked_at_idx"
  ON "uptime_checks"("org_id", "component_key", "checked_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uptime_checks_org_id_fkey'
  ) THEN
    ALTER TABLE "uptime_checks"
      ADD CONSTRAINT "uptime_checks_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Verification checklist (post-migration expectations):
-- 1) orgs:
--    - slug (NOT NULL)
--    - status_enabled, status_name, status_logo_url, status_accent_color, status_footer_text
--    - status_visibility, status_access_token_hash
--    - custom_status_domain, custom_domain_verify_token, custom_domain_verified_at
--    - unique indexes: orgs_slug_key, orgs_custom_status_domain_key
-- 2) status_components:
--    - org_id is populated and NOT NULL
--    - unique index: status_components_org_id_key_key on (org_id, key)
-- 3) uptime_checks:
--    - org_id exists and is NOT NULL
--    - FK uptime_checks_org_id_fkey -> orgs(id)
--    - FK uptime_checks_org_id_component_key_fkey -> status_components(org_id, key)
--    - index uptime_checks_org_id_component_key_checked_at_idx
-- 4) status_subscriptions:
--    - org_id exists and is NOT NULL
--    - FK status_subscriptions_org_id_fkey -> orgs(id)
--    - index status_subscriptions_org_id_idx
-- 5) status_notification_logs:
--    - org_id exists and is NOT NULL
--    - FK status_notification_logs_org_id_fkey -> orgs(id)
--    - index status_notification_logs_org_id_created_at_idx
-- 6) incidents:
--    - index incidents_org_id_is_public_created_at_idx

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uptime_checks_org_id_component_key_fkey'
  ) THEN
    ALTER TABLE "uptime_checks"
      ADD CONSTRAINT "uptime_checks_org_id_component_key_fkey"
      FOREIGN KEY ("org_id", "component_key")
      REFERENCES "status_components"("org_id", "key")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Incident index for org-scoped public reads
CREATE INDEX IF NOT EXISTS "incidents_org_id_is_public_created_at_idx"
  ON "incidents"("org_id", "is_public", "created_at");

-- Subscriber scoping per org
WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "status_subscribers"
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "status_subscribers"
  ALTER COLUMN "org_id" SET NOT NULL;

ALTER TABLE "status_subscriptions" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "status_subscriptions" ss
SET "org_id" = s."org_id"
FROM "status_subscribers" s
WHERE s.id = ss."subscriber_id"
  AND ss."org_id" IS NULL;

WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "status_subscriptions"
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "status_subscriptions"
  ALTER COLUMN "org_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "status_subscriptions_org_id_idx" ON "status_subscriptions"("org_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'status_subscriptions_org_id_fkey'
  ) THEN
    ALTER TABLE "status_subscriptions"
      ADD CONSTRAINT "status_subscriptions_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "status_notification_logs" ADD COLUMN IF NOT EXISTS "org_id" UUID;

UPDATE "status_notification_logs" snl
SET "org_id" = COALESCE(
  (SELECT ss."org_id" FROM "status_subscribers" ss WHERE ss.id = snl."subscriber_id"),
  (SELECT i."org_id" FROM "incidents" i WHERE i.id = snl."incident_id")
)
WHERE snl."org_id" IS NULL;

WITH default_org AS (
  SELECT id FROM "orgs" ORDER BY created_at ASC LIMIT 1
)
UPDATE "status_notification_logs"
SET "org_id" = (SELECT id FROM default_org)
WHERE "org_id" IS NULL;

ALTER TABLE "status_notification_logs"
  ALTER COLUMN "org_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "status_notification_logs_org_id_created_at_idx"
  ON "status_notification_logs"("org_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'status_notification_logs_org_id_fkey'
  ) THEN
    ALTER TABLE "status_notification_logs"
      ADD CONSTRAINT "status_notification_logs_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
