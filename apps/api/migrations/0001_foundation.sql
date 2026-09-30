-- =============================================================================
-- Kritvia 0001 — Foundation: tenancy, RBAC, grants, RLS, hash-chained audit log
--
-- Runs as kritvia_owner (table owner). The API connects as kritvia_app, which
-- is NOBYPASSRLS and never owns tables, so every query it runs is filtered by
-- the policies below. Application code is NOT the only line of defence.
--
-- Request context (set per transaction with set_config(..., true)):
--   app.user_id     uuid of the authenticated user
--   app.actor_type  'user' | 'agent' | 'system'
--   app.agent_id    optional agent identifier when actor_type = 'agent'
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO kritvia_app;

-- ---------------------------------------------------------------------------
-- Context helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION private.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION private.current_actor_type() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.actor_type', true), ''), 'user')
$$;

-- ---------------------------------------------------------------------------
-- Identity & tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE organisations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ventures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug),
  UNIQUE (org_id, id)          -- target for composite FKs: (org_id, venture_id)
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  full_name      text NOT NULL DEFAULT '',
  password_hash  text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE roles (
  name         text PRIMARY KEY,
  scope        text NOT NULL CHECK (scope IN ('org', 'venture')),
  can_write    boolean NOT NULL,
  can_approve  boolean NOT NULL,
  description  text NOT NULL
);

INSERT INTO roles (name, scope, can_write, can_approve, description) VALUES
  ('org_owner',       'org',     true,  true,  'Owns the organisation; manages ventures, members and grants'),
  ('venture_admin',   'venture', true,  true,  'Administers one venture'),
  ('operator',        'venture', true,  false, 'Runs workflows and edits venture data'),
  ('approver',        'venture', false, true,  'Approves agent drafts; read-only otherwise'),
  ('viewer',          'venture', false, false, 'Read-only'),
  ('kitchen_manager', 'venture', true,  true,  'Cloud kitchen: approves prep lists and POs'),
  ('loan_officer',    'venture', true,  true,  'Truhome: reviews loan documents and client follow-ups');

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  venture_id  uuid,                         -- NULL = org-level role
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL REFERENCES roles(name),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX memberships_uq
  ON memberships (user_id, org_id, coalesce(venture_id, '00000000-0000-0000-0000-000000000000'::uuid), role);
CREATE INDEX memberships_venture_idx ON memberships (venture_id);

-- Role scope must match: org roles have no venture, venture roles need one.
CREATE FUNCTION private.check_membership_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r_scope text;
BEGIN
  SELECT scope INTO r_scope FROM roles WHERE name = NEW.role;
  IF r_scope = 'org' AND NEW.venture_id IS NOT NULL THEN
    RAISE EXCEPTION 'role % is org-scoped and cannot target a venture', NEW.role;
  ELSIF r_scope = 'venture' AND NEW.venture_id IS NULL THEN
    RAISE EXCEPTION 'role % is venture-scoped and requires venture_id', NEW.role;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_scope BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION private.check_membership_scope();

-- Explicit, revocable, audited cross-venture access. This is the ONLY way an
-- executive sees across ventures — there is no bypass role in app code.
CREATE TABLE grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  grantee_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access           text NOT NULL CHECK (access IN ('read', 'write')),
  granted_by       uuid REFERENCES users(id),
  reason           text NOT NULL DEFAULT '',
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  UNIQUE (venture_id, grantee_user_id, access)
);
CREATE INDEX grants_grantee_idx ON grants (grantee_user_id);

-- ---------------------------------------------------------------------------
-- Access resolution. SECURITY DEFINER so it can read memberships/grants
-- without recursing into their own RLS; it only ever answers for the caller.
-- ---------------------------------------------------------------------------
CREATE FUNCTION private.readable_ventures() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT v), '{}') FROM (
    SELECT m.venture_id AS v FROM memberships m
      WHERE m.user_id = private.current_user_id() AND m.venture_id IS NOT NULL
    UNION
    SELECT g.venture_id FROM grants g
      WHERE g.grantee_user_id = private.current_user_id()
        AND (g.expires_at IS NULL OR g.expires_at > now())
  ) s
$$;

CREATE FUNCTION private.writable_ventures() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT v), '{}') FROM (
    SELECT m.venture_id AS v FROM memberships m JOIN roles r ON r.name = m.role
      WHERE m.user_id = private.current_user_id() AND m.venture_id IS NOT NULL AND r.can_write
    UNION
    SELECT g.venture_id FROM grants g
      WHERE g.grantee_user_id = private.current_user_id() AND g.access = 'write'
        AND (g.expires_at IS NULL OR g.expires_at > now())
  ) s
$$;

CREATE FUNCTION private.member_orgs() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT org_id), '{}') FROM memberships
  WHERE user_id = private.current_user_id()
