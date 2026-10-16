-- =============================================================================
-- Kritvia 0048 — Sign in on another device with a QR code; signed-in devices; two more
-- automation periods.
--
-- device_links   one short-lived QR sign-in. Two kinds:
--   offer    a signed-in person shows a QR (Your account / "Open on your phone"); the new device
--            scans it ("claims" it), and the person approves it on the signed-in device.
--   request  the login page shows a QR; a phone that is already signed in scans it and approves.
--   Either way the new device holds a secret (requester_hash) that the BFF keeps in an httpOnly
--   cookie, and redeems the approved link once for a normal session. Tokens and secrets are
--   stored only as SHA-256 hashes; links live 3 minutes (2 more after a claim) and are pruned
--   after a day. Not tenant data: RLS on with no app policies; reached only through functions.
-- =============================================================================

CREATE TABLE device_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('offer', 'request')),
  token_hash        text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  requester_hash    text CHECK (char_length(requester_hash) = 64),
  requester_device  text CHECK (char_length(requester_device) <= 80),
  approver_device   text CHECK (char_length(approver_device) <= 80),
  user_id           uuid REFERENCES users(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'claimed', 'approved', 'rejected', 'used')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  decided_at        timestamptz,
  CHECK (kind = 'request' OR user_id IS NOT NULL)
);
CREATE INDEX device_links_user_idx ON device_links (user_id, created_at DESC);
ALTER TABLE device_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_links FORCE ROW LEVEL SECURITY;

-- A signed-in person offers a sign-in to another device.
CREATE FUNCTION public.auth_link_offer(p_token_hash text, p_device text)
RETURNS TABLE (id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE uid uuid := private.current_user_id();
BEGIN
  IF uid IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = uid AND u.is_active AND NOT u.is_service) THEN
    RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501';
  END IF;
  DELETE FROM device_links WHERE device_links.expires_at < now() - interval '1 day';
  IF (SELECT count(*) FROM device_links d WHERE d.user_id = uid AND d.kind = 'offer'
        AND d.status IN ('waiting', 'claimed') AND d.expires_at > now()) >= 5 THEN
    RAISE EXCEPTION 'too many open QR codes; wait a few minutes' USING ERRCODE = 'KV409';
  END IF;
  RETURN QUERY
  INSERT INTO device_links (kind, token_hash, user_id, approver_device, expires_at)
  VALUES ('offer', p_token_hash, uid, left(p_device, 80), now() + interval '3 minutes')
  RETURNING device_links.id, device_links.expires_at;
END $$;

-- The login page asks a signed-in phone to sign it in.
CREATE FUNCTION public.auth_link_request(p_token_hash text, p_requester_hash text, p_device text)
RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM device_links WHERE expires_at < now() - interval '1 day';
  INSERT INTO device_links (kind, token_hash, requester_hash, requester_device, expires_at)
  VALUES ('request', p_token_hash, p_requester_hash, left(p_device, 80), now() + interval '3 minutes')
  RETURNING expires_at;
$$;

