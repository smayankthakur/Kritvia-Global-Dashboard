-- =============================================================================
-- 0074 Identity and Kritvia-staff hardening (test report round 2: S6, S13, S18, S19).
--
-- S13  QR sign-in shows where the new device is and needs a matching number. Each link records the
--      new device's IP address, its approximate place (Cloudflare's country/city headers) and a
--      two-digit number that the new device shows. The person approving sees the place, address and
--      time, and must pick that number from three; a wrong pick refuses the link. A phishing page that
--      shows someone else's QR code (QRLjacking) then shows a place and network that aren't theirs,
--      and can't be approved by a reflex tap.
-- S18  Kritvia staff is a database role, not only an email check in the app: staff functions (coupons,
--      partners, the app review queue, pilot health) refuse anyone who isn't in private.kritvia_staff.
--      The app still decides who is staff from STAFF_EMAILS (founder by default) and records it there
--      when a staff page is used; only a verified, active, non-service account can be staff.
-- S19  Coupons limited to some industries check the industry a business chose first (coupon_industry,
--      fixed once chosen while the business is set up), so switching the industry afterwards can't unlock one.
--      Kritvia staff can still correct it.
-- S6   Apps from GitHub/npm/PyPI are approved for exactly the version and digest the reviewer saw.
-- =============================================================================

-- ------------------------------------------------------------------------------------ S13 --
ALTER TABLE device_links
  ADD COLUMN requester_ip    text CHECK (requester_ip IS NULL OR char_length(requester_ip) <= 64),
  ADD COLUMN requester_place text CHECK (requester_place IS NULL OR char_length(requester_place) <= 80),
  ADD COLUMN match_code      text CHECK (match_code IS NULL OR match_code ~ '^[1-9][0-9]$');

