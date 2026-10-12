-- =============================================================================
-- 0038 Telegram front door: customers chat with the business's Telegram bot.
--
-- A Telegram chat works like a WhatsApp chat (0034): every message is kept per customer, Kritvia
-- drafts each reply with the whole chat in mind and waits for a person's yes, the team can take a
-- chat over, and /stop opts the customer out. Telegram has no 24-hour window and no templates: a
-- bot may answer anyone who wrote to it, at any time, but can never write first.
--
--   wa_contacts.channel  'whatsapp' (phone = the customer's number) or 'telegram' (phone = the
--                        Telegram chat id, digits); handle = their @username, when they have one.
--   connectors           provider 'telegram': external_id = the bot's id (one business per bot),
--                        account_email = @username, meta.secret_hash = sha256 of the secret Telegram
--                        sends with every update; the bot token is in connector_tokens (encrypted).
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in', 'telegram'));

ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_trigger_kind_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind IN ('manual', 'email', 'webhook', 'schedule', 'upload', 'api', 'whatsapp', 'telegram'));

ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_channel_check;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_channel_check
  CHECK (channel IN ('email', 'calendar', 'whatsapp', 'telegram'));

ALTER TABLE wa_contacts
  ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'telegram')),
  ADD COLUMN handle  text CHECK (handle ~ '^[A-Za-z0-9_]{1,64}$');
ALTER TABLE wa_contacts DROP CONSTRAINT wa_contacts_phone_check;
ALTER TABLE wa_contacts ADD CONSTRAINT wa_contacts_phone_check
  CHECK (phone ~ '^[0-9]{6,20}$' OR (channel = 'telegram' AND phone ~ '^[0-9]{1,20}$'));
ALTER TABLE wa_contacts DROP CONSTRAINT wa_contacts_venture_id_phone_key;
ALTER TABLE wa_contacts ADD CONSTRAINT wa_contacts_venture_channel_phone_key UNIQUE (venture_id, channel, phone);

-- Who receives a bot's updates: found by the connector id in the webhook's address, and only when
-- the secret Telegram sent matches (compared as hashes, so the stored value is never the secret).
CREATE FUNCTION private.telegram_principal(p_connector uuid, p_secret_hash text)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c
   WHERE c.id = p_connector AND c.provider = 'telegram' AND c.status = 'active'
     AND c.meta ->> 'secret_hash' = p_secret_hash
$$;
GRANT EXECUTE ON FUNCTION private.telegram_principal(uuid, text) TO kritvia_app;

-- The same runtime for the team's own replies on the Chats page (the token is read as the runtime,
-- like WhatsApp's); only for a business the caller can see.
CREATE FUNCTION private.telegram_runtime(p_venture uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c
   WHERE c.venture_id = p_venture AND c.provider = 'telegram' AND c.status = 'active'
     AND p_venture = ANY ((SELECT private.readable_ventures())::uuid[])
$$;
GRANT EXECUTE ON FUNCTION private.telegram_runtime(uuid) TO kritvia_app;
