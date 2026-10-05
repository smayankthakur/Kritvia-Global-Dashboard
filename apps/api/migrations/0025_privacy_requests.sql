-- =============================================================================
-- Kritvia 0025 — Age confirmation, privacy requests, product-email opt-out.
--
--   * users.adult_confirmed_at: when the person confirmed they are 18 or older (Terms 4.1,
--     Privacy 7). Recorded together with the terms acceptance; no birth date is collected.
--   * privacy_requests: requests from anyone (account holders who can't sign in, customers
--     of businesses on Kritvia, nominees) to access, correct, erase, withdraw consent,
--     nominate, or raise a grievance (DPDP Act ss.11–14; GDPR arts.15–21; CCPA). Not tenant
--     data: RLS on with no app policies, written through public.privacy_request_submit and
--     handled by the grievance officer. Deadlines are stored so overdue requests are visible.
--   * users.product_email_optout_at: set by a signed one-click unsubscribe link in product
--     emails (never applies to sign-in codes and security notices).
-- =============================================================================
ALTER TABLE users ADD COLUMN adult_confirmed_at timestamptz,
                  ADD COLUMN product_email_optout_at timestamptz;
GRANT SELECT (adult_confirmed_at, product_email_optout_at) ON users TO kritvia_app;

DROP FUNCTION public.accept_terms(text);
CREATE FUNCTION public.accept_terms(p_version text, p_adult boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_adult IS NOT TRUE THEN
    RAISE EXCEPTION 'Kritvia is only for people aged 18 or over' USING ERRCODE = 'KV409';
  END IF;
  UPDATE users SET terms_version = left(p_version, 32), terms_accepted_at = now(),
                   adult_confirmed_at = coalesce(adult_confirmed_at, now())
   WHERE id = private.current_user_id();
END $$;
GRANT EXECUTE ON FUNCTION public.accept_terms(text, boolean) TO kritvia_app;

CREATE TABLE privacy_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('access', 'correct', 'erase', 'withdraw', 'nominate', 'grievance', 'other')),
  relationship    text NOT NULL CHECK (relationship IN ('account_holder', 'business_customer', 'nominee', 'other')),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email           text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 200),
  business_name   text CHECK (business_name IS NULL OR char_length(business_name) <= 200),
  details         text NOT NULL CHECK (char_length(details) BETWEEN 5 AND 5000),
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'verifying', 'in_progress', 'forwarded', 'done', 'refused')),
  acknowledge_by  timestamptz NOT NULL,
  respond_by      timestamptz NOT NULL,
  outcome         text CHECK (outcome IS NULL OR char_length(outcome) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  handled_at      timestamptz
);
CREATE INDEX privacy_requests_open_idx ON privacy_requests (respond_by) WHERE status NOT IN ('done', 'refused');
ALTER TABLE privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_requests FORCE ROW LEVEL SECURITY;

-- Two business days to acknowledge (Mon–Fri, IST), 30 days to respond (Privacy Policy 6).
CREATE FUNCTION private.add_business_days(p_from timestamptz, p_days int) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d timestamptz := p_from; n int := 0;
BEGIN
  WHILE n < p_days LOOP
    d := d + interval '1 day';
    IF extract(isodow FROM d AT TIME ZONE 'Asia/Kolkata') < 6 THEN n := n + 1; END IF;
  END LOOP;
  RETURN d;
END $$;

CREATE FUNCTION public.privacy_request_submit(p_kind text, p_relationship text, p_name text, p_email text,
                                              p_business text, p_details text, p_user uuid)
RETURNS TABLE (reference text, acknowledge_by timestamptz, respond_by timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ref text;
BEGIN
  LOOP
    ref := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM privacy_requests r WHERE r.reference = ref);
  END LOOP;
  RETURN QUERY
  INSERT INTO privacy_requests (reference, kind, relationship, name, email, business_name, details, user_id,
                                acknowledge_by, respond_by)
  VALUES (ref, p_kind, p_relationship, p_name, lower(p_email), nullif(btrim(p_business), ''), p_details, p_user,
          private.add_business_days(now(), 2), now() + interval '30 days')
  RETURNING privacy_requests.reference, privacy_requests.acknowledge_by, privacy_requests.respond_by;
END $$;
GRANT EXECUTE ON FUNCTION public.privacy_request_submit(text, text, text, text, text, text, uuid) TO kritvia_app;

-- Requests are kept three years after they are closed, as evidence of how each was handled.
CREATE FUNCTION private.purge_privacy_requests(p_days int) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (DELETE FROM privacy_requests WHERE status IN ('done', 'refused')
             AND handled_at < now() - make_interval(days => p_days) RETURNING 1)
  SELECT count(*)::int FROM d
$$;
GRANT EXECUTE ON FUNCTION private.purge_privacy_requests(int) TO kritvia_app;

-- One-click unsubscribe from product emails (the link is signed by the API; see routers/email_prefs.py).
CREATE FUNCTION public.product_email_optout(p_user uuid, p_out boolean) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET product_email_optout_at = CASE WHEN p_out THEN coalesce(product_email_optout_at, now()) END
   WHERE id = p_user RETURNING true
$$;
GRANT EXECUTE ON FUNCTION public.product_email_optout(uuid, boolean) TO kritvia_app;

-- Whether a product email may go to this person (the sender may not be able to read users).
CREATE FUNCTION public.product_email_allowed(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT product_email_optout_at IS NULL AND email NOT LIKE '%@deleted.invalid'
                     FROM users WHERE id = p_user), false)
$$;
GRANT EXECUTE ON FUNCTION public.product_email_allowed(uuid) TO kritvia_app;

-- "Learn from my corrections" watches text after a dictation; the Privacy Policy says it runs only if
-- the person switches it on, so new settings start with it off (existing choices are kept).
ALTER TABLE voice_settings ALTER COLUMN auto_learn SET DEFAULT false;
