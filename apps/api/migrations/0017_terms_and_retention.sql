-- =============================================================================
-- Kritvia 0017 — Record of terms acceptance; retention promised in the Privacy Policy.
--
--   * users.terms_version / terms_accepted_at: which Terms of Service and Privacy Policy
--     version each person accepted, and when (ToS 1.3). Set by public.accept_terms().
--   * delete_my_account() also deletes the person's browser notification subscriptions.
--   * private.purge_support(days): support messages are kept two years after they arrive.
-- =============================================================================
ALTER TABLE users ADD COLUMN terms_version text, ADD COLUMN terms_accepted_at timestamptz;
GRANT SELECT (terms_version, terms_accepted_at) ON users TO kritvia_app;

CREATE FUNCTION public.accept_terms(p_version text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET terms_version = left(p_version, 32), terms_accepted_at = now()
   WHERE id = private.current_user_id()
$$;
GRANT EXECUTE ON FUNCTION public.accept_terms(text) TO kritvia_app;

CREATE OR REPLACE FUNCTION public.delete_my_account(p_confirm text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid := private.current_user_id(); o record; closed int := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  IF p_confirm IS DISTINCT FROM 'DELETE' THEN
    RAISE EXCEPTION 'type DELETE to confirm' USING ERRCODE = 'KV409';
  END IF;
  FOR o IN SELECT DISTINCT m.org_id FROM memberships m WHERE m.user_id = uid AND m.role = 'org_owner' LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM memberships x JOIN users u ON u.id = x.user_id
                           WHERE x.org_id = o.org_id AND x.role = 'org_owner' AND x.user_id <> uid AND NOT u.is_service);
    IF EXISTS (SELECT 1 FROM memberships x JOIN users u ON u.id = x.user_id
                WHERE x.org_id = o.org_id AND x.user_id <> uid AND NOT u.is_service) THEN
      RAISE EXCEPTION 'make someone else an owner of your organisation first, or remove its other members'
        USING ERRCODE = 'KV409';
    END IF;
    UPDATE organisations SET closed_at = now() WHERE id = o.org_id;
    UPDATE workflow_configs SET enabled = false WHERE org_id = o.org_id;
    UPDATE connectors SET status = 'revoked' WHERE org_id = o.org_id;
    closed := closed + 1;
  END LOOP;
  DELETE FROM grants WHERE grantee_user_id = uid;
  DELETE FROM memberships WHERE user_id = uid;
  DELETE FROM voice_settings WHERE user_id = uid;
  DELETE FROM dictation_events WHERE user_id = uid;
  DELETE FROM vocabulary_terms WHERE user_id = uid;
  DELETE FROM push_subscriptions WHERE user_id = uid;
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = uid;
  UPDATE users SET email = 'deleted+' || id::text || '@deleted.invalid', full_name = 'Deleted user',
         password_hash = NULL, google_sub = NULL, email_verified_at = NULL, is_active = false,
         password_changed_at = clock_timestamp()
   WHERE id = uid;
  RETURN closed;
END $$;

CREATE FUNCTION private.purge_support(p_days int) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (DELETE FROM support_requests WHERE created_at < now() - make_interval(days => p_days) RETURNING 1)
  SELECT count(*)::int FROM gone
$$;
GRANT EXECUTE ON FUNCTION private.purge_support(int) TO kritvia_app;
