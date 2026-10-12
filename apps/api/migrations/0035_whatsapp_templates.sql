-- =============================================================================
-- 0035 WhatsApp templates and messages sent from the phone.
--
-- WhatsApp only allows free-form messages within 24 hours of the customer's last message. To
-- write first, or after those 24 hours, a business sends a message template that Meta approved.
--   wa_templates  the business's templates, mirrored from its WhatsApp account: written in
--                 Kritvia (sent to Meta for review) or in WhatsApp Manager (picked up on refresh).
--                 Meta reports approval or rejection to the webhook.
--
-- A number kept on the WhatsApp Business app (coexistence) can still be used on the phone. Those
-- messages reach Kritvia as "echoes" and are stored with sent_by 'phone', so the chat shows
-- everything the customer saw and Kritvia stops drafting once the owner answers from the phone.
-- =============================================================================
ALTER TABLE wa_messages DROP CONSTRAINT wa_messages_sent_by_check;
ALTER TABLE wa_messages ADD CONSTRAINT wa_messages_sent_by_check
  CHECK (sent_by IN ('customer', 'kritvia', 'person', 'phone'));

CREATE TABLE wa_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  meta_id     text CHECK (char_length(meta_id) <= 64),
  name        text NOT NULL CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512),
  language    text NOT NULL CHECK (language ~ '^[a-z]{2,3}(_[A-Za-z]{2,4})?$'),
  category    text NOT NULL CHECK (category IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  body        text NOT NULL CHECK (char_length(body) <= 1024),
  params      int NOT NULL DEFAULT 0 CHECK (params BETWEEN 0 AND 20),
  examples    text[] NOT NULL DEFAULT '{}',
  -- false when the template needs more than body text to send (a photo header, a link button
  -- with a blank, a one-time code): those are sent from WhatsApp Manager, not from Kritvia.
  sendable    boolean NOT NULL DEFAULT true,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (char_length(status) <= 30),
  reason      text CHECK (char_length(reason) <= 300),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, name, language),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('wa_templates');
GRANT SELECT, INSERT, UPDATE, DELETE ON wa_templates TO kritvia_app;

-- Meta reports template reviews per WhatsApp account (WABA), not per number.
CREATE FUNCTION private.whatsapp_waba_principals(p_waba_id text)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c
   WHERE c.provider = 'whatsapp' AND c.status = 'active' AND c.meta ->> 'waba_id' = p_waba_id
$$;
GRANT EXECUTE ON FUNCTION private.whatsapp_waba_principals(text) TO kritvia_app;