$$;

CREATE FUNCTION private.owned_orgs() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT org_id), '{}') FROM memberships
  WHERE user_id = private.current_user_id() AND role = 'org_owner'
$$;

-- ---------------------------------------------------------------------------
-- Hash-chained, append-only audit log (one chain per organisation)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         uuid NOT NULL,
  seq            bigint NOT NULL,
  venture_id     uuid,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type     text NOT NULL,
  actor_user_id  uuid,
  actor_agent    text,
  action         text NOT NULL,
  entity_table   text,
  entity_id      text,
  details        jsonb NOT NULL DEFAULT '{}',
  prev_hash      bytea,
  row_hash       bytea NOT NULL,
  UNIQUE (org_id, seq)
);
CREATE INDEX audit_log_venture_idx ON audit_log (venture_id, occurred_at DESC);

-- Canonical serialisation. jsonb::text is normalised by Postgres, so this is
-- deterministic. Any external verifier must reproduce exactly this string.
CREATE FUNCTION private.audit_canonical(a audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    a.org_id::text, a.seq::text, coalesce(a.venture_id::text, ''),
    to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    a.actor_type, coalesce(a.actor_user_id::text, ''), coalesce(a.actor_agent, ''),
    a.action, coalesce(a.entity_table, ''), coalesce(a.entity_id, ''),
    a.details::text)
$$;

CREATE FUNCTION private.audit_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE last_row record;
BEGIN
  -- Serialise chain extension per org. Released at commit, so the next writer
  -- always sees the committed tail.
  PERFORM pg_advisory_xact_lock(hashtextextended('kritvia.audit.' || NEW.org_id::text, 0));
  SELECT seq, row_hash INTO last_row FROM audit_log
    WHERE org_id = NEW.org_id ORDER BY seq DESC LIMIT 1;
  NEW.seq         := coalesce(last_row.seq, 0) + 1;
  NEW.prev_hash   := last_row.row_hash;
  NEW.occurred_at := clock_timestamp();
  NEW.row_hash    := sha256(coalesce(NEW.prev_hash, ''::bytea)
                            || convert_to(private.audit_canonical(NEW), 'UTF8'));
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION private.audit_chain();

CREATE FUNCTION private.audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION private.audit_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION private.audit_immutable();

