-- =============================================================================
-- Kritvia 0022 — Owners add, rename and remove their businesses (ventures).
--
--   rename_venture   an owner or venture admin changes the display name.
--   remove_venture   an owner removes a business: its agents stop, its connectors are disconnected,
--                    queued runs are cancelled and nobody (people or agents) can read its data any
--                    more. Typing the business name confirms it. An organisation keeps at least one
--                    business (closing everything is "Delete my account").
--   restore_venture  within 30 days an owner can bring it back; agents stay off and connectors must
--                    be reconnected, so nothing acts until the owner turns it back on.
--   purge_removed_ventures  the worker erases a removed business's data after 30 days (every tenant
--                    table cascades from ventures; the hash-chained audit log keeps its metadata).
--
-- A removed business no longer counts towards the plan's business limit.
-- =============================================================================
ALTER TABLE ventures ADD COLUMN removed_at timestamptz, ADD COLUMN removed_by uuid REFERENCES users(id);

-- Access resolution ignores removed businesses, so every RLS policy hides their data at once.
CREATE OR REPLACE FUNCTION private.readable_ventures() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT s.v), '{}') FROM (
    SELECT m.venture_id AS v FROM memberships m
      WHERE m.user_id = private.current_user_id() AND m.venture_id IS NOT NULL
    UNION
    SELECT g.venture_id FROM grants g
      WHERE g.grantee_user_id = private.current_user_id()
        AND (g.expires_at IS NULL OR g.expires_at > now())
  ) s JOIN ventures ve ON ve.id = s.v AND ve.removed_at IS NULL
$$;

CREATE OR REPLACE FUNCTION private.writable_ventures() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT s.v), '{}') FROM (
    SELECT m.venture_id AS v FROM memberships m JOIN roles r ON r.name = m.role
      WHERE m.user_id = private.current_user_id() AND m.venture_id IS NOT NULL AND r.can_write
    UNION
    SELECT g.venture_id FROM grants g
      WHERE g.grantee_user_id = private.current_user_id() AND g.access = 'write'
        AND (g.expires_at IS NULL OR g.expires_at > now())
  ) s JOIN ventures ve ON ve.id = s.v AND ve.removed_at IS NULL
$$;

-- Plan limits count only businesses in use.
CREATE OR REPLACE FUNCTION public.org_usage(p_org uuid, p_local text[])
RETURNS TABLE (plan text, tokens bigint, ventures bigint, members bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT o.plan FROM org_plans o WHERE o.org_id = p_org),
         coalesce((SELECT sum(coalesce(m.prompt_tokens, 0) + coalesce(m.completion_tokens, 0))
                     FROM model_calls m
                    WHERE m.org_id = p_org AND m.status = 'ok'
                      AND NOT (coalesce(m.provider_model, '') = ANY (p_local))
                      AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
                                          AT TIME ZONE 'Asia/Kolkata'), 0)::bigint,
         (SELECT count(*) FROM ventures v WHERE v.org_id = p_org AND v.removed_at IS NULL),
         (SELECT count(DISTINCT ms.user_id) FROM memberships ms JOIN users u ON u.id = ms.user_id
           WHERE ms.org_id = p_org AND NOT u.is_service)
   WHERE p_org = ANY (private.member_orgs())   -- only for members of that organisation
$$;

-- A removed business publishes no privacy notice.
CREATE OR REPLACE FUNCTION private.public_notice(p_venture uuid)
RETURNS TABLE (business_name text, city text, contact_name text, contact_email text, kind text,
               workflows text[], updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(s.business_name, v.name), coalesce(s.city, ''), coalesce(s.privacy_contact_name, ''),
         s.privacy_contact_email, coalesce(s.kind, 'general'),
         coalesce((SELECT array_agg(c.workflow ORDER BY c.workflow) FROM workflow_configs c
                    WHERE c.venture_id = v.id AND c.enabled), '{}'),
         s.updated_at
    FROM ventures v JOIN venture_settings s ON s.venture_id = v.id
    JOIN organisations o ON o.id = v.org_id
   WHERE v.id = p_venture AND s.privacy_contact_email IS NOT NULL AND o.closed_at IS NULL
     AND v.removed_at IS NULL
$$;

CREATE FUNCTION public.rename_venture(p_venture uuid, p_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n text := btrim(coalesce(p_name, ''));
BEGIN
  IF NOT coalesce(private.can_admin_venture(p_venture), false) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = '42501';
  END IF;
  IF char_length(n) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'a business name needs 1 to 120 characters' USING ERRCODE = 'KV409';
  END IF;
  UPDATE ventures SET name = n WHERE id = p_venture AND removed_at IS NULL;
END $$;
GRANT EXECUTE ON FUNCTION public.rename_venture(uuid, text) TO kritvia_app;

CREATE FUNCTION public.remove_venture(p_venture uuid, p_confirm text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v ventures;
BEGIN
  SELECT * INTO v FROM ventures WHERE id = p_venture AND removed_at IS NULL;
  IF NOT FOUND OR NOT (v.org_id = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = '42501';
  END IF;
  IF lower(btrim(coalesce(p_confirm, ''))) IS DISTINCT FROM lower(btrim(v.name)) THEN
    RAISE EXCEPTION 'type the business name exactly to confirm' USING ERRCODE = 'KV409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ventures x WHERE x.org_id = v.org_id AND x.id <> v.id AND x.removed_at IS NULL) THEN
    RAISE EXCEPTION 'this is your only business. Add another one first, or delete your account to close everything'
      USING ERRCODE = 'KV409';
  END IF;
  UPDATE ventures SET removed_at = now(), removed_by = private.current_user_id() WHERE id = v.id;
  UPDATE workflow_configs SET enabled = false WHERE venture_id = v.id;
  UPDATE connectors SET status = 'revoked' WHERE venture_id = v.id;
  UPDATE workflow_runs SET status = 'cancelled', updated_at = now()
   WHERE venture_id = v.id AND status IN ('queued', 'running', 'waiting');
END $$;
GRANT EXECUTE ON FUNCTION public.remove_venture(uuid, text) TO kritvia_app;

CREATE FUNCTION public.restore_venture(p_venture uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v ventures;
BEGIN
  SELECT * INTO v FROM ventures WHERE id = p_venture AND removed_at IS NOT NULL;
  IF NOT FOUND OR NOT (v.org_id = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = '42501';
  END IF;
  UPDATE ventures SET removed_at = NULL, removed_by = NULL WHERE id = v.id;
END $$;
GRANT EXECUTE ON FUNCTION public.restore_venture(uuid) TO kritvia_app;

-- Removed businesses an owner can still restore, newest first.
CREATE FUNCTION public.removed_ventures(p_org uuid)
RETURNS TABLE (id uuid, name text, kind text, removed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.id, v.name, coalesce(s.kind, 'general'), v.removed_at
    FROM ventures v LEFT JOIN venture_settings s ON s.venture_id = v.id
   WHERE v.org_id = p_org AND v.removed_at IS NOT NULL AND p_org = ANY (private.owned_orgs())
   ORDER BY v.removed_at DESC
$$;
GRANT EXECUTE ON FUNCTION public.removed_ventures(uuid) TO kritvia_app;

CREATE FUNCTION private.purge_removed_ventures(p_days int) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (DELETE FROM ventures WHERE removed_at < now() - make_interval(days => p_days) RETURNING 1)
  SELECT count(*)::int FROM gone
$$;
GRANT EXECUTE ON FUNCTION private.purge_removed_ventures(int) TO kritvia_app;
