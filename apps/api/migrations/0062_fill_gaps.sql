-- =============================================================================
-- 0062 Fill the gaps: bank statements, supplier bills, social posts, campaigns, Google Business Profile,
-- a Tally sync key, and a GSTR-1 export.
--
--   bank_statements / bank_lines  a statement uploaded as CSV, Excel or PDF; every credit and debit is a line
--                                 (credit > 0, debit < 0). A line is matched to an open invoice (credit) or an
--                                 open bill (debit): 'sure' when the amount is the balance and the narration
--                                 names the party or the number, 'likely' on the amount alone. Nothing is
--                                 recorded until a person confirms; confirming records the payment. The same
--                                 line in an overlapping statement is kept once (fingerprint).
--   bills                         what the business owes its suppliers: typed, read from a photo or PDF, or
--                                 found in a forwarded email. Kritvia reminds before the due date and when a
--                                 bank debit pays one; it never pays anything by itself.
--   social_posts                  posts the Social agent drafts (from the business's brief, offers and good
--                                 reviews), each posted to the Google Business Profile and/or the Facebook Page
--                                 after a yes.
--   campaigns / campaign_recipients  one message to many: a WhatsApp template to customers who agreed to hear
--                                 from the business (never anyone who wrote STOP), or an email to customers with
--                                 a one-click unsubscribe. One yes for the whole send; the list is fixed when it
--                                 is asked for.
--   email_optouts                 addresses that unsubscribed from a business's campaign emails.
--   review_settings.gbp_location  the business's Google Business Profile location (accounts/N/locations/M):
--                                 replies are then posted to Google after a yes, and posts can go there.
--   invoices.tally_synced_at      when the Tally companion took the invoice into Tally.
--   connectors 'facebook_page'    the business's Facebook Page (page id in external_id, the page token in
--                                 connector_tokens).
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in', 'telegram', 'slack', 'razorpay',
                      'indiamart', 'twilio_voice', 'exotel_voice', 'facebook_page'));

-- ------------------------------------------------------------------------------------------- bank --
CREATE TABLE bank_statements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  account_label  text CHECK (char_length(account_label) <= 80),
  file_name      text CHECK (char_length(file_name) <= 200),
  period_from    date,
  period_to      date,
  lines          int NOT NULL DEFAULT 0,
  credits_paise  bigint NOT NULL DEFAULT 0,
  debits_paise   bigint NOT NULL DEFAULT 0,
  uploaded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('bank_statements');
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_statements TO kritvia_app;

CREATE TABLE bank_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  statement_id   uuid NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  line_date      date NOT NULL,
  narration      text NOT NULL CHECK (char_length(narration) <= 500),
  reference      text CHECK (char_length(reference) <= 120),
  amount_paise   bigint NOT NULL CHECK (amount_paise <> 0),
  balance_paise  bigint,
  fingerprint    text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  match_kind     text CHECK (match_kind IN ('invoice', 'bill')),
  match_id       uuid,
  confidence     text CHECK (confidence IN ('sure', 'likely')),
  state          text NOT NULL DEFAULT 'unmatched' CHECK (state IN ('unmatched', 'suggested', 'confirmed', 'ignored')),
  decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, fingerprint),
  CHECK ((match_kind IS NULL) = (match_id IS NULL)),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX bank_lines_venture_idx ON bank_lines (venture_id, state, line_date DESC);
SELECT private.protect_tenant_table('bank_lines');
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_lines TO kritvia_app;

ALTER TABLE invoice_payments DROP CONSTRAINT invoice_payments_method_check;
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_method_check
  CHECK (method IN ('manual', 'upi', 'razorpay', 'bank'));