-- Where the new device is, and the number it shows. Set once, right after the request or the claim.
CREATE FUNCTION public.auth_link_context(p_token_hash text, p_requester_hash text, p_ip text, p_place text,
                                         p_match text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (
    UPDATE device_links SET requester_ip = left(p_ip, 64), requester_place = left(p_place, 80), match_code = p_match
     WHERE token_hash = p_token_hash AND requester_hash = p_requester_hash AND match_code IS NULL
       AND status IN ('waiting', 'claimed') AND expires_at > now()
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM c)
$$;

DROP FUNCTION public.auth_link_peek(text);
CREATE FUNCTION public.auth_link_peek(p_token_hash text)
RETURNS TABLE (kind text, status text, device text, expires_at timestamptz, created_at timestamptz,
               requester_ip text, requester_place text, match_code text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.kind, d.status,
         CASE WHEN d.kind = 'request' THEN d.requester_device ELSE d.approver_device END,
         d.expires_at, d.created_at,
         CASE WHEN d.kind = 'request' THEN d.requester_ip END,
         CASE WHEN d.kind = 'request' THEN d.requester_place END,
         CASE WHEN d.kind = 'request' THEN d.match_code END
    FROM device_links d
   WHERE d.token_hash = p_token_hash AND d.expires_at > now() AND d.status IN ('waiting', 'claimed')
$$;

DROP FUNCTION public.auth_link_get(uuid);
CREATE FUNCTION public.auth_link_get(p_id uuid)
RETURNS TABLE (status text, device text, expires_at timestamptz, requester_ip text, requester_place text,
               match_code text, claimed_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.status IN ('waiting', 'claimed') AND d.expires_at <= now() THEN 'expired' ELSE d.status END,
         d.requester_device, d.expires_at, d.requester_ip, d.requester_place, d.match_code,
         CASE WHEN d.status <> 'waiting' THEN d.expires_at - interval '2 minutes' END
    FROM device_links d
   WHERE d.id = p_id AND d.kind = 'offer' AND d.user_id = private.current_user_id()
$$;

-- Yes needs the number the new device shows; a wrong number refuses the link (no second guess).
DROP FUNCTION public.auth_link_decide(uuid, boolean);
CREATE FUNCTION public.auth_link_decide(p_id uuid, p_approve boolean, p_match text)
RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE device_links
     SET status = CASE WHEN p_approve AND match_code IS NOT NULL AND match_code = p_match THEN 'approved'
                       ELSE 'rejected' END,
         decided_at = now()
   WHERE id = p_id AND kind = 'offer' AND user_id = private.current_user_id()
     AND status = 'claimed' AND expires_at > now()
  RETURNING status
$$;

DROP FUNCTION public.auth_link_answer(text, boolean, text);
CREATE FUNCTION public.auth_link_answer(p_token_hash text, p_approve boolean, p_device text, p_match text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid := private.current_user_id(); out text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in first' USING ERRCODE = '42501'; END IF;
  UPDATE device_links
     SET status = CASE WHEN p_approve AND match_code IS NOT NULL AND match_code = p_match THEN 'approved'
                       ELSE 'rejected' END,
         user_id = CASE WHEN p_approve AND match_code IS NOT NULL AND match_code = p_match THEN uid END,
         approver_device = left(p_device, 80), decided_at = now()
   WHERE token_hash = p_token_hash AND kind = 'request' AND status = 'waiting' AND expires_at > now()
  RETURNING status INTO out;
  RETURN out;
END $$;

REVOKE ALL ON FUNCTION public.auth_link_context(text, text, text, text, text), public.auth_link_peek(text),
  public.auth_link_get(uuid), public.auth_link_decide(uuid, boolean, text),
  public.auth_link_answer(text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_link_context(text, text, text, text, text), public.auth_link_peek(text),
  public.auth_link_get(uuid), public.auth_link_decide(uuid, boolean, text),
  public.auth_link_answer(text, boolean, text, text) TO kritvia_app;

-- ------------------------------------------------------------------------------------- S6 --
-- An approval names the package exactly as the reviewer saw it (compare-and-set) and stores it pinned to the
-- registry's fingerprint (npm integrity, a PyPI file's sha256, an image digest); only that pin may be added.
DROP FUNCTION private.catalog_review(text, text, text[], text, uuid);
CREATE FUNCTION private.catalog_review(p_id text, p_status text, p_hosts text[], p_note text, p_by uuid,
                                       p_expect jsonb, p_package jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE app_catalog SET status = p_status, egress_hosts = coalesce(p_hosts, egress_hosts), review_note = p_note,
         package = CASE WHEN p_status = 'approved' THEN p_package ELSE package END,
         reviewed_by = p_by, reviewed_at = now(), updated_at = now()
   WHERE id = p_id AND kind = 'hosted' AND source IN ('github', 'registry')
     AND p_status IN ('approved', 'rejected', 'pending')
     AND package IS NOT DISTINCT FROM p_expect
     AND (p_status <> 'approved'
          OR (p_package ? 'integrity'
              AND p_package - 'integrity' - 'file' - 'version' - 'identifier'
                  = p_expect - 'integrity' - 'file' - 'version' - 'identifier'))
  RETURNING true
$$;
REVOKE ALL ON FUNCTION private.catalog_review(text, text, text[], text, uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.catalog_review(text, text, text[], text, uuid, jsonb, jsonb) TO kritvia_app;

-- A resubmission can't rewrite an approved entry, or a waiting one someone else sent in; the registry sync
-- (no submitter) and the original submitter can still refresh a waiting one (its approval then needs a new look).
CREATE OR REPLACE FUNCTION private.catalog_upsert(p jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO app_catalog AS c (id, source, kind, title, description, url, auth_modes, header_name, docs_url,
                                repo_url, package, egress_hosts, status, submitted_by)
  VALUES (p->>'id', p->>'source', p->>'kind', left(p->>'title', 120), left(p->>'description', 1000), p->>'url',
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'auth_modes', '[]'))), p->>'header_name',
          p->>'docs_url', p->>'repo_url', p->'package',
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'egress_hosts', '[]'))),
          coalesce(p->>'status', 'listed'), (p->>'submitted_by')::uuid)
  ON CONFLICT (id) DO UPDATE SET
         title = CASE WHEN c.status = 'approved' OR (c.status = 'pending' AND EXCLUDED.submitted_by IS NOT NULL
                       AND EXCLUDED.submitted_by IS DISTINCT FROM c.submitted_by) THEN c.title ELSE EXCLUDED.title END,
         description = CASE WHEN c.status = 'approved' OR (c.status = 'pending' AND EXCLUDED.submitted_by IS NOT NULL
                       AND EXCLUDED.submitted_by IS DISTINCT FROM c.submitted_by) THEN c.description
                       ELSE EXCLUDED.description END,
         url = CASE WHEN c.status = 'approved' THEN c.url ELSE EXCLUDED.url END,
         auth_modes = CASE WHEN c.status = 'approved' THEN c.auth_modes ELSE EXCLUDED.auth_modes END,
         header_name = CASE WHEN c.status = 'approved' THEN c.header_name ELSE EXCLUDED.header_name END,
         docs_url = CASE WHEN c.status = 'approved' THEN c.docs_url ELSE EXCLUDED.docs_url END,
         repo_url = CASE WHEN c.status = 'approved' OR (c.status = 'pending' AND EXCLUDED.submitted_by IS NOT NULL
                       AND EXCLUDED.submitted_by IS DISTINCT FROM c.submitted_by) THEN c.repo_url
                       ELSE EXCLUDED.repo_url END,
         package = CASE WHEN c.status = 'approved' OR (c.status = 'pending' AND EXCLUDED.submitted_by IS NOT NULL
                       AND EXCLUDED.submitted_by IS DISTINCT FROM c.submitted_by) THEN c.package
                       ELSE EXCLUDED.package END,
         updated_at = now(),
         status = CASE WHEN c.status IN ('approved', 'rejected', 'pending') THEN c.status ELSE EXCLUDED.status END
   WHERE c.source = EXCLUDED.source
$$;

-- ------------------------------------------------------------------------------------ S18 --
CREATE TABLE private.kritvia_staff (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.kritvia_staff FROM PUBLIC;

-- The signed-in person, as the app judged them from STAFF_EMAILS: recorded (or removed) for themselves only.
CREATE FUNCTION private.staff_sync(p_user uuid, p_staff boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM private.current_user_id() THEN
    RAISE EXCEPTION 'only for yourself' USING ERRCODE = '42501';
  END IF;
  IF p_staff AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_user AND u.is_active AND NOT u.is_service
                                                 AND u.email_verified_at IS NOT NULL) THEN
    INSERT INTO private.kritvia_staff (user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
    RETURN true;
  END IF;
  DELETE FROM private.kritvia_staff WHERE user_id = p_user;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION private.staff_sync(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.staff_sync(uuid, boolean) TO kritvia_app;

CREATE FUNCTION private.is_kritvia_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM private.kritvia_staff k JOIN users u ON u.id = k.user_id
                  WHERE k.user_id = private.current_user_id() AND u.is_active AND NOT u.is_service
                    AND u.email_verified_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION private.is_kritvia_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.is_kritvia_staff() TO kritvia_app;

CREATE FUNCTION private.require_kritvia_staff() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT private.is_kritvia_staff() THEN
    RAISE EXCEPTION 'Kritvia staff only' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION private.require_kritvia_staff() FROM PUBLIC;

-- Each staff-only function keeps its body under a new name (no longer callable by the app) behind a wrapper
-- with the old name and signature that checks the caller first.
DO $do$
DECLARE
  f record; args text; result text; calls text; body text; n int; i int;
BEGIN
  FOR f IN
    SELECT p.oid, p.proname, p.pronargs, pg_get_function_arguments(p.oid) AS args,
           pg_get_function_identity_arguments(p.oid) AS idargs, pg_get_function_result(p.oid) AS result,
           p.proretset
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'private'
       AND p.proname IN ('staff_coupons', 'staff_coupon_uses', 'staff_save_coupon', 'staff_delete_coupon',
                         'staff_set_coupon', 'staff_partners', 'staff_set_partner_status', 'staff_record_payout',
                         'catalog_review', 'catalog_all', 'pilot_health')
  LOOP
    n := f.pronargs;
    calls := '';
    FOR i IN 1..n LOOP
      calls := calls || CASE WHEN i > 1 THEN ', ' ELSE '' END || '$' || i;
    END LOOP;
    EXECUTE format('ALTER FUNCTION private.%I(%s) RENAME TO %I', f.proname, f.idargs, f.proname || '_unchecked');
    EXECUTE format('REVOKE ALL ON FUNCTION private.%I(%s) FROM PUBLIC, kritvia_app',
                   f.proname || '_unchecked', f.idargs);
    IF f.proretset THEN
      body := format('BEGIN PERFORM private.require_kritvia_staff(); RETURN QUERY SELECT * FROM private.%I(%s); END',
                     f.proname || '_unchecked', calls);
    ELSIF f.result = 'void' THEN
      body := format('BEGIN PERFORM private.require_kritvia_staff(); PERFORM private.%I(%s); END',
                     f.proname || '_unchecked', calls);
    ELSE
      body := format('BEGIN PERFORM private.require_kritvia_staff(); RETURN private.%I(%s); END',
                     f.proname || '_unchecked', calls);
    END IF;
    EXECUTE format('CREATE FUNCTION private.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER'
                   ' SET search_path = public, pg_temp AS %L', f.proname, f.args, f.result, body);
    EXECUTE format('REVOKE ALL ON FUNCTION private.%I(%s) FROM PUBLIC', f.proname, f.idargs);
    EXECUTE format('GRANT EXECUTE ON FUNCTION private.%I(%s) TO kritvia_app', f.proname, f.idargs);
  END LOOP;
END $do$;

-- ------------------------------------------------------------------------------------ S19 --
ALTER TABLE venture_settings ADD COLUMN coupon_industry text;
UPDATE venture_settings SET coupon_industry = private.venture_industry(industry, kind);

CREATE FUNCTION private.fix_coupon_industry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.coupon_industry := private.venture_industry(NEW.industry, NEW.kind);
  ELSIF NEW.coupon_industry IS DISTINCT FROM OLD.coupon_industry
        AND (private.is_kritvia_staff() OR session_user <> 'kritvia_app') THEN
    NULL;                                  -- Kritvia's team (or an operator at the database) corrects it
  ELSIF OLD.industry IS NULL
        AND (SELECT v.created_at FROM ventures v WHERE v.id = NEW.venture_id) > now() - interval '1 hour' THEN
    -- still being set up (the business is under an hour old and no industry chosen yet): follow the choice
    NEW.coupon_industry := private.venture_industry(NEW.industry, NEW.kind);
  ELSE
    NEW.coupon_industry := OLD.coupon_industry;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER venture_settings_coupon_industry BEFORE INSERT OR UPDATE ON venture_settings
  FOR EACH ROW EXECUTE FUNCTION private.fix_coupon_industry();

DO $do$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('private.use_coupon(uuid, text)'::regprocedure) INTO d;
  IF position('private.venture_industry(s.industry, s.kind) = ANY (c.industries)' IN d) = 0 THEN
    RAISE EXCEPTION 'use_coupon: industry check not found';
  END IF;
  d := replace(d, 'private.venture_industry(s.industry, s.kind) = ANY (c.industries)',
               'coalesce(s.coupon_industry, private.venture_industry(s.industry, s.kind)) = ANY (c.industries)');
  EXECUTE d;
END $do$;
