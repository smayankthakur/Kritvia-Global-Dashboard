-- =============================================================================
-- Kritvia 0014 — Agents configurable per business.
--
-- Every workflow config carries plain-language instructions the agents follow
-- ("always reply in Hinglish", "never promise delivery under 2 weeks"), alongside
-- the structured settings. Workflow modules declare their own options; the
-- settings column stays a free jsonb so old rows keep working.
-- =============================================================================
ALTER TABLE workflow_configs
  ADD COLUMN instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 4000);

-- WhatsApp messages can start runs too.
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_trigger_kind_check;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind IN ('manual', 'email', 'webhook', 'schedule', 'upload', 'api', 'whatsapp'));

-- WhatsApp Business (Meta Cloud API): one connector per venture, found by the
-- phone number id Meta sends with every inbound message. The access token lives
-- in connector_tokens, encrypted like a Google refresh token.
ALTER TABLE connectors ADD COLUMN external_id text;
CREATE UNIQUE INDEX connectors_provider_external_idx ON connectors (provider, external_id) WHERE external_id IS NOT NULL;

CREATE FUNCTION private.whatsapp_principal(p_phone_number_id text)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.provider = 'whatsapp' AND c.external_id = p_phone_number_id AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.whatsapp_principal(text) TO kritvia_app;

-- Tally imports: vouchers from a Tally Prime day-book / ledger XML export, so the
-- business can ask about sales, purchases and receivables with citations.
CREATE TABLE tally_vouchers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  document_id    uuid REFERENCES documents(id) ON DELETE SET NULL,
  guid           text NOT NULL,
  voucher_type   text NOT NULL,
  voucher_number text,
  voucher_date   date NOT NULL,
  party          text,
  narration      text,
  amount_inr     numeric(14, 2) NOT NULL DEFAULT 0,
  ledgers        jsonb NOT NULL DEFAULT '[]',
  imported_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, guid),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX tally_vouchers_venture_date_idx ON tally_vouchers (venture_id, voucher_date DESC);
SELECT private.protect_tenant_table('tally_vouchers');
GRANT SELECT, INSERT, UPDATE, DELETE ON tally_vouchers TO kritvia_app;

-- Forgot password: after proving the address with an emailed code, set a new password,
-- mark the email verified and sign every other session out. Existing accounts only.
CREATE FUNCTION public.auth_password_reset(p_email text, p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE lower(email) = lower(p_email) FOR UPDATE;
  IF NOT FOUND OR NOT u.is_active OR u.is_service THEN RETURN NULL; END IF;
  UPDATE users SET password_hash = p_hash, password_changed_at = now(),
                   email_verified_at = coalesce(email_verified_at, now()) WHERE id = u.id;
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = u.id;
  RETURN u.id;
END $$;
GRANT EXECUTE ON FUNCTION public.auth_password_reset(text, text) TO kritvia_app;
