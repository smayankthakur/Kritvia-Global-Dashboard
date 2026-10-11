-- =============================================================================
-- 0031 Email forwarding: a business can let Kritvia read its email without giving it access to Gmail.
--
-- Reading Gmail needs the restricted gmail.readonly permission, which needs Google's paid yearly
-- security assessment (CASA) once more than 100 people use it. Instead each business gets its own
-- Kritvia address (e.g. sitelytc-7f3k9q2m4d@in.sitelytc.com) and sets its mailbox to forward mail
-- there. Mail arrives through Cloudflare Email Routing (infra/cloudflare/email-worker.js), signed,
-- at POST /public/email-in. Replies still go out from the business's own Gmail (gmail.send only,
-- not a restricted permission). Businesses that already connected Gmail with read access keep it.
--
--   connectors.provider 'email_in': external_id = the address's local part (unique), account_email =
--                                    the full address, meta = Gmail's forwarding confirmation (if any).
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in'));
ALTER TABLE connectors ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Who receives mail sent to one forwarding address (the business's agent runtime).
CREATE FUNCTION private.email_in_principal(p_local text)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.provider = 'email_in' AND c.external_id = lower(p_local) AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.email_in_principal(text) TO kritvia_app;