-- What a scanned code is, for the page that opened it. Knowing the token is the permission.
CREATE FUNCTION public.auth_link_peek(p_token_hash text)
RETURNS TABLE (kind text, status text, device text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.kind, d.status,
         CASE WHEN d.kind = 'request' THEN d.requester_device ELSE d.approver_device END,
         d.expires_at
    FROM device_links d
   WHERE d.token_hash = p_token_hash AND d.expires_at > now() AND d.status IN ('waiting', 'claimed')
$$;

-- The new device scans an offer. Only the first scan counts.
CREATE FUNCTION public.auth_link_claim(p_token_hash text, p_requester_hash text, p_device text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (
    UPDATE device_links SET status = 'claimed', requester_hash = p_requester_hash,
           requester_device = left(p_device, 80), expires_at = now() + interval '2 minutes'
     WHERE token_hash = p_token_hash AND kind = 'offer' AND status = 'waiting' AND expires_at > now()
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM c)
$$;

-- The signed-in device watches its offer.
CREATE FUNCTION public.auth_link_get(p_id uuid)
RETURNS TABLE (status text, device text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.status IN ('waiting', 'claimed') AND d.expires_at <= now() THEN 'expired' ELSE d.status END,
         d.requester_device, d.expires_at
    FROM device_links d
   WHERE d.id = p_id AND d.kind = 'offer' AND d.user_id = private.current_user_id()
$$;

-- The signed-in device says yes or no to the device that scanned its offer.
CREATE FUNCTION public.auth_link_decide(p_id uuid, p_approve boolean)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE device_links SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, decided_at = now()
   WHERE id = p_id AND kind = 'offer' AND user_id = private.current_user_id()
     AND status = 'claimed' AND expires_at > now()
  RETURNING status
$$;

-- A signed-in phone says yes or no to a login page's request.
CREATE FUNCTION public.auth_link_answer(p_token_hash text, p_approve boolean, p_device text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid := private.current_user_id(); out text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501'; END IF;
  UPDATE device_links SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         user_id = CASE WHEN p_approve THEN uid END, approver_device = left(p_device, 80), decided_at = now()
   WHERE token_hash = p_token_hash AND kind = 'request' AND status = 'waiting' AND expires_at > now()
  RETURNING status INTO out;
  RETURN out;
END $$;

-- The new device collects its sign-in, once. Returns the link's state and, when it was
-- approved just now, whose session to start.
CREATE FUNCTION public.auth_link_redeem(p_token_hash text, p_requester_hash text)
RETURNS TABLE (status text, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE d device_links; ok boolean;
BEGIN
  SELECT * INTO d FROM device_links WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR d.requester_hash IS DISTINCT FROM p_requester_hash THEN
    RETURN QUERY SELECT 'gone'::text, NULL::uuid; RETURN;
  END IF;
  IF d.status IN ('waiting', 'claimed', 'approved') AND d.expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid; RETURN;
  END IF;
  IF d.status <> 'approved' THEN
    RETURN QUERY SELECT d.status, NULL::uuid; RETURN;
  END IF;
  SELECT u.is_active AND NOT u.is_service INTO ok FROM users u WHERE u.id = d.user_id;
  UPDATE device_links SET status = 'used' WHERE id = d.id;
  IF NOT coalesce(ok, false) THEN
    RETURN QUERY SELECT 'rejected'::text, NULL::uuid; RETURN;
  END IF;
  RETURN QUERY SELECT 'used'::text, d.user_id;
END $$;

-- Signed-in devices: one row per sign-in (refresh-token family) that can still be renewed.
CREATE FUNCTION public.auth_my_sessions()
RETURNS TABLE (family_id uuid, user_agent text, signed_in_at timestamptz, last_seen_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.family_id,
         (array_agg(t.user_agent ORDER BY t.created_at DESC))[1],
         min(t.created_at), max(t.created_at)
    FROM refresh_tokens t
   WHERE t.user_id = private.current_user_id()
   GROUP BY t.family_id
  HAVING bool_or(t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > now())
     AND bool_and(t.revoked_at IS NULL)
   ORDER BY max(t.created_at) DESC
   LIMIT 50
$$;

CREATE FUNCTION public.auth_end_session(p_family uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH r AS (
    UPDATE refresh_tokens SET revoked_at = now()
     WHERE user_id = private.current_user_id() AND family_id = p_family AND revoked_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM r)
$$;

REVOKE ALL ON FUNCTION public.auth_link_offer(text, text), public.auth_link_request(text, text, text),
  public.auth_link_peek(text), public.auth_link_claim(text, text, text), public.auth_link_get(uuid),
  public.auth_link_decide(uuid, boolean), public.auth_link_answer(text, boolean, text),
  public.auth_link_redeem(text, text), public.auth_my_sessions(), public.auth_end_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_link_offer(text, text), public.auth_link_request(text, text, text),
  public.auth_link_peek(text), public.auth_link_claim(text, text, text), public.auth_link_get(uuid),
  public.auth_link_decide(uuid, boolean), public.auth_link_answer(text, boolean, text),
  public.auth_link_redeem(text, text), public.auth_my_sessions(), public.auth_end_session(uuid) TO kritvia_app;

-- Automations: "tomorrow's appointments", "what falls due in the next 7 days".
ALTER TABLE automations DROP CONSTRAINT automations_period_check;
ALTER TABLE automations ADD CONSTRAINT automations_period_check CHECK (period IN (
  'today', 'yesterday', 'last_7_days', 'last_week', 'this_month', 'last_month', 'last_30_days', 'tomorrow', 'next_7_days'));
