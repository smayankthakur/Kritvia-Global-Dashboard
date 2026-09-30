-- =============================================================================
-- Kritvia 0006 — Security hardening from the pre-dogfood review.
--   * invitations replace add-by-email for people not yet in the org (no invite squatting)
--   * tokens issued before a password change are rejected (password_changed_at)
--   * password hashes are no longer readable by the app role
--   * approvals: execution stamp is immutable; inserts cannot pre-decide or auto-approve sensitive drafts
--   * connector credentials writable only by venture admins and the agent runtime
--   * restricted and unrestricted entities with the same name are separate rows (no existence oracle)
-- =============================================================================

-- ------------------------------------------------------------------ users --
ALTER TABLE users ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now();

REVOKE SELECT ON users FROM kritvia_app;
GRANT SELECT (id, email, full_name, is_active, is_service, created_at, password_changed_at) ON users TO kritvia_app;

CREATE OR REPLACE FUNCTION public.auth_set_password(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET password_hash = p_hash, password_changed_at = clock_timestamp()
   WHERE id = private.current_user_id() AND NOT is_service;
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = private.current_user_id();
$$;

-- ------------------------------------------------------------ invitations --
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  venture_id   uuid,
  email        text NOT NULL,
  role         text NOT NULL REFERENCES roles(name),
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  accepted_by  uuid REFERENCES users(id),
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_owner ON invitations FOR SELECT
  USING (org_id = ANY ((SELECT private.owned_orgs())::uuid[]));
SELECT private.attach_audit('invitations');
GRANT SELECT ON invitations TO kritvia_app;

CREATE FUNCTION public.create_invitation(p_org uuid, p_venture uuid, p_email text, p_role text,
                                         p_token_hash text, p_days int)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; r_scope text;
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'only an org_owner can invite' USING ERRCODE = '42501';
  END IF;
  SELECT scope INTO r_scope FROM roles WHERE name = p_role;
  IF r_scope IS NULL OR p_role IN ('agent_runtime', 'org_owner') THEN
    RAISE EXCEPTION 'role % cannot be granted by invitation', p_role USING ERRCODE = 'KV409';
  END IF;
  IF (r_scope = 'venture') <> (p_venture IS NOT NULL) THEN
    RAISE EXCEPTION 'role % scope mismatch', p_role USING ERRCODE = 'KV409';
  END IF;
  INSERT INTO invitations (org_id, venture_id, email, role, token_hash, invited_by, expires_at)
    VALUES (p_org, p_venture, lower(p_email), p_role, p_token_hash, private.current_user_id(),
            now() + make_interval(days => greatest(1, least(p_days, 30))))
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Accepting needs BOTH the secret token (delivered out of band to the invitee)
-- AND a signed-in account with the invited email.
CREATE FUNCTION public.accept_invitation(p_token_hash text)
RETURNS TABLE (org_id uuid, venture_id uuid, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i invitations; v_user uuid := private.current_user_id(); v_email text;
BEGIN
  SELECT lower(u.email) INTO v_email FROM users u WHERE u.id = v_user AND NOT u.is_service AND u.is_active;
  SELECT * INTO i FROM invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR i.revoked_at IS NOT NULL OR i.expires_at < now() OR i.accepted_at IS NOT NULL
     OR v_email IS NULL THEN
    RAISE EXCEPTION 'invitation not found or expired' USING ERRCODE = '42501';
  END IF;
  IF v_email <> i.email THEN
    RAISE EXCEPTION 'this invitation was sent to a different email address' USING ERRCODE = 'KV409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = v_user AND m.org_id = i.org_id
                   AND m.venture_id IS NOT DISTINCT FROM i.venture_id AND m.role = i.role) THEN
    INSERT INTO memberships (org_id, venture_id, user_id, role) VALUES (i.org_id, i.venture_id, v_user, i.role);
  END IF;
  UPDATE invitations SET accepted_by = v_user, accepted_at = now() WHERE id = i.id;
  RETURN QUERY SELECT i.org_id, i.venture_id, i.role;
END $$;

CREATE FUNCTION public.revoke_invitation(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE invitations SET revoked_at = now()
   WHERE id = p_id AND org_id = ANY (private.owned_orgs()) AND accepted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not found' USING ERRCODE = '42501';
  END IF;
END $$;

-- Direct add is limited to people already in the organisation (or yourself):
-- anyone else must come through an invitation.
CREATE OR REPLACE FUNCTION public.add_member(p_org uuid, p_venture uuid, p_user uuid, p_role text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'only an org_owner can add members' USING ERRCODE = '42501';
  END IF;
  IF p_role = 'agent_runtime' THEN
    RAISE EXCEPTION 'agent_runtime is managed by the system' USING ERRCODE = 'KV409';
  END IF;
  IF p_user <> private.current_user_id() AND NOT EXISTS (
       SELECT 1 FROM memberships WHERE org_id = p_org AND user_id = p_user) THEN
    RAISE EXCEPTION 'this person is not in the organisation yet: send an invitation' USING ERRCODE = 'KV409';
  END IF;
  INSERT INTO memberships (org_id, venture_id, user_id, role)
    VALUES (p_org, p_venture, p_user, p_role) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Colleague lookup for add_member without revealing whether an email is registered
-- to someone who does not own the org.
CREATE FUNCTION public.org_member_by_email(p_org uuid, p_email text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id FROM users u
   WHERE p_org = ANY (private.owned_orgs()) AND lower(u.email) = lower(p_email) AND NOT u.is_service
     AND (u.id = private.current_user_id()
          OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p_org AND m.user_id = u.id))
$$;

GRANT EXECUTE ON FUNCTION public.create_invitation(uuid, uuid, text, text, text, int),
  public.accept_invitation(text), public.revoke_invitation(uuid),
  public.org_member_by_email(uuid, text) TO kritvia_app;

-- --------------------------------------------------------------- approvals --
CREATE OR REPLACE FUNCTION private.guard_approval_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'kritvia_app' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'pending' AND NEW.status IN ('cancelled', 'expired')) THEN
      RAISE EXCEPTION 'approval status can only change through decide_approval()' USING ERRCODE = '42501';
    END IF;
    IF OLD.executed_at IS NOT NULL AND NEW.executed_at IS DISTINCT FROM OLD.executed_at THEN
      RAISE EXCEPTION 'approval already executed' USING ERRCODE = 'KV409';
    END IF;
    IF NEW.executed_at IS NOT NULL AND OLD.executed_at IS NULL
       AND OLD.status NOT IN ('approved', 'edited', 'auto_approved') THEN
      RAISE EXCEPTION 'cannot execute an undecided or rejected approval' USING ERRCODE = '42501';
    END IF;
    IF NEW.payload_enc IS DISTINCT FROM OLD.payload_enc
       OR NEW.final_payload_enc IS DISTINCT FROM OLD.final_payload_enc
       OR NEW.required_roles IS DISTINCT FROM OLD.required_roles
       OR NEW.sensitive IS DISTINCT FROM OLD.sensitive
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.action IS DISTINCT FROM OLD.action OR NEW.agent IS DISTINCT FROM OLD.agent THEN
      RAISE EXCEPTION 'approval content is immutable' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION private.guard_approval_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status NOT IN ('pending', 'auto_approved') THEN
    RAISE EXCEPTION 'approvals must be created pending' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'auto_approved' AND (NEW.sensitive OR NOT EXISTS (
       SELECT 1 FROM agent_trust t WHERE t.venture_id = NEW.venture_id AND t.agent = NEW.agent
          AND t.action = NEW.action AND t.auto_run)) THEN
    RAISE EXCEPTION 'action %/% may not be auto-approved', NEW.agent, NEW.action USING ERRCODE = '42501';
  END IF;
  IF NEW.required_roles IS NULL OR cardinality(NEW.required_roles) = 0
     OR NOT (NEW.required_roles <@ ARRAY(SELECT name FROM roles WHERE can_approve)) THEN
    RAISE EXCEPTION 'required_roles must be approving roles' USING ERRCODE = '42501';
  END IF;
  -- decisions and execution are never supplied by the inserter
  NEW.decided_by := NULL; NEW.comment := NULL; NEW.executed_at := NULL; NEW.execution_result := NULL;
  IF NEW.status = 'auto_approved' THEN
    NEW.final_payload_enc := NEW.payload_enc;
    NEW.decided_at := now();
  ELSE
    NEW.final_payload_enc := NULL;
    NEW.decided_at := NULL;
  END IF;
  RETURN NEW;
END $$;

-- -------------------------------------------------------------- connectors --
CREATE POLICY connectors_write ON connectors AS RESTRICTIVE FOR INSERT
  WITH CHECK (private.is_service_user() OR private.can_admin_venture(venture_id));
CREATE POLICY connectors_update ON connectors AS RESTRICTIVE FOR UPDATE
  USING (private.is_service_user() OR private.can_admin_venture(venture_id));
CREATE POLICY connectors_delete ON connectors AS RESTRICTIVE FOR DELETE
  USING (private.is_service_user() OR private.can_admin_venture(venture_id));
CREATE POLICY connector_tokens_write ON connector_tokens AS RESTRICTIVE FOR INSERT
  WITH CHECK (private.is_service_user() OR private.can_admin_venture(venture_id));
CREATE POLICY connector_tokens_update ON connector_tokens AS RESTRICTIVE FOR UPDATE
  USING (private.is_service_user() OR private.can_admin_venture(venture_id));
CREATE POLICY connector_tokens_delete ON connector_tokens AS RESTRICTIVE FOR DELETE
  USING (private.is_service_user() OR private.can_admin_venture(venture_id));

-- ---------------------------------------------------------------- entities --
CREATE FUNCTION private.roles_key(p_roles text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT coalesce(array_to_string(p_roles, ','), '') $$;
GRANT EXECUTE ON FUNCTION private.roles_key(text[]) TO kritvia_app;
ALTER TABLE entities DROP CONSTRAINT entities_venture_id_type_canonical_key;
CREATE UNIQUE INDEX entities_identity_uq ON entities (venture_id, type, canonical, (private.roles_key(access_roles)));

-- Execution of maintenance functions is the worker's business only (callable, but
-- they act only on due data); keep the audit writer and verifier as they are.
