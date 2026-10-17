-- =============================================================================
-- Kritvia 0050 — Scale and Enterprise features that were "Coming soon":
--   priority processing (run_plan, for the dispatcher), API keys, custom workflows, SSO.
-- =============================================================================

-- ------------------------------------------------------------ priority processing --
-- The plan that applies to a run's organisation (the dispatcher picks the queue from it).
CREATE FUNCTION private.run_plan(p_run uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(private.applied_plan(r.org_id), '') FROM workflow_runs r WHERE r.id = p_run
$$;
GRANT EXECUTE ON FUNCTION private.run_plan(uuid) TO kritvia_app;

-- ------------------------------------------------------------------- API keys --
-- An organisation's keys for its own systems. A key acts as the owner who made it, only on that
-- organisation, only on the endpoints listed in services/api_keys.py, and only while the plan
-- includes API access and its maker is still an owner. Stored as a SHA-256 hash; shown once.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  prefix        text NOT NULL CHECK (char_length(prefix) = 12),
  key_hash      text NOT NULL UNIQUE CHECK (char_length(key_hash) = 64),
  scope         text NOT NULL CHECK (scope IN ('read', 'write')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id, created_at DESC);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_keys_admin_read ON api_keys FOR SELECT USING (org_id = ANY (private.owned_orgs()));
GRANT SELECT (id, org_id, created_by, name, prefix, scope, created_at, last_used_at, revoked_at) ON api_keys TO kritvia_app;

CREATE FUNCTION private.api_key_create(p_org uuid, p_name text, p_prefix text, p_hash text, p_scope text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE kid uuid;
BEGIN
  IF NOT p_org = ANY (private.owned_orgs()) THEN RAISE EXCEPTION 'organisation not found' USING ERRCODE = '42501'; END IF;
  IF (SELECT count(*) FROM api_keys WHERE org_id = p_org AND revoked_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'an organisation can have up to 20 active API keys' USING ERRCODE = 'KV409';
  END IF;
  INSERT INTO api_keys (org_id, created_by, name, prefix, key_hash, scope)
  VALUES (p_org, private.current_user_id(), p_name, p_prefix, p_hash, p_scope) RETURNING id INTO kid;
  RETURN kid;
END $$;
GRANT EXECUTE ON FUNCTION private.api_key_create(uuid, text, text, text, text) TO kritvia_app;

CREATE FUNCTION private.api_key_revoke(p_key uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH r AS (UPDATE api_keys SET revoked_at = now()
              WHERE id = p_key AND revoked_at IS NULL AND org_id = ANY (private.owned_orgs()) RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r)
$$;
GRANT EXECUTE ON FUNCTION private.api_key_revoke(uuid) TO kritvia_app;

-- Called before any user is known: the key's organisation, its maker (still an active owner of that
-- organisation), scope, and the plan that applies now. Marks it used (once a minute).
CREATE FUNCTION public.api_key_auth(p_hash text)
RETURNS TABLE (key_id uuid, org_id uuid, user_id uuid, scope text, plan text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE k api_keys;
BEGIN
  SELECT * INTO k FROM api_keys WHERE key_hash = p_hash AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM users u JOIN memberships m ON m.user_id = u.id
                  WHERE u.id = k.created_by AND u.is_active AND NOT u.is_service
                    AND m.org_id = k.org_id AND m.role = 'org_owner') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM organisations o WHERE o.id = k.org_id AND o.closed_at IS NOT NULL) THEN RETURN; END IF;
  IF k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute' THEN
    UPDATE api_keys SET last_used_at = now() WHERE id = k.id;
  END IF;
  RETURN QUERY SELECT k.id, k.org_id, k.created_by, k.scope, coalesce(private.applied_plan(k.org_id), '');
END $$;
GRANT EXECUTE ON FUNCTION public.api_key_auth(text) TO kritvia_app;

-- ----------------------------------------------------------- custom workflows --
-- A business's own agent, made in the app (Scale, Enterprise): when something happens to a record
-- (an invoice N days overdue, an invoice paid, a booking done, a new lead, a lead gone quiet N days),
-- write what the owner's instructions say, then email the customer after a yes, or tell the maker.
-- Checked once a day at at_time (India time); each record is handled once per workflow.
CREATE TABLE custom_workflows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  created_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  enabled       boolean NOT NULL DEFAULT true,
  trigger       text NOT NULL CHECK (trigger IN ('invoice_overdue', 'invoice_paid', 'booking_done', 'lead_new', 'lead_quiet')),
  wait_days     int NOT NULL DEFAULT 0 CHECK (wait_days BETWEEN 0 AND 90),
  instructions  text NOT NULL CHECK (char_length(instructions) BETWEEN 3 AND 2000),
  action        text NOT NULL CHECK (action IN ('email', 'notify')),
  at_time       text NOT NULL DEFAULT '10:00' CHECK (at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_error    text CHECK (char_length(last_error) <= 300),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX custom_workflows_due_idx ON custom_workflows (next_run_at) WHERE enabled;
SELECT private.protect_tenant_table('custom_workflows');
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_workflows TO kritvia_app;

CREATE FUNCTION private.claim_due_custom(p_now timestamptz)
RETURNS TABLE (custom_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE custom_workflows c SET next_run_at = NULL
   WHERE c.id IN (SELECT id FROM custom_workflows WHERE enabled AND next_run_at <= p_now
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING c.id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_custom(timestamptz) TO kritvia_app;

CREATE FUNCTION private.set_custom_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE custom_workflows SET next_run_at = p_next,
         last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END, last_error = p_error
   WHERE id = p_id
$$;
GRANT EXECUTE ON FUNCTION private.set_custom_next(uuid, timestamptz, text) TO kritvia_app;

CREATE FUNCTION private.custom_owner(p_custom uuid)
RETURNS TABLE (user_id uuid, email text, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.full_name FROM custom_workflows c JOIN users u ON u.id = c.created_by
   WHERE c.id = p_custom AND c.venture_id = ANY ((SELECT private.readable_ventures())::uuid[])
$$;
GRANT EXECUTE ON FUNCTION private.custom_owner(uuid) TO kritvia_app;

-- ------------------------------------------------------------------------ SSO --
-- Single sign-on with the organisation's own identity provider over OpenID Connect (Google
-- Workspace, Microsoft Entra ID, Okta, …) for one email domain the organisation proves it owns with a
-- DNS TXT record. The client secret is stored wrapped with the master key and never readable by the
-- app role. Only people who already have a Kritvia account or a pending invitation to the
-- organisation are signed in. `enforce` (people with that domain can sign in only through SSO) can
-- be switched on once an owner has signed in through it, so a wrong setup can't lock everyone out.
CREATE TABLE sso_configs (
  org_id          uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  domain          text NOT NULL UNIQUE CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
                                              AND char_length(domain) <= 200),
  issuer          text NOT NULL CHECK (issuer ~ '^https://' AND char_length(issuer) <= 300),
  client_id       text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 300),
  secret_wrapped  bytea NOT NULL,
  verify_token    text NOT NULL CHECK (char_length(verify_token) BETWEEN 16 AND 64),
  verified_at     timestamptz,
  enabled         boolean NOT NULL DEFAULT true,
  enforce         boolean NOT NULL DEFAULT false,
  owner_tested_at timestamptz,
  last_signin_at  timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sso_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY sso_configs_owner_read ON sso_configs FOR SELECT USING (org_id = ANY (private.owned_orgs()));
GRANT SELECT (org_id, domain, issuer, client_id, verify_token, verified_at, enabled, enforce, owner_tested_at,
              last_signin_at, created_by, created_at, updated_at) ON sso_configs TO kritvia_app;

-- An owner saves the settings. A new domain or identity provider must be proved and tested again.
-- p_wrapped NULL keeps the saved client secret.
CREATE FUNCTION private.sso_save(p_org uuid, p_domain text, p_issuer text, p_client_id text, p_wrapped bytea,
                                 p_token text, p_enabled boolean, p_enforce boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c sso_configs;
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'organisation not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM sso_configs WHERE org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    IF p_wrapped IS NULL THEN RAISE EXCEPTION 'the client secret is required' USING ERRCODE = 'KV409'; END IF;
    IF p_enforce THEN RAISE EXCEPTION 'sign in through SSO once before making it the only way in' USING ERRCODE = 'KV409'; END IF;
    IF EXISTS (SELECT 1 FROM sso_configs WHERE domain = lower(p_domain)) THEN
      RAISE EXCEPTION 'another organisation uses that domain for SSO' USING ERRCODE = 'KV409';
    END IF;
    INSERT INTO sso_configs (org_id, domain, issuer, client_id, secret_wrapped, verify_token, enabled, created_by)
    VALUES (p_org, lower(p_domain), p_issuer, p_client_id, p_wrapped, p_token, p_enabled, private.current_user_id());
    RETURN;
  END IF;
  IF lower(p_domain) <> c.domain AND EXISTS (SELECT 1 FROM sso_configs WHERE domain = lower(p_domain)) THEN
    RAISE EXCEPTION 'another organisation uses that domain for SSO' USING ERRCODE = 'KV409';
  END IF;
  IF lower(p_domain) <> c.domain THEN
    c.verified_at := NULL; c.verify_token := p_token; c.owner_tested_at := NULL;
  END IF;
  IF p_issuer <> c.issuer OR p_client_id <> c.client_id OR p_wrapped IS NOT NULL THEN
    c.owner_tested_at := NULL;
  END IF;
  IF p_enforce AND (c.owner_tested_at IS NULL OR NOT p_enabled) THEN
    RAISE EXCEPTION 'sign in through SSO once (as an owner) before making it the only way in' USING ERRCODE = 'KV409';
  END IF;
  UPDATE sso_configs SET domain = lower(p_domain), issuer = p_issuer, client_id = p_client_id,
         secret_wrapped = coalesce(p_wrapped, secret_wrapped), verify_token = c.verify_token,
         verified_at = c.verified_at, owner_tested_at = c.owner_tested_at,
         enabled = p_enabled, enforce = p_enforce, updated_at = now()
   WHERE org_id = p_org;
END $$;

CREATE FUNCTION private.sso_mark_verified(p_org uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sso_configs SET verified_at = now(), updated_at = now()
   WHERE org_id = p_org AND p_org = ANY (private.owned_orgs())
$$;

CREATE FUNCTION private.sso_delete(p_org uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (DELETE FROM sso_configs WHERE org_id = p_org AND p_org = ANY (private.owned_orgs()) RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM d)
$$;

-- Before anyone is signed in: the proved, switched-on SSO for an email domain, and the plan that applies.
CREATE FUNCTION public.sso_for_domain(p_domain text)
RETURNS TABLE (org_id uuid, issuer text, client_id text, secret_wrapped bytea, enforce boolean, plan text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.org_id, s.issuer, s.client_id, s.secret_wrapped, s.enforce, coalesce(private.applied_plan(s.org_id), '')
    FROM sso_configs s JOIN organisations o ON o.id = s.org_id
   WHERE s.domain = lower(p_domain) AND s.verified_at IS NOT NULL AND s.enabled AND o.closed_at IS NULL
$$;

-- The identity provider of p_org vouched for this address: sign the person in if they already have
-- an account or a pending invitation to the organisation. NULL otherwise.
CREATE FUNCTION public.auth_signin_sso(p_org uuid, p_email text, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users; uid uuid;
BEGIN
  SELECT * INTO u FROM users WHERE lower(email) = lower(p_email) FOR UPDATE;
  IF FOUND THEN
    IF NOT u.is_active OR u.is_service THEN RETURN NULL; END IF;
    PERFORM private.claim_unverified(u);
    UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = u.id;
    uid := u.id;
  ELSIF EXISTS (SELECT 1 FROM invitations WHERE org_id = p_org AND lower(email) = lower(p_email)
                   AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) THEN
    INSERT INTO users (email, full_name, email_verified_at)
    VALUES (lower(p_email), left(coalesce(p_name, ''), 120), now()) RETURNING id INTO uid;
  ELSE
    RETURN NULL;
  END IF;
  UPDATE sso_configs SET last_signin_at = now(),
         owner_tested_at = CASE WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p_org AND m.user_id = uid
                                               AND m.role = 'org_owner') THEN now() ELSE owner_tested_at END
   WHERE org_id = p_org;
  RETURN uid;
END $$;

GRANT EXECUTE ON FUNCTION private.sso_save(uuid, text, text, text, bytea, text, boolean, boolean),
  private.sso_mark_verified(uuid), private.sso_delete(uuid), public.sso_for_domain(text),
  public.auth_signin_sso(uuid, text, text) TO kritvia_app;
