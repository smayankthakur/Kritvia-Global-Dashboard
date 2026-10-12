-- =============================================================================
-- 0034 WhatsApp front door: one conversation per customer number.
--
-- Until now every inbound WhatsApp message became its own inbox-assistant run, and the reply was
-- drafted from that single message. Now each message, in and out, is kept per customer, so:
--   * replies are drafted with the whole recent chat in mind;
--   * a person can take over a chat ("You're replying") and Kritvia stays quiet until it is given
--     back; a customer who asks for a person is handed over by itself and the team is notified;
--   * the team reads and answers chats on the WhatsApp page, inside WhatsApp's 24-hour window;
--   * a customer who writes STOP gets no more automatic replies.
--
--   wa_contacts  one row per customer number per business
--   wa_messages  every message; the text is encrypted with the business's key (purpose
--                'whatsapp.message'). Deleting a contact deletes its messages (erasure requests).
-- =============================================================================
CREATE TABLE wa_contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  phone            text NOT NULL CHECK (phone ~ '^[0-9]{6,20}$'),     -- digits with country code
  name             text CHECK (char_length(name) <= 120),
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  handled_by       text NOT NULL DEFAULT 'kritvia' CHECK (handled_by IN ('kritvia', 'person')),
  handoff_reason   text CHECK (char_length(handoff_reason) <= 300),
  handoff_at       timestamptz,
  opted_out_at     timestamptz,
  unread           int NOT NULL DEFAULT 0 CHECK (unread >= 0),
  last_inbound_at  timestamptz,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, phone),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX wa_contacts_recent_idx ON wa_contacts (venture_id, last_message_at DESC);

CREATE TABLE wa_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  venture_id           uuid NOT NULL,
  contact_id           uuid NOT NULL REFERENCES wa_contacts(id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('in', 'out')),
  sent_by              text NOT NULL CHECK (sent_by IN ('customer', 'kritvia', 'person')),
  kind                 text NOT NULL DEFAULT 'text' CHECK (char_length(kind) <= 20),
  body_enc             bytea NOT NULL,
  provider_message_id  text CHECK (char_length(provider_message_id) <= 200),
  status               text NOT NULL CHECK (status IN ('received', 'sent', 'failed')),
  error                text CHECK (char_length(error) <= 300),
  approval_id          uuid REFERENCES approvals(id) ON DELETE SET NULL,
  user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  -- clock time, not transaction time: two messages stored in one transaction still have an order
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
-- Meta redelivers webhooks; the same message id is stored once per business.
CREATE UNIQUE INDEX wa_messages_provider_uq ON wa_messages (venture_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL AND provider_message_id <> '';
CREATE INDEX wa_messages_thread_idx ON wa_messages (contact_id, created_at DESC);

SELECT private.protect_tenant_table(t) FROM unnest(ARRAY['wa_contacts', 'wa_messages']) t;
-- Messages are a record: never edited, only deleted together with their contact.
DROP POLICY tenant_update ON wa_messages;
GRANT SELECT, INSERT, UPDATE, DELETE ON wa_contacts TO kritvia_app;
GRANT SELECT, INSERT, DELETE ON wa_messages TO kritvia_app;

-- Clearing the unread count is reading, not editing: anyone who can see the chat may do it
-- (approvers are read-only otherwise).
CREATE FUNCTION private.wa_mark_read(p_contact uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE wa_contacts SET unread = 0
   WHERE id = p_contact AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[])
$$;
GRANT EXECUTE ON FUNCTION private.wa_mark_read(uuid) TO kritvia_app;

-- Who hears about a chat that needs a person: everyone on the business who can write or approve.
CREATE FUNCTION private.venture_push_targets(p_venture uuid)
RETURNS TABLE (user_id uuid, subscription_id uuid, endpoint text, keys jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT m.user_id, s.id, s.endpoint, s.keys
    FROM ventures v
    JOIN memberships m ON m.org_id = v.org_id AND (m.venture_id IS NULL OR m.venture_id = v.id)
    JOIN roles r ON r.name = m.role AND (r.can_write OR r.can_approve)
    JOIN push_subscriptions s ON s.user_id = m.user_id AND s.failures < 5
   WHERE v.id = p_venture
$$;
GRANT EXECUTE ON FUNCTION private.venture_push_targets(uuid) TO kritvia_app;
