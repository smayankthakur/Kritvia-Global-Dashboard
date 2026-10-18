-- =============================================================================
-- 0057 AI voice calling: Kritvia answers the business's phone, and calls customers back after a yes.
--
--   connectors.provider 'twilio_voice'  the business's own Twilio number (account SID in external_id,
--                                       the number in account_email, the auth token encrypted in
--                                       connector_tokens). Twilio sends each call's events to
--                                       /hooks/voice/twilio/<connector>/..., signed with that token.
--   phone_settings   per business: on/off, language and voice, greeting, the number to put callers
--                    through to and when, longest call, and outbound calling (off until an admin
--                    records the business's telecom registration: TRAI's DLT entity and a
--                    service/transactional caller id).
--   calls            one row per call (inbound, outbound, or a test call in the app): the caller's
--                    number encrypted with a hash for matching, the conversation and the summary
--                    encrypted, outcome, length, the lead it belongs to.
--   voice_dnd        numbers that asked not to be called (or the team blocked): never called again.
--   private.voice_principal(connector)   the business behind a webhook, before its signature is
--                    checked with the business's own token.
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in', 'telegram', 'slack', 'razorpay',
                      'indiamart', 'twilio_voice'));

CREATE TABLE phone_settings (
  venture_id        uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  enabled           boolean NOT NULL DEFAULT false,
  language          text NOT NULL DEFAULT 'hi-IN' CHECK (language IN ('hi-IN', 'en-IN')),
  voice             text NOT NULL DEFAULT 'Polly.Aditi' CHECK (voice IN ('Polly.Aditi', 'Polly.Raveena', 'Polly.Kajal-Neural')),
  greeting          text CHECK (char_length(greeting) <= 300),
  transfer_number   text CHECK (transfer_number ~ '^\+[1-9][0-9]{7,14}$'),
  open_days         int[] NOT NULL DEFAULT '{0,1,2,3,4,5}' CHECK (open_days <@ ARRAY[0,1,2,3,4,5,6]),
  open_from         text NOT NULL DEFAULT '10:00' CHECK (open_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  open_to           text NOT NULL DEFAULT '19:00' CHECK (open_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  max_minutes       int NOT NULL DEFAULT 8 CHECK (max_minutes BETWEEN 2 AND 20),
  outbound_enabled  boolean NOT NULL DEFAULT false,
  dlt_entity_id     text CHECK (dlt_entity_id ~ '^[0-9]{10,25}$'),
  caller_id_kind    text CHECK (caller_id_kind IN ('160', 'landline', 'other')),
  registered_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  registered_at     timestamptz,
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- outbound calling only with the registration recorded
  CHECK (NOT outbound_enabled OR (dlt_entity_id IS NOT NULL AND caller_id_kind IS NOT NULL AND registered_at IS NOT NULL)),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('phone_settings');
GRANT SELECT, INSERT, UPDATE ON phone_settings TO kritvia_app;

CREATE TABLE calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  venture_id        uuid NOT NULL,
  connector_id      uuid REFERENCES connectors(id) ON DELETE SET NULL,
  direction         text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  test              boolean NOT NULL DEFAULT false,
  provider_call_id  text CHECK (char_length(provider_call_id) <= 80),
  phone_enc         bytea,
  phone_hash        text,
  status            text NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('queued', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'canceled')),
  outcome           text CHECK (outcome IN ('answered', 'message_taken', 'booking_requested', 'transferred', 'opted_out',
                                            'hung_up', 'no_input', 'too_long', 'ended')),
  state_enc         bytea NOT NULL,
  summary_enc       bytea,
  turns             int NOT NULL DEFAULT 0,
  duration_s        int,
  lead_id           uuid REFERENCES leads(id) ON DELETE SET NULL,
  approval_id       uuid,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  UNIQUE (connector_id, provider_call_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX calls_venture_idx ON calls (venture_id, started_at DESC);
CREATE INDEX calls_phone_idx ON calls (venture_id, phone_hash, started_at DESC);
SELECT private.protect_tenant_table('calls');
GRANT SELECT, INSERT, UPDATE, DELETE ON calls TO kritvia_app;

CREATE TABLE voice_dnd (
  venture_id   uuid NOT NULL,
  org_id       uuid NOT NULL,
  phone_hash   text NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('asked', 'team')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, phone_hash),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('voice_dnd');
GRANT SELECT, INSERT, DELETE ON voice_dnd TO kritvia_app;

CREATE FUNCTION private.voice_principal(p_connector uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c
   WHERE c.id = p_connector AND c.provider = 'twilio_voice' AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.voice_principal(uuid) TO kritvia_app;
