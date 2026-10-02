-- =============================================================================
-- Kritvia 0008 — Self-signup: email codes and Google sign-in.
--
-- users.email_verified_at  set when the person proved they own the address (an email
--                          code, or Google saying the address is verified). Existing
--                          accounts were created by the owner and are treated as verified.
-- users.google_sub         Google's stable account id, linked on first Google sign-in.
-- email_codes              one-time 6-digit sign-in codes, stored only as HMAC hashes,
--                          10 minutes, 5 wrong tries burn the code. Not tenant data:
--                          RLS on with no app policies; reached only through functions.
-- =============================================================================

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN google_sub text;
CREATE UNIQUE INDEX users_google_sub_uq ON users (google_sub) WHERE google_sub IS NOT NULL;
UPDATE users SET email_verified_at = created_at WHERE NOT is_service;

CREATE TABLE email_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  code_hash    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_codes_email_idx ON email_codes (lower(email), created_at DESC);
ALTER TABLE email_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_codes FORCE ROW LEVEL SECURITY;

-- A new code replaces any earlier unused one for the address. Old rows are pruned here
-- so the table stays small without a separate job.
CREATE FUNCTION public.auth_code_issue(p_email text, p_hash text, p_minutes int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM email_codes WHERE created_at < now() - interval '1 day';
  UPDATE email_codes SET consumed_at = now()
   WHERE lower(email) = lower(p_email) AND consumed_at IS NULL;
  INSERT INTO email_codes (email, code_hash, expires_at)
  VALUES (lower(p_email), p_hash, now() + make_interval(mins => p_minutes));
$$;

-- True once for the right code. A wrong code counts an attempt; the fifth burns it.
CREATE FUNCTION public.auth_code_consume(p_email text, p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c email_codes;
BEGIN
  SELECT * INTO c FROM email_codes
   WHERE lower(email) = lower(p_email) AND consumed_at IS NULL AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.code_hash = p_hash THEN
    UPDATE email_codes SET consumed_at = now() WHERE id = c.id;
    RETURN true;
  END IF;
  UPDATE email_codes SET attempts = attempts + 1,
         consumed_at = CASE WHEN attempts + 1 >= 5 THEN now() END
   WHERE id = c.id;
  RETURN false;
END $$;

-- An account registered with a password but never verified may have been created by
-- someone else using this address (pre-hijacking). When the real owner proves the
-- address, the unverified password and every session are dropped.
CREATE FUNCTION private.claim_unverified(u users) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET password_hash = NULL, password_changed_at = now()
   WHERE id = u.id AND u.email_verified_at IS NULL;
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now())
   WHERE user_id = u.id AND u.email_verified_at IS NULL;
$$;

-- Sign in (or sign up) someone who just proved they own p_email. Returns NULL for a
-- deactivated account or the agent runtime account.
CREATE FUNCTION public.auth_signin_email(p_email text, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE lower(email) = lower(p_email) FOR UPDATE;
  IF FOUND THEN
    IF NOT u.is_active OR u.is_service THEN RETURN NULL; END IF;
    PERFORM private.claim_unverified(u);
    UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = u.id;
    RETURN u.id;
  END IF;
  INSERT INTO users (email, full_name, email_verified_at)
  VALUES (lower(p_email), left(coalesce(p_name, ''), 120), now())
  RETURNING id INTO u.id;
  RETURN u.id;
END $$;

-- Sign in with Google. Matches the Google account first, then a verified-by-Google
-- email (linking the two), else creates the user. Callers must only pass emails that
-- Google reports as verified.
CREATE FUNCTION public.auth_signin_google(p_sub text, p_email text, p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE google_sub = p_sub FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO u FROM users WHERE lower(email) = lower(p_email) FOR UPDATE;
  END IF;
  IF FOUND THEN
    IF NOT u.is_active OR u.is_service THEN RETURN NULL; END IF;
    IF u.google_sub IS NOT NULL AND u.google_sub <> p_sub THEN RETURN NULL; END IF;
    PERFORM private.claim_unverified(u);
    UPDATE users SET google_sub = p_sub, email_verified_at = coalesce(email_verified_at, now())
     WHERE id = u.id;
    RETURN u.id;
  END IF;
  INSERT INTO users (email, full_name, google_sub, email_verified_at)
  VALUES (lower(p_email), left(coalesce(p_name, ''), 120), p_sub, now())
  RETURNING id INTO u.id;
  RETURN u.id;
END $$;

GRANT SELECT (email_verified_at) ON users TO kritvia_app;
GRANT EXECUTE ON FUNCTION public.auth_code_issue(text, text, int), public.auth_code_consume(text, text),
  public.auth_signin_email(text, text), public.auth_signin_google(text, text, text) TO kritvia_app;
