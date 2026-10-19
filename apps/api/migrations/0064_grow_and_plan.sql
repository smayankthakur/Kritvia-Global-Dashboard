-- =============================================================================
-- 0064 Grow and plan ahead (roadmap phase 5).
--
--   cash_settings       the bank balance a person typed (or the last statement's), fixed monthly costs and the
--                       level to be warned below; statements by email on/off and the statement PDF password
--                       (encrypted with the business's key, never shown back)
--   bank_statements     .source 'upload' | 'email'; an emailed statement Kritvia couldn't verify the sender of
--                       (forwarded mail) has verified = false, and its lines are never confirmed in one tap
--   campaigns           .occasion ('diwali-2026', 'slow-2026-10-19') and .suggested: the weekly campaign ideas
--                       agent suggests at most one campaign per occasion
--   review_settings     .listing_checked_at / .listing_state: the weekly Google listing check
--   leads               .ad_source / .ad_campaign: which ad brought the lead (UTM tags, gclid, fbclid)
--   ad_reports, ad_spend
--                       ad spend uploaded from Meta Ads Manager or Google Ads (CSV or Excel export); Kritvia
--                       reads it and never spends
--   private.cash_targets()   businesses with money coming or going, for the Monday cash note
-- =============================================================================

-- ------------------------------------------------------------------------------------------- cash --
CREATE TABLE cash_settings (
  venture_id              uuid PRIMARY KEY,
  org_id                  uuid NOT NULL,
  balance_paise           bigint,
  balance_on              date,
  monthly_fixed_paise     bigint NOT NULL DEFAULT 0 CHECK (monthly_fixed_paise BETWEEN 0 AND 100000000000),
  alert_below_paise       bigint CHECK (alert_below_paise BETWEEN 0 AND 100000000000),
  statements_by_email     boolean NOT NULL DEFAULT true,
  statement_password_enc  bytea,
  last_note_on            date,
  updated_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((balance_paise IS NULL) = (balance_on IS NULL)),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('cash_settings');
GRANT SELECT, INSERT, UPDATE, DELETE ON cash_settings TO kritvia_app;

ALTER TABLE bank_statements
  ADD COLUMN source   text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'email')),
  ADD COLUMN sender   text CHECK (char_length(sender) <= 254),
  ADD COLUMN verified boolean NOT NULL DEFAULT true;

CREATE FUNCTION private.cash_targets()
RETURNS TABLE (venture_id uuid, org_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.venture_id, x.org_id, private.venture_owner(x.org_id)
    FROM (SELECT i.venture_id, i.org_id FROM invoices i WHERE i.status = 'open'
          UNION SELECT b.venture_id, b.org_id FROM bills b WHERE b.status = 'open') x
    JOIN ventures v ON v.id = x.venture_id AND v.removed_at IS NULL
    JOIN organisations o ON o.id = v.org_id AND o.closed_at IS NULL
$$;
REVOKE ALL ON FUNCTION private.cash_targets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.cash_targets() TO kritvia_app;

-- -------------------------------------------------------------------------------------- campaigns --
ALTER TABLE campaigns
  ADD COLUMN occasion  text CHECK (occasion ~ '^[a-z0-9-]{3,60}$'),
  ADD COLUMN suggested boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX campaigns_occasion_uq ON campaigns (venture_id, occasion) WHERE occasion IS NOT NULL;

-- ------------------------------------------------------------------------------ Google listing check --
ALTER TABLE review_settings
  ADD COLUMN listing_checked_at timestamptz,
  ADD COLUMN listing_state      jsonb;

-- -------------------------------------------------------------------------------------------- ads --
ALTER TABLE leads
  ADD COLUMN ad_source   text CHECK (ad_source ~ '^[a-z0-9_]{2,40}$'),
  ADD COLUMN ad_campaign text CHECK (char_length(ad_campaign) BETWEEN 1 AND 120);
CREATE INDEX leads_ad_idx ON leads (venture_id, ad_source, created_at DESC) WHERE ad_source IS NOT NULL;

CREATE TABLE ad_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('meta', 'google', 'other')),
  file_name     text CHECK (char_length(file_name) <= 200),
  period_from   date,
  period_to     date,
  rows          int NOT NULL DEFAULT 0,
  spend_paise   bigint NOT NULL DEFAULT 0,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX ad_reports_venture_idx ON ad_reports (venture_id, created_at DESC);
SELECT private.protect_tenant_table('ad_reports');
GRANT SELECT, INSERT, UPDATE, DELETE ON ad_reports TO kritvia_app;

-- One row per campaign and period: a later upload covering the same campaign and days replaces it.
CREATE TABLE ad_spend (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  report_id     uuid NOT NULL REFERENCES ad_reports(id) ON DELETE CASCADE,
  platform      text NOT NULL CHECK (platform IN ('meta', 'google', 'other')),
  campaign      text NOT NULL CHECK (char_length(campaign) BETWEEN 1 AND 200),
  day_from      date NOT NULL,
  day_to        date NOT NULL,
  spend_paise   bigint NOT NULL CHECK (spend_paise >= 0),
  impressions   bigint CHECK (impressions >= 0),
  clicks        bigint CHECK (clicks >= 0),
  results       int CHECK (results >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (day_to >= day_from),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ad_spend_uq ON ad_spend (venture_id, platform, lower(campaign), day_from, day_to);
SELECT private.protect_tenant_table('ad_spend');
GRANT SELECT, INSERT, UPDATE, DELETE ON ad_spend TO kritvia_app;
