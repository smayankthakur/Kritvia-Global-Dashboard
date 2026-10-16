-- =============================================================================
-- 0045 Google reviews agent.
--
--   review_settings   the business's own Google Maps place (only its place ID is stored, as Google's
--                     terms require) and when to ask happy customers for a review.
--   review_requests   one ask per booking or paid invoice (and never the same person twice in 90 days).
--   review_replies    a drafted reply for each new review. The review itself is NOT stored: Google's
--                     terms allow only the place ID, so a review is known here by a hash of its Google
--                     resource name, and its text is fetched live whenever it is shown.
-- =============================================================================
CREATE TABLE review_settings (
  venture_id          uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  place_id            text CHECK (place_id ~ '^[A-Za-z0-9_-]+$' AND char_length(place_id) BETWEEN 10 AND 300),
  ask_after_booking   boolean NOT NULL DEFAULT true,
  ask_after_payment   boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('review_settings');
GRANT SELECT, INSERT, UPDATE, DELETE ON review_settings TO kritvia_app;

CREATE TABLE review_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  source       text NOT NULL CHECK (source IN ('booking', 'invoice')),
  source_id    uuid NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('whatsapp', 'telegram', 'email')),
  address      text NOT NULL CHECK (char_length(address) <= 254),
  status       text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'sent', 'skipped')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, source, source_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX review_requests_address_idx ON review_requests (venture_id, address, created_at);
SELECT private.protect_tenant_table('review_requests');
GRANT SELECT, INSERT, UPDATE ON review_requests TO kritvia_app;

CREATE TABLE review_replies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  review_key   text NOT NULL CHECK (review_key ~ '^[0-9a-f]{64}$'),   -- sha256 of Google's review name
  rating       int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  draft        text NOT NULL CHECK (char_length(draft) BETWEEN 1 AND 2000),
  status       text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'posted', 'dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, review_key),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('review_replies');
GRANT SELECT, INSERT, UPDATE ON review_replies TO kritvia_app;

CREATE OR REPLACE FUNCTION private.default_role(p_workflow text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_workflow
    WHEN 'inbox_assistant' THEN 'front_desk'
    WHEN 'booking_reminders' THEN 'front_desk'
    WHEN 'reviews' THEN 'front_desk'
    WHEN 'lead_triage' THEN 'sales'
    WHEN 'prospector' THEN 'sales'
    WHEN 'whatsapp_followup' THEN 'sales'
    WHEN 'loan_verification' THEN 'accounts'
    WHEN 'collections' THEN 'accounts'
    ELSE 'ops' END
$$;
