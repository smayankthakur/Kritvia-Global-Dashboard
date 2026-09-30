-- =============================================================================
-- Kritvia 0005 — DPDP Act foundations and session security.
--
-- consents          purpose-bound consent records (notice version, evidence, withdrawal)
-- dpdp_requests     data-principal requests (access / correction / erasure / grievance)
--                   tracked as work items with a statutory due date
-- retention_policies per data class; the worker purges expired documents daily
-- breach_register   incidents, board/principal notification timestamps
-- refresh_tokens    rotating refresh tokens with reuse detection (token families)
--
-- Data principals are referenced by a keyed hash (HMAC with a key derived from
-- the master KEK), never by raw email/phone/PAN, so these tables are not
-- themselves a directory of people.
-- =============================================================================

CREATE TABLE consents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  data_principal   text NOT NULL,
  principal_label  text NOT NULL,           -- masked, e.g. "S**** S****" / "s***@gmail.com"
  purpose          text NOT NULL CHECK (purpose ~ '^[a-z0-9_]{2,60}$'),
  lawful_basis     text NOT NULL DEFAULT 'consent' CHECK (lawful_basis IN ('consent', 'legitimate_use')),
  notice_version   text NOT NULL,
  channel          text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'email', 'paper', 'whatsapp', 'verbal')),
  evidence_doc_id  uuid,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  withdrawn_at     timestamptz,
  recorded_by      uuid REFERENCES users(id),
  UNIQUE (venture_id, id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX consents_principal_idx ON consents (venture_id, data_principal, purpose);

CREATE TABLE dpdp_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  data_principal   text NOT NULL,
  principal_label  text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('access', 'correction', 'erasure', 'grievance', 'nomination')),
  status           text NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'verifying', 'in_progress', 'completed', 'rejected')),
  details_enc      bytea,
  resolution       text,
  due_at           timestamptz NOT NULL DEFAULT now() + interval '30 days',
  handled_by       uuid REFERENCES users(id),
  result           jsonb NOT NULL DEFAULT '{}',   -- counts of records exported/erased
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE retention_policies (
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  data_class   text NOT NULL CHECK (data_class IN ('upload', 'email', 'drive', 'transcript', 'meeting', 'note',
                                                   'proposal', 'loan_document', 'report')),
  retain_days  int NOT NULL CHECK (retain_days BETWEEN 1 AND 36500),
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, data_class),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE breach_register (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL,
  venture_id             uuid NOT NULL,
  detected_at            timestamptz NOT NULL,
  summary                text NOT NULL,
  severity               text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  affected_principals    int,
  data_classes           text[] NOT NULL DEFAULT '{}',
  containment            text,
  board_notified_at      timestamptz,
  principals_notified_at timestamptz,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'contained', 'closed')),
  recorded_by            uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

SELECT private.protect_tenant_table(t) FROM unnest(ARRAY[
  'consents', 'dpdp_requests', 'retention_policies', 'breach_register']) t;

-- Stamp delete_after on new documents from the venture's retention policy.
CREATE FUNCTION private.apply_retention() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d int;
BEGIN
  IF NEW.delete_after IS NULL THEN
    SELECT retain_days INTO d FROM retention_policies
     WHERE venture_id = NEW.venture_id AND data_class = NEW.kind;
    IF d IS NOT NULL THEN
      NEW.delete_after := NEW.created_at + make_interval(days => d);
      NEW.retention_class := NEW.kind || ':' || d || 'd';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_retention BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION private.apply_retention();

-- Daily purge (worker). Deletes cascade to chunks, facts, edges, loan_documents;
-- each delete is audited by the row trigger with actor 'system'.
CREATE FUNCTION private.purge_expired_documents(p_limit int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  WITH doomed AS (
    SELECT id FROM documents WHERE delete_after IS NOT NULL AND delete_after < now()
     ORDER BY delete_after LIMIT p_limit)
  DELETE FROM documents d USING doomed WHERE d.id = doomed.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- Refresh tokens (not tenant data: RLS on, no app policies; functions only)
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  used_at      timestamptz,
  revoked_at   timestamptz,
  user_agent   text
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.auth_issue_refresh(p_user uuid, p_hash text, p_days int, p_agent text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent)
  SELECT u.id, gen_random_uuid(), p_hash, now() + make_interval(days => p_days), left(p_agent, 200)
    FROM users u WHERE u.id = p_user AND u.is_active AND NOT u.is_service
  RETURNING family_id
$$;

-- Rotation with reuse detection: presenting an already-used token revokes the
-- whole family (the token was stolen, or the client is broken — either way, log in again).
CREATE FUNCTION public.auth_rotate_refresh(p_hash text, p_new_hash text, p_days int)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t refresh_tokens; ok boolean;
BEGIN
  SELECT * INTO t FROM refresh_tokens WHERE token_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL THEN
    UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id = t.family_id;
    RETURN NULL;
  END IF;
  IF t.expires_at < now() THEN RETURN NULL; END IF;
  SELECT u.is_active AND NOT u.is_service INTO ok FROM users u WHERE u.id = t.user_id;
  IF NOT coalesce(ok, false) THEN RETURN NULL; END IF;
  UPDATE refresh_tokens SET used_at = now() WHERE id = t.id;
  INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent)
    VALUES (t.user_id, t.family_id, p_new_hash, now() + make_interval(days => p_days), t.user_agent);
  RETURN t.user_id;
