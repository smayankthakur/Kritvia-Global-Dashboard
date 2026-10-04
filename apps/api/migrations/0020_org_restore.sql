-- =============================================================================
-- Kritvia 0020 — Restoring a closed organisation within its 30-day grace period (ToS 18.5).
--
-- An organisation closes when its sole owner deletes their account; its data is erased 30 days
-- later. Within that window support can reopen it for the person who asks, once they have
-- signed up again (the old account was anonymised). Run by the operator only:
--   infra/scripts/restore-org.sh <org id> <email of the new owner account>
-- Agents stay switched off and connectors must be reconnected: nothing acts until the owner
-- turns it back on.
-- =============================================================================
CREATE FUNCTION private.restore_org(p_org uuid, p_owner_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o organisations; uid uuid;
BEGIN
  SELECT * INTO o FROM organisations WHERE id = p_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such organisation (already erased?)'; END IF;
  IF o.closed_at IS NULL THEN RAISE EXCEPTION 'organisation is not closed'; END IF;
  SELECT id INTO uid FROM users WHERE lower(email) = lower(p_owner_email) AND is_active;
  IF uid IS NULL THEN RAISE EXCEPTION 'no active account for that email: ask them to sign up first'; END IF;
  UPDATE organisations SET closed_at = NULL WHERE id = p_org;
  INSERT INTO memberships (org_id, user_id, role) VALUES (p_org, uid, 'org_owner') ON CONFLICT DO NOTHING;
  RETURN uid;
END $$;
REVOKE EXECUTE ON FUNCTION private.restore_org(uuid, text) FROM PUBLIC;
