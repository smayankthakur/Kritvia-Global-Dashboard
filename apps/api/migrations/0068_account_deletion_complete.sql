-- =============================================================================
-- 0068 Deleting your account removes everything tied to you as a person (pre-launch audit, L20):
-- besides memberships, voice settings and push subscriptions, also your Telegram/WhatsApp/Slack approval
-- links and pending link codes, phone sign-in links, team places, and the API keys you created are revoked.
-- Business records stay with the business (they belong to it), as before.
-- =============================================================================

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
  -- 0068: also the person's chat approval links, phone sign-in links, team places and API keys
  DELETE FROM approver_links WHERE user_id = uid;
  DELETE FROM private.approver_link_codes WHERE user_id = uid;
  DELETE FROM device_links WHERE user_id = uid;
  DELETE FROM team_members WHERE user_id = uid;
  UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE created_by = uid;
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = uid;
  UPDATE users SET email = 'deleted+' || id::text || '@deleted.invalid', full_name = 'Deleted user',
         password_hash = NULL, google_sub = NULL, email_verified_at = NULL, is_active = false,
         password_changed_at = clock_timestamp()
   WHERE id = uid;
  RETURN closed;
END $$;