ALTER TABLE invoice_payments ADD COLUMN bank_line_id uuid REFERENCES bank_lines(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX invoice_payments_bank_line_uq ON invoice_payments (bank_line_id) WHERE bank_line_id IS NOT NULL;

-- ------------------------------------------------------------------------------------------ bills --
CREATE TABLE bills (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  vendor         text NOT NULL CHECK (char_length(vendor) BETWEEN 1 AND 160),
  number         text NOT NULL DEFAULT '' CHECK (char_length(number) <= 60),
  vendor_gstin   text CHECK (vendor_gstin IS NULL OR vendor_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  gst_paise      bigint NOT NULL DEFAULT 0 CHECK (gst_paise >= 0),
  paid_paise     bigint NOT NULL DEFAULT 0 CHECK (paid_paise >= 0),
  bill_date      date,
  due_on         date NOT NULL,
  category       text CHECK (char_length(category) <= 60),
  notes          text CHECK (char_length(notes) <= 1000),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  paid_on        date,
  paid_ref       text CHECK (char_length(paid_ref) <= 120),
  bank_line_id   uuid REFERENCES bank_lines(id) ON DELETE SET NULL,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'file', 'email')),
  reminded_on    date,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (paid_paise <= amount_paise),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
-- the same supplier's bill number twice is a double bill
CREATE UNIQUE INDEX bills_number_uq ON bills (venture_id, lower(vendor), lower(number))
  WHERE number <> '' AND status <> 'cancelled';
CREATE INDEX bills_due_idx ON bills (venture_id, due_on) WHERE status = 'open';
SELECT private.protect_tenant_table('bills');
GRANT SELECT, INSERT, UPDATE, DELETE ON bills TO kritvia_app;

-- The owner a worker job acts as for a business (as the morning self-check does).
CREATE FUNCTION private.venture_owner(p_org uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE m.org_id = p_org AND m.role = 'org_owner' AND m.venture_id IS NULL AND u.is_active
   ORDER BY m.created_at LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION private.venture_owner(uuid) TO kritvia_app;

-- Bills due within 3 days (or overdue) that nobody was reminded about today, for every business.
CREATE FUNCTION private.bills_to_remind(p_today date)
RETURNS TABLE (venture_id uuid, org_id uuid, run_as uuid, due_soon int, overdue int, total_paise bigint,
               first_vendor text, first_due date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.venture_id, b.org_id, private.venture_owner(b.org_id),
         count(*) FILTER (WHERE b.due_on >= p_today)::int, count(*) FILTER (WHERE b.due_on < p_today)::int,
         sum(b.amount_paise - b.paid_paise)::bigint,
         (array_agg(b.vendor ORDER BY b.due_on))[1], min(b.due_on)
    FROM bills b JOIN ventures v ON v.id = b.venture_id AND v.removed_at IS NULL
    JOIN organisations o ON o.id = v.org_id AND o.closed_at IS NULL
   WHERE b.status = 'open' AND b.due_on <= p_today + 3 AND (b.reminded_on IS NULL OR b.reminded_on < p_today)
   GROUP BY b.venture_id, b.org_id
$$;
-- Businesses that issued GST invoices in a month: their GSTR-1 is ready to download.
CREATE FUNCTION private.gstr1_targets(p_from date, p_to date)
RETURNS TABLE (venture_id uuid, org_id uuid, run_as uuid, invoices int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.venture_id, i.org_id, private.venture_owner(i.org_id), count(*)::int
    FROM invoices i JOIN ventures v ON v.id = i.venture_id AND v.removed_at IS NULL
    JOIN organisations o ON o.id = v.org_id AND o.closed_at IS NULL
   WHERE i.kind = 'gst' AND i.status IN ('open', 'paid') AND i.issued_on BETWEEN p_from AND p_to
   GROUP BY i.venture_id, i.org_id
$$;
GRANT EXECUTE ON FUNCTION private.gstr1_targets(date, date) TO kritvia_app;
GRANT EXECUTE ON FUNCTION private.bills_to_remind(date) TO kritvia_app;

-- ----------------------------------------------------------------------------------------- social --
CREATE TABLE social_posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  run_id      uuid,
  topic       text CHECK (char_length(topic) <= 200),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1500),
  channels    text[] NOT NULL CHECK (channels <@ ARRAY['google', 'facebook']::text[] AND cardinality(channels) >= 1),
  status      text NOT NULL DEFAULT 'drafted'
              CHECK (status IN ('drafted', 'posted', 'partly_posted', 'failed', 'dismissed')),
  results     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per channel: {"ok": true, "id": "..."} or {"error": "..."}
  created_at  timestamptz NOT NULL DEFAULT now(),
  posted_at   timestamptz,
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX social_posts_venture_idx ON social_posts (venture_id, created_at DESC);
SELECT private.protect_tenant_table('social_posts');
GRANT SELECT, INSERT, UPDATE, DELETE ON social_posts TO kritvia_app;

-- -------------------------------------------------------------------------------------- campaigns --
CREATE TABLE campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  channel      text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  template_id  uuid REFERENCES wa_templates(id) ON DELETE SET NULL,
  params       jsonb NOT NULL DEFAULT '[]'::jsonb,       -- the template's blanks, the same for everyone
  subject      text CHECK (char_length(subject) <= 150),
  body         text CHECK (char_length(body) <= 5000),
  audience     text NOT NULL CHECK (audience IN ('opted_in', 'customers', 'recent_customers')),
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'waiting', 'sending', 'sent', 'rejected', 'cancelled', 'failed')),
  run_id       uuid,
  recipients   int NOT NULL DEFAULT 0,
  sent         int NOT NULL DEFAULT 0,
  failed       int NOT NULL DEFAULT 0,
  skipped      int NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  CHECK (channel <> 'whatsapp' OR template_id IS NOT NULL OR status IN ('cancelled', 'failed', 'sent')),
  CHECK (channel <> 'email' OR (subject IS NOT NULL AND body IS NOT NULL)),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX campaigns_venture_idx ON campaigns (venture_id, created_at DESC);
SELECT private.protect_tenant_table('campaigns');
GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns TO kritvia_app;

CREATE TABLE campaign_recipients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  address      text NOT NULL CHECK (char_length(address) <= 254),
  name         text CHECK (char_length(name) <= 160),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  error        text CHECK (char_length(error) <= 300),
  sent_at      timestamptz,
  UNIQUE (campaign_id, address),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX campaign_recipients_queue_idx ON campaign_recipients (campaign_id) WHERE status = 'queued';
SELECT private.protect_tenant_table('campaign_recipients');
GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_recipients TO kritvia_app;

CREATE TABLE email_optouts (
  venture_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  address     text NOT NULL CHECK (address = lower(address) AND char_length(address) <= 254),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, address),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('email_optouts');
GRANT SELECT, INSERT, DELETE ON email_optouts TO kritvia_app;

-- A signed unsubscribe link works without signing in: the API checks the signature, then this records it.
CREATE FUNCTION private.email_unsubscribe(p_venture uuid, p_address text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH v AS (SELECT id, org_id FROM ventures WHERE id = p_venture AND removed_at IS NULL)
  INSERT INTO email_optouts (venture_id, org_id, address)
  SELECT v.id, v.org_id, lower(btrim(p_address)) FROM v
  ON CONFLICT DO NOTHING
  RETURNING true
$$;
GRANT EXECUTE ON FUNCTION private.email_unsubscribe(uuid, text) TO kritvia_app;

-- --------------------------------------------------------------------------- Google, Tally --
ALTER TABLE review_settings
  ADD COLUMN gbp_location text CHECK (gbp_location IS NULL OR gbp_location ~ '^accounts/[0-9]{1,30}/locations/[0-9]{1,30}$'),
  ADD COLUMN gbp_title    text CHECK (char_length(gbp_title) <= 160);
ALTER TABLE review_replies
  ADD COLUMN review_name  text CHECK (review_name IS NULL OR review_name ~ '^accounts/[0-9]+/locations/[0-9]+/reviews/[A-Za-z0-9_-]+$'),
  ADD COLUMN posted_at    timestamptz;

ALTER TABLE invoices ADD COLUMN tally_synced_at timestamptz;

-- The business behind a Tally companion's call, before its key is checked. The sync acts as the owner (as an
-- upload by the owner would).
CREATE FUNCTION private.tally_principal(p_connector uuid)
RETURNS TABLE (org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.org_id, c.venture_id, private.venture_owner(c.org_id)
    FROM connectors c JOIN ventures v ON v.id = c.venture_id AND v.removed_at IS NULL
   WHERE c.id = p_connector AND c.provider = 'tally' AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.tally_principal(uuid) TO kritvia_app;

-- A campaign's one approval sends to each person on its fixed list once: the outbox keeps "an approval sends at
-- most once" for every other message, and "a campaign recipient is sent to at most once" for campaigns.
ALTER TABLE outbox_messages ADD COLUMN campaign_recipient_id uuid REFERENCES campaign_recipients(id) ON DELETE SET NULL;
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_approval_id_key;
CREATE UNIQUE INDEX outbox_messages_approval_uq ON outbox_messages (approval_id) WHERE campaign_recipient_id IS NULL;
CREATE UNIQUE INDEX outbox_messages_campaign_recipient_uq ON outbox_messages (campaign_recipient_id)
  WHERE campaign_recipient_id IS NOT NULL;