-- Returns the first seq whose hash does not verify, or NULL if the chain is intact.
CREATE FUNCTION private.audit_verify(p_org uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a audit_log; expected_prev bytea := NULL; expected_seq bigint := 1;
BEGIN
  FOR a IN SELECT * FROM audit_log WHERE org_id = p_org ORDER BY seq LOOP
    IF a.seq <> expected_seq
       OR a.prev_hash IS DISTINCT FROM expected_prev
       OR a.row_hash <> sha256(coalesce(a.prev_hash, ''::bytea)
                               || convert_to(private.audit_canonical(a), 'UTF8')) THEN
      RETURN a.seq;
    END IF;
    expected_prev := a.row_hash;
    expected_seq  := a.seq + 1;
  END LOOP;
  RETURN NULL;
END $$;

-- Explicit application events (logins, approvals, model calls, sensitive reads).
CREATE FUNCTION public.audit_event(
  p_org uuid, p_venture uuid, p_action text,
  p_entity_table text DEFAULT NULL, p_entity_id text DEFAULT NULL,
  p_details jsonb DEFAULT '{}'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_org IS NULL OR NOT (p_org = ANY (private.member_orgs())) THEN
    RAISE EXCEPTION 'audit_event: caller is not a member of org %', p_org;
  END IF;
  IF p_venture IS NOT NULL AND NOT (p_venture = ANY (private.readable_ventures())) THEN
    RAISE EXCEPTION 'audit_event: caller cannot access venture %', p_venture;
  END IF;
  INSERT INTO audit_log (org_id, venture_id, actor_type, actor_user_id, actor_agent,
                         action, entity_table, entity_id, details, row_hash)
  VALUES (p_org, p_venture, private.current_actor_type(), private.current_user_id(),
          nullif(current_setting('app.agent_id', true), ''),
          p_action, p_entity_table, p_entity_id, coalesce(p_details, '{}'), ''::bytea);
END $$;

-- Generic row-change auditing. Records WHICH columns changed, never the values,
-- so sensitive data does not leak into the log.
CREATE FUNCTION private.audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rec jsonb; old_rec jsonb; v_org uuid; v_venture uuid; changed text[];
BEGIN
  rec     := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  old_rec := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;

  IF TG_TABLE_NAME = 'organisations' THEN
    v_org := (rec->>'id')::uuid;
  ELSE
    v_org := (rec->>'org_id')::uuid;
  END IF;
  IF TG_TABLE_NAME = 'ventures' THEN
    v_venture := (rec->>'id')::uuid;
  ELSE
    v_venture := nullif(rec->>'venture_id', '')::uuid;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
      FROM jsonb_object_keys(rec) k
      WHERE rec->k IS DISTINCT FROM old_rec->k;
  ELSE
    SELECT array_agg(k ORDER BY k) INTO changed FROM jsonb_object_keys(rec) k;
  END IF;

  INSERT INTO audit_log (org_id, venture_id, actor_type, actor_user_id, actor_agent,
                         action, entity_table, entity_id, details, row_hash)
  VALUES (v_org, v_venture, private.current_actor_type(), private.current_user_id(),
          nullif(current_setting('app.agent_id', true), ''),
          TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME, rec->>'id',
          jsonb_build_object('columns', coalesce(to_jsonb(changed), '[]'::jsonb)),
          ''::bytea);
  RETURN NULL;
END $$;

CREATE FUNCTION private.attach_audit(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION private.audit_row_change()',
    'audit_' || replace(p_table::text, '.', '_'), p_table);
END $$;

SELECT private.attach_audit('organisations');
SELECT private.attach_audit('ventures');
SELECT private.attach_audit('memberships');
SELECT private.attach_audit('grants');

-- ---------------------------------------------------------------------------
-- Security-definer entry points for tenancy writes. The app role has no direct
-- INSERT on organisations/ventures/memberships/grants.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.create_organisation(p_name text, p_slug text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid; v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  INSERT INTO organisations (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_org;
  INSERT INTO memberships (org_id, user_id, role) VALUES (v_org, v_user, 'org_owner');
  RETURN v_org;
END $$;

CREATE FUNCTION public.create_venture(p_org uuid, p_name text, p_slug text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_venture uuid; v_user uuid := private.current_user_id();
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'only an org_owner can create ventures' USING ERRCODE = '42501';
  END IF;
  INSERT INTO ventures (org_id, name, slug) VALUES (p_org, p_name, p_slug)
    RETURNING id INTO v_venture;
  -- The creating owner gets an EXPLICIT, visible, revocable write grant.
  INSERT INTO grants (org_id, venture_id, grantee_user_id, access, granted_by, reason)
    VALUES (p_org, v_venture, v_user, 'write', v_user, 'venture creator');
  RETURN v_venture;
END $$;

CREATE FUNCTION public.add_member(p_org uuid, p_venture uuid, p_user uuid, p_role text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'only an org_owner can add members' USING ERRCODE = '42501';
  END IF;
  INSERT INTO memberships (org_id, venture_id, user_id, role)
    VALUES (p_org, p_venture, p_user, p_role) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.grant_access(p_org uuid, p_venture uuid, p_user uuid,
                                    p_access text, p_reason text,
                                    p_expires timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'only an org_owner can grant access' USING ERRCODE = '42501';
  END IF;
  INSERT INTO grants (org_id, venture_id, grantee_user_id, access, granted_by, reason, expires_at)
    VALUES (p_org, p_venture, p_user, p_access, private.current_user_id(), p_reason, p_expires)
    ON CONFLICT (venture_id, grantee_user_id, access)
    DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION public.revoke_access(p_grant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM grants
   WHERE id = p_grant AND org_id = ANY (private.owned_orgs());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant not found or not permitted' USING ERRCODE = '42501';
  END IF;
END $$;

-- Login needs to find a user before a user context exists.
CREATE FUNCTION public.auth_lookup(p_email text)
RETURNS TABLE (id uuid, password_hash text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.password_hash, u.is_active FROM users u WHERE lower(u.email) = lower(p_email)
$$;

CREATE FUNCTION public.auth_register(p_email text, p_name text, p_hash text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO users (email, full_name, password_hash) VALUES (p_email, p_name, p_hash)
  RETURNING id
$$;

-- ---------------------------------------------------------------------------
-- Tenant-owned tables (Phase 1 set). Every one carries org_id + venture_id,
-- a composite FK to ventures, RLS, FORCE RLS, and the audit trigger.
-- ---------------------------------------------------------------------------

-- Wrapped per-venture data-encryption keys (envelope encryption).
CREATE TABLE tenant_keys (
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  key_version  int  NOT NULL,
  wrapped_dek  bytea NOT NULL,
  kek_id       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, key_version),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

-- Leads (first venture workflow table; used by the Sitelytc triage workflow).
CREATE TABLE leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  name         text NOT NULL,
  email        text,
  company      text,
  source       text NOT NULL DEFAULT 'manual',
  status       text NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'qualified', 'proposal', 'won', 'lost', 'archived')),
  score        int CHECK (score BETWEEN 0 AND 100),
  notes_enc    bytea,                 -- encrypted with the venture DEK
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX leads_venture_status_idx ON leads (venture_id, status, created_at DESC);

-- Model-call metering (metadata only; never prompt or completion content).
CREATE TABLE model_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  venture_id         uuid NOT NULL,
  workflow           text,
  tier               text NOT NULL,
  provider_model     text,
  attempt            int NOT NULL DEFAULT 1,
  status             text NOT NULL CHECK (status IN ('ok', 'rate_limited', 'error', 'blocked')),
  prompt_tokens      int,
  completion_tokens  int,
  latency_ms         int,
  cost_usd           numeric(12, 6),
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX model_calls_venture_time_idx ON model_calls (venture_id, created_at DESC);

-- Registry used by tests to prove every tenant table is protected.
CREATE TABLE private.tenant_tables (table_name text PRIMARY KEY);

CREATE FUNCTION private.protect_tenant_table(p_table text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format($p$CREATE POLICY tenant_select ON %I FOR SELECT
                   USING (venture_id = ANY ((SELECT private.readable_ventures())::uuid[])) $p$, p_table);
  EXECUTE format($p$CREATE POLICY tenant_insert ON %I FOR INSERT
                   WITH CHECK (venture_id = ANY ((SELECT private.writable_ventures())::uuid[])) $p$, p_table);
  EXECUTE format($p$CREATE POLICY tenant_update ON %I FOR UPDATE
                   USING (venture_id = ANY ((SELECT private.writable_ventures())::uuid[]))
                   WITH CHECK (venture_id = ANY ((SELECT private.writable_ventures())::uuid[])) $p$, p_table);
  EXECUTE format($p$CREATE POLICY tenant_delete ON %I FOR DELETE
                   USING (venture_id = ANY ((SELECT private.writable_ventures())::uuid[])) $p$, p_table);
  PERFORM private.attach_audit(p_table::regclass);
  INSERT INTO private.tenant_tables VALUES (p_table) ON CONFLICT DO NOTHING;
END $$;

SELECT private.protect_tenant_table('tenant_keys');
SELECT private.protect_tenant_table('leads');
SELECT private.protect_tenant_table('model_calls');

-- Keys are versioned, never edited in place.
DROP POLICY tenant_update ON tenant_keys;

-- ---------------------------------------------------------------------------
-- RLS on tenancy tables
-- ---------------------------------------------------------------------------
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_select ON organisations FOR SELECT
  USING (id = ANY ((SELECT private.member_orgs())::uuid[]));

ALTER TABLE ventures ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventures FORCE ROW LEVEL SECURITY;
CREATE POLICY venture_select ON ventures FOR SELECT
  USING (id = ANY ((SELECT private.readable_ventures())::uuid[])
         OR org_id = ANY ((SELECT private.owned_orgs())::uuid[]));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users FOR SELECT
  USING (id = private.current_user_id());
CREATE POLICY users_colleagues ON users FOR SELECT
  USING (id IN (SELECT m.user_id FROM memberships m
                WHERE m.org_id = ANY ((SELECT private.member_orgs())::uuid[])));
CREATE POLICY users_update_self ON users FOR UPDATE
  USING (id = private.current_user_id()) WITH CHECK (id = private.current_user_id());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (user_id = private.current_user_id()
         OR org_id = ANY ((SELECT private.owned_orgs())::uuid[]));

ALTER TABLE grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE grants FORCE ROW LEVEL SECURITY;
CREATE POLICY grants_select ON grants FOR SELECT
  USING (grantee_user_id = private.current_user_id()
         OR org_id = ANY ((SELECT private.owned_orgs())::uuid[]));

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT
  USING (venture_id = ANY ((SELECT private.readable_ventures())::uuid[])
         OR org_id = ANY ((SELECT private.owned_orgs())::uuid[]));

-- ---------------------------------------------------------------------------
-- Privileges for the application role
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM kritvia_app;
GRANT SELECT ON organisations, ventures, memberships, grants, roles, audit_log TO kritvia_app;
GRANT SELECT, UPDATE (full_name) ON users TO kritvia_app;
GRANT SELECT, INSERT ON tenant_keys TO kritvia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO kritvia_app;
GRANT SELECT, INSERT ON model_calls TO kritvia_app;

GRANT EXECUTE ON FUNCTION private.current_user_id(), private.current_actor_type(),
  private.readable_ventures(), private.writable_ventures(),
  private.member_orgs(), private.owned_orgs(), private.audit_verify(uuid) TO kritvia_app;
GRANT EXECUTE ON FUNCTION public.audit_event(uuid, uuid, text, text, text, jsonb),
  public.create_organisation(text, text), public.create_venture(uuid, text, text),
  public.add_member(uuid, uuid, uuid, text),
  public.grant_access(uuid, uuid, uuid, text, text, timestamptz),
  public.revoke_access(uuid), public.auth_lookup(text),
  public.auth_register(text, text, text) TO kritvia_app;
