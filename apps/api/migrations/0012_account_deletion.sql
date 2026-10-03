-- =============================================================================
-- Kritvia 0012 — Self-service account deletion (DPDP right to erasure).
--
-- public.delete_my_account() removes the caller's access and personal data:
--   * memberships, grants and sessions are removed; the user row is anonymised (it stays
--     only so past audit entries and approvals keep a valid reference, with no name or email);
--   * personal voice settings, personal vocabulary and dictation stats are deleted;
--   * an organisation the caller owns alone, with no other people in it, is closed:
--     its workflows and connectors stop at once and organisations.closed_at marks it for
--     the purge of its business data (runbook: "Closed organisations");
--   * an organisation that has other people needs another owner first (refused, KV409).
-- =============================================================================
ALTER TABLE organisations ADD COLUMN closed_at timestamptz;

CREATE FUNCTION public.delete_my_account(p_confirm text) RETURNS int
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
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = uid;
  UPDATE users SET email = 'deleted+' || id::text || '@deleted.invalid', full_name = 'Deleted user',
         password_hash = NULL, google_sub = NULL, email_verified_at = NULL, is_active = false,
         password_changed_at = clock_timestamp()
   WHERE id = uid;
  RETURN closed;
END $$;
GRANT EXECUTE ON FUNCTION public.delete_my_account(text) TO kritvia_app;

-- Erasure of a closed organisation's business data after a 30-day grace period (a mistaken
-- deletion can still be undone by support within it). Ventures cascade to every tenant table.
-- The hash-chained audit log stays: it holds metadata only and is the legal record of what
-- happened. Run daily by the worker with the retention purge.
CREATE FUNCTION private.purge_closed_orgs(p_days int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o record; n int := 0;
BEGIN
  FOR o IN SELECT id FROM organisations WHERE closed_at < now() - make_interval(days => p_days) LOOP
    DELETE FROM ventures WHERE org_id = o.id;
    DELETE FROM organisations WHERE id = o.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION private.purge_closed_orgs(int) TO kritvia_app;
