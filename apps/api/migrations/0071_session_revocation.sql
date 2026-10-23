-- =============================================================================
-- 0071 Signing a device out takes effect at once (pre-launch test report, S6).
-- Access tokens carry their sign-in (the refresh-token family, claim "fam"). Each request checks that the
-- family hasn't been revoked: by "sign this device out", by logging out, or by reuse detection on a stolen
-- refresh token. Tokens issued before this change have no "fam" and keep working until they expire.
-- =============================================================================
CREATE FUNCTION private.auth_family_revoked(p_family uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM refresh_tokens
                  WHERE family_id = p_family AND user_id = p_user AND revoked_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION private.auth_family_revoked(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.auth_family_revoked(uuid, uuid) TO kritvia_app;

-- The sign-in a refresh token belongs to, to put in the access token issued alongside it.
CREATE FUNCTION public.auth_refresh_family(p_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT family_id FROM refresh_tokens WHERE token_hash = p_hash
$$;
REVOKE ALL ON FUNCTION public.auth_refresh_family(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_refresh_family(text) TO kritvia_app;