END $$;

CREATE FUNCTION public.auth_revoke_refresh(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now())
   WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = p_hash)
$$;

-- Revoking your own only access path to a venture would lock you out of it.
CREATE OR REPLACE FUNCTION public.revoke_access(p_grant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g grants;
BEGIN
  SELECT * INTO g FROM grants WHERE id = p_grant AND org_id = ANY (private.owned_orgs());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant not found or not permitted' USING ERRCODE = '42501';
  END IF;
  IF g.grantee_user_id = private.current_user_id() AND NOT EXISTS (
       SELECT 1 FROM memberships m WHERE m.user_id = g.grantee_user_id AND m.venture_id = g.venture_id)
     AND NOT EXISTS (SELECT 1 FROM grants o WHERE o.id <> g.id AND o.grantee_user_id = g.grantee_user_id
                       AND o.venture_id = g.venture_id AND (o.expires_at IS NULL OR o.expires_at > now())) THEN
    RAISE EXCEPTION 'revoking this grant would remove your own access to the venture' USING ERRCODE = 'KV409';
  END IF;
  DELETE FROM grants WHERE id = p_grant;
END $$;

CREATE FUNCTION public.auth_set_password(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET password_hash = p_hash WHERE id = private.current_user_id() AND NOT is_service;
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = private.current_user_id();
$$;

-- Memberships of the caller with venture + role names (for the UI's venture switcher).
CREATE FUNCTION public.my_access()
RETURNS TABLE (org_id uuid, org_name text, venture_id uuid, venture_name text, venture_slug text,
               kind text, roles text[], access text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH v AS (SELECT unnest(private.readable_ventures()) AS id)
  SELECT o.id, o.name, ve.id, ve.name, ve.slug, coalesce(s.kind, 'general'),
         coalesce((SELECT array_agg(m.role ORDER BY m.role) FROM memberships m
                    WHERE m.user_id = private.current_user_id() AND m.venture_id = ve.id), '{}'),
         CASE WHEN ve.id = ANY (private.writable_ventures()) THEN 'write' ELSE 'read' END
    FROM v JOIN ventures ve ON ve.id = v.id JOIN organisations o ON o.id = ve.org_id
    LEFT JOIN venture_settings s ON s.venture_id = ve.id
   ORDER BY o.name, ve.name
$$;

CREATE FUNCTION public.remove_member(p_membership uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m memberships; svc boolean;
BEGIN
  SELECT * INTO m FROM memberships WHERE id = p_membership;
  IF NOT FOUND OR NOT (m.org_id = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'membership not found' USING ERRCODE = '42501';
  END IF;
  SELECT is_service INTO svc FROM users WHERE id = m.user_id;
  IF svc THEN
    RAISE EXCEPTION 'the agent runtime account cannot be removed' USING ERRCODE = 'KV409';
  END IF;
  IF m.role = 'org_owner' AND (SELECT count(*) FROM memberships
                                WHERE org_id = m.org_id AND role = 'org_owner') <= 1 THEN
    RAISE EXCEPTION 'an organisation needs at least one owner' USING ERRCODE = 'KV409';
  END IF;
  DELETE FROM memberships WHERE id = p_membership;
END $$;

GRANT SELECT, INSERT, UPDATE ON consents, dpdp_requests, breach_register TO kritvia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON retention_policies TO kritvia_app;
GRANT EXECUTE ON FUNCTION public.auth_issue_refresh(uuid, text, int, text),
  public.auth_rotate_refresh(text, text, int), public.auth_revoke_refresh(text),
  public.my_access(), public.remove_member(uuid), public.auth_set_password(text), private.purge_expired_documents(int) TO kritvia_app;

GRANT SELECT ON schema_migrations TO kritvia_app;

-- Worker helpers (routing ids only)
CREATE FUNCTION private.ventures_with_pending_embeddings()
RETURNS TABLE (org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM chunks c WHERE c.embedding IS NULL
$$;

-- Scheduled workflows that should have produced a run for today but did not, or failed.
CREATE FUNCTION private.overnight_plan_problems(p_day date)
RETURNS TABLE (org_id uuid, venture_id uuid, workflow text, state text, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.org_id, c.venture_id, c.workflow,
         CASE WHEN r.id IS NULL THEN 'missing' ELSE r.status END,
         private.provision_service_account(c.org_id, c.venture_id)
    FROM workflow_configs c
    LEFT JOIN LATERAL (SELECT id, status FROM workflow_runs w
                        WHERE w.venture_id = c.venture_id AND w.workflow = c.workflow
                          AND w.trigger_kind = 'schedule' AND w.created_at >= (p_day - 1)::timestamptz
                        ORDER BY created_at DESC LIMIT 1) r ON true
   WHERE c.enabled AND c.schedule IS NOT NULL AND c.schedule >= '18:00'
     AND (r.id IS NULL OR r.status IN ('failed', 'cancelled'))
$$;

GRANT EXECUTE ON FUNCTION private.ventures_with_pending_embeddings(),
  private.overnight_plan_problems(date) TO kritvia_app;
