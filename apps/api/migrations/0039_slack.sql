-- =============================================================================
-- 0039 Slack for the team: the business's Slack channel hears what needs a person.
--
-- An admin pastes a Slack incoming-webhook address (Slack → Apps → Incoming Webhooks → a channel).
-- Kritvia posts there when a draft waits for a yes and when a customer chat needs a person, with a
-- link to Kritvia. Posts name who needs attention, never what a customer wrote.
--
--   connectors  provider 'slack': account_email = the channel's name as Slack showed it (optional),
--               the webhook address is in connector_tokens (encrypted; it is a secret).
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in', 'telegram', 'slack'));

-- Who reads the business's Slack address when there is something to post: its agent runtime.
CREATE FUNCTION private.slack_principal(p_venture uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.venture_id = p_venture AND c.provider = 'slack' AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.slack_principal(uuid) TO kritvia_app;
