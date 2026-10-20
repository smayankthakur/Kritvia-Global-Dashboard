-- =============================================================================
-- Kritvia 0065 — Coupons for every kind of offer, aimed at the right businesses.
--
-- Kinds (coupons.kind):
--   free_plan    a paid plan free for some months or days (FIRST50); nothing is charged
--   percent_off  a percentage off a paid plan when the business subscribes: the matching Razorpay offer
--                (created once in the Razorpay dashboard; Razorpay has no API for offers) is attached to
--                the subscription, and the webhook accepts the lower amount for that subscription only
--   trial_days   extra days on the free trial
--   ai_tokens    extra hosted-AI tokens on the monthly allowance, for some months
--
-- Who can use one:
--   who          'new'     organisations created after the coupon starts (and, with signup_days, used within
--                          that many days of the organisation being created)
--                'unpaid'  any organisation not on a paid plan (FIRST50, as before)
--                'anyone'  paying ones too (free_plan and trial_days still never apply to a paying one)
--   industries   only organisations with a business of one of these industries (the onboarding template;
--                businesses from before this migration count by their kind)
--   plans/periods  percent_off only on these plans and billing periods
--   emails/domains a private code: only these people, or people with these email domains
--   starts_at / expires_at, max_uses, active
--
-- An organisation can hold one coupon of each kind (coupon_redemptions is now keyed by id, unique per
-- organisation and kind); a person still uses a given code once.
-- =============================================================================

-- --------------------------------------------------------------------- industry of a business --
ALTER TABLE venture_settings ADD COLUMN industry text
  CHECK (industry IN ('agency', 'loans', 'kitchen', 'trade', 'retail', 'clinic', 'coaching', 'freelancer', 'other'));

-- The industry a business counts as for coupons: the template it was set up from, else by its kind.
CREATE FUNCTION private.venture_industry(p_industry text, p_kind text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_industry, CASE p_kind WHEN 'software' THEN 'agency' WHEN 'finance' THEN 'loans'
                                          WHEN 'kitchen' THEN 'kitchen' WHEN 'trade' THEN 'trade' ELSE 'other' END)
$$;

-- ------------------------------------------------------------------------------------- coupons --
ALTER TABLE coupons DROP CONSTRAINT coupons_code_check;
ALTER TABLE coupons ADD CONSTRAINT coupons_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,23}$');
ALTER TABLE coupons ALTER COLUMN plan DROP NOT NULL;
ALTER TABLE coupons ALTER COLUMN months DROP NOT NULL;
ALTER TABLE coupons
  ADD COLUMN kind              text NOT NULL DEFAULT 'free_plan'
                               CHECK (kind IN ('free_plan', 'percent_off', 'trial_days', 'ai_tokens')),
  ADD COLUMN days              int CHECK (days BETWEEN 1 AND 365),
  ADD COLUMN percent           int CHECK (percent BETWEEN 1 AND 100),
  ADD COLUMN razorpay_offer_id text CHECK (razorpay_offer_id ~ '^offer_[A-Za-z0-9]{6,40}$'),
  ADD COLUMN plans             text[] NOT NULL DEFAULT '{}' CHECK (plans <@ ARRAY['starter', 'growth', 'scale']),
  ADD COLUMN periods           text[] NOT NULL DEFAULT '{}' CHECK (periods <@ ARRAY['monthly', 'annual']),
  ADD COLUMN tokens            bigint CHECK (tokens BETWEEN 1000 AND 1000000000),
  ADD COLUMN industries        text[] NOT NULL DEFAULT '{}'
                               CHECK (industries <@ ARRAY['agency', 'loans', 'kitchen', 'trade', 'retail', 'clinic',
                                                          'coaching', 'freelancer', 'other']),
  ADD COLUMN who               text NOT NULL DEFAULT 'unpaid' CHECK (who IN ('new', 'unpaid', 'anyone')),
  ADD COLUMN signup_days       int CHECK (signup_days BETWEEN 1 AND 365),
  ADD COLUMN emails            text[] NOT NULL DEFAULT '{}' CHECK (cardinality(emails) <= 500),
  ADD COLUMN domains           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(domains) <= 50),
  ADD COLUMN starts_at         timestamptz,
  ADD COLUMN created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN updated_at        timestamptz NOT NULL DEFAULT now();
ALTER TABLE coupons ADD CONSTRAINT coupons_offer_check CHECK (
     (kind = 'free_plan' AND plan IS NOT NULL AND (months IS NULL) <> (days IS NULL))
  OR (kind = 'percent_off' AND percent IS NOT NULL AND razorpay_offer_id IS NOT NULL)
  OR (kind = 'trial_days' AND days IS NOT NULL)
  OR (kind = 'ai_tokens' AND tokens IS NOT NULL AND months IS NOT NULL));
ALTER TABLE coupons ADD CONSTRAINT coupons_window_check
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at);

-- ----------------------------------------------------------------------------- redemptions --
ALTER TABLE coupon_redemptions DROP CONSTRAINT coupon_redemptions_pkey;
ALTER TABLE coupon_redemptions ALTER COLUMN plan DROP NOT NULL;
ALTER TABLE coupon_redemptions
  ADD COLUMN id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ADD COLUMN kind              text NOT NULL DEFAULT 'free_plan',
  ADD COLUMN percent           int,
  ADD COLUMN razorpay_offer_id text,
  ADD COLUMN plans             text[] NOT NULL DEFAULT '{}',
  ADD COLUMN periods           text[] NOT NULL DEFAULT '{}',
  ADD COLUMN tokens            bigint,
  ADD COLUMN days              int,
  ADD COLUMN months            int,
  ADD COLUMN used_at           timestamptz;       -- percent_off: when a subscription was paid with it
CREATE UNIQUE INDEX coupon_redemptions_org_kind_uq ON coupon_redemptions (org_id, kind);
UPDATE coupon_redemptions r SET months = c.months FROM coupons c WHERE c.code = r.code;

-- Which plan applies: a paid plan, else a running free_plan coupon, else the default.
CREATE OR REPLACE FUNCTION private.applied_plan(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p.plan IS NOT NULL AND p.plan <> 'free' THEN p.plan
              WHEN g.ends_at > now() THEN g.plan
              ELSE p.plan END
    FROM organisations o
    LEFT JOIN org_plans p ON p.org_id = o.id
    LEFT JOIN coupon_redemptions g ON g.org_id = o.id AND g.kind = 'free_plan'
   WHERE o.id = p_org
$$;

-- When the trial runs out: the trial, extra trial days from a coupon, or a free_plan coupon's end + 7 days.
CREATE OR REPLACE FUNCTION private.trial_end(p_org uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT greatest(o.trial_ends_at, g.ends_at + interval '7 days', t.ends_at)
    FROM organisations o
    LEFT JOIN coupon_redemptions g ON g.org_id = o.id AND g.kind = 'free_plan'
    LEFT JOIN coupon_redemptions t ON t.org_id = o.id AND t.kind = 'trial_days'
   WHERE o.id = p_org
$$;

-- Extra hosted-AI tokens this month from a running ai_tokens coupon (members, or the system).
CREATE FUNCTION public.coupon_bonus_tokens(p_org uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(r.tokens), 0)::bigint FROM coupon_redemptions r
   WHERE r.org_id = p_org AND r.kind = 'ai_tokens' AND r.ends_at > now()
     AND (p_org = ANY (private.member_orgs()) OR private.current_actor_type() = 'system')
$$;
GRANT EXECUTE ON FUNCTION public.coupon_bonus_tokens(uuid) TO kritvia_app;

-- A percent_off coupon the organisation can use for this plan and period now: (code, offer, percent).
CREATE FUNCTION private.coupon_offer(p_org uuid, p_plan text, p_period text)
RETURNS TABLE (code text, razorpay_offer_id text, percent int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.code, r.razorpay_offer_id, r.percent FROM coupon_redemptions r
   WHERE r.org_id = p_org AND r.kind = 'percent_off' AND r.used_at IS NULL AND r.ends_at > now()
     AND (cardinality(r.plans) = 0 OR p_plan = ANY (r.plans))
     AND (cardinality(r.periods) = 0 OR p_period = ANY (r.periods))
     AND (p_org = ANY (private.owned_orgs()) OR private.current_actor_type() = 'system')
$$;
GRANT EXECUTE ON FUNCTION private.coupon_offer(uuid, text, text) TO kritvia_app;

-- The webhook: the percent a subscription created with this coupon may be discounted by, and note it used.
CREATE FUNCTION private.coupon_paid(p_org uuid, p_code text, p_mark boolean) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pct int;
BEGIN
  SELECT percent INTO pct FROM coupon_redemptions
   WHERE org_id = p_org AND kind = 'percent_off' AND code = upper(p_code);
  IF pct IS NOT NULL AND p_mark THEN
    UPDATE coupon_redemptions SET used_at = coalesce(used_at, now())
     WHERE org_id = p_org AND kind = 'percent_off' AND code = upper(p_code);
  END IF;
  RETURN coalesce(pct, 0);
END $$;
GRANT EXECUTE ON FUNCTION private.coupon_paid(uuid, text, boolean) TO kritvia_app;

-- An owner applies a coupon to their organisation. Returns 'ok' or why not.
CREATE OR REPLACE FUNCTION private.use_coupon(p_org uuid, p_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c coupons; uid uuid := private.current_user_id(); paid text; email text; org organisations;
  ends timestamptz;
BEGIN
  IF uid IS NULL OR NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'organisation not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM coupons WHERE code = upper(trim(p_code)) FOR UPDATE;
  IF NOT FOUND OR NOT c.active THEN RETURN 'unknown'; END IF;
  IF c.starts_at IS NOT NULL AND c.starts_at > now() THEN RETURN 'not_started'; END IF;
  IF c.expires_at IS NOT NULL AND c.expires_at <= now() THEN RETURN 'unknown'; END IF;
  SELECT * INTO org FROM organisations WHERE id = p_org;
  IF org.closed_at IS NOT NULL THEN RETURN 'unknown'; END IF;
  SELECT lower(u.email) INTO email FROM users u WHERE u.id = uid;
  IF cardinality(c.emails) > 0 OR cardinality(c.domains) > 0 THEN
    IF NOT (email = ANY (c.emails) OR split_part(email, '@', 2) = ANY (c.domains)) THEN RETURN 'not_for_you'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM coupon_redemptions WHERE org_id = p_org AND kind = c.kind) THEN RETURN 'already'; END IF;
  IF EXISTS (SELECT 1 FROM coupon_redemptions WHERE code = c.code AND redeemed_by = uid) THEN RETURN 'person'; END IF;
  SELECT plan INTO paid FROM org_plans WHERE org_id = p_org;
  IF paid IS NOT NULL AND paid <> 'free' AND (c.who <> 'anyone' OR c.kind IN ('free_plan', 'trial_days')) THEN
    RETURN 'paid';
  END IF;
  IF c.who = 'new' THEN
    IF org.created_at < coalesce(c.starts_at, c.created_at) THEN RETURN 'not_new'; END IF;
    IF c.signup_days IS NOT NULL AND now() > org.created_at + make_interval(days => c.signup_days) THEN
      RETURN 'too_late';
    END IF;
  END IF;
  IF cardinality(c.industries) > 0 AND NOT EXISTS (
       SELECT 1 FROM ventures v LEFT JOIN venture_settings s ON s.venture_id = v.id
        WHERE v.org_id = p_org AND v.removed_at IS NULL
          AND private.venture_industry(s.industry, s.kind) = ANY (c.industries)) THEN
    RETURN 'industry';
  END IF;
  IF c.uses >= c.max_uses THEN RETURN 'full'; END IF;
  ends := CASE c.kind
            WHEN 'free_plan' THEN now() + make_interval(months => coalesce(c.months, 0), days => coalesce(c.days, 0))
            WHEN 'trial_days' THEN greatest(org.trial_ends_at, now()) + make_interval(days => c.days)
            WHEN 'ai_tokens' THEN now() + make_interval(months => c.months)
            ELSE coalesce(c.expires_at, now() + interval '1 year') END;
  UPDATE coupons SET uses = uses + 1 WHERE code = c.code;
  INSERT INTO coupon_redemptions (org_id, code, kind, plan, redeemed_by, ends_at, percent, razorpay_offer_id,
                                  plans, periods, tokens, days, months)
  VALUES (p_org, c.code, c.kind, c.plan, uid, ends, c.percent, c.razorpay_offer_id, c.plans, c.periods, c.tokens,
          c.days, c.months);
  RETURN 'ok';
END $$;

-- What a code gives (sign-up and billing pages). Private codes say only that they are private.
DROP FUNCTION public.coupon_places(text);
CREATE FUNCTION public.coupon_places(p_code text)
RETURNS TABLE (code text, kind text, plan text, months int, days int, percent int, tokens bigint, plans text[],
               periods text[], industries text[], who text, private boolean, places_left int, open boolean,
               starts_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.code, c.kind, c.plan, c.months, c.days, c.percent, c.tokens, c.plans, c.periods, c.industries, c.who,
         cardinality(c.emails) + cardinality(c.domains) > 0, greatest(c.max_uses - c.uses, 0),
         c.active AND (c.starts_at IS NULL OR c.starts_at <= now()) AND (c.expires_at IS NULL OR c.expires_at > now())
           AND c.uses < c.max_uses,
         c.starts_at, c.expires_at
    FROM coupons c WHERE c.code = upper(trim(p_code))
$$;
GRANT EXECUTE ON FUNCTION public.coupon_places(text) TO kritvia_app;

-- --------------------------------------------------------------------------------- Kritvia's team --
-- (The API lets only STAFF_EMAILS call these.)
DROP FUNCTION private.staff_coupons();
CREATE FUNCTION private.staff_coupons() RETURNS SETOF coupons
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM coupons ORDER BY created_at DESC
$$;
GRANT EXECUTE ON FUNCTION private.staff_coupons() TO kritvia_app;

CREATE FUNCTION private.staff_coupon_uses(p_code text)
RETURNS TABLE (code text, kind text, org_id uuid, org_name text, owner_email text, redeemed_at timestamptz,
               ends_at timestamptz, used_at timestamptz, paid_plan text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.code, r.kind, r.org_id, o.name, u.email, r.redeemed_at, r.ends_at, r.used_at, p.plan
    FROM coupon_redemptions r
    JOIN organisations o ON o.id = r.org_id
    LEFT JOIN users u ON u.id = r.redeemed_by
    LEFT JOIN org_plans p ON p.org_id = r.org_id AND p.plan <> 'free'
   WHERE p_code IS NULL OR r.code = p_code
   ORDER BY r.redeemed_at DESC
$$;
GRANT EXECUTE ON FUNCTION private.staff_coupon_uses(text) TO kritvia_app;

-- Create or change a coupon from a JSON object (the API validates the fields). Once used, the offer itself
-- (kind, plan, length, percent, offer id, tokens) can't change: make a new code instead.
CREATE FUNCTION private.staff_save_coupon(p jsonb, p_create boolean, p_by uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c coupons; v text := upper(p->>'code');
BEGIN
  SELECT * INTO c FROM coupons WHERE code = v FOR UPDATE;
  IF p_create THEN
    IF FOUND THEN RETURN 'exists'; END IF;
    INSERT INTO coupons (code, kind, plan, months, days, percent, razorpay_offer_id, plans, periods, tokens,
                         industries, who, signup_days, emails, domains, starts_at, expires_at, max_uses, note,
                         active, created_by)
    SELECT v, p->>'kind', p->>'plan', (p->>'months')::int, (p->>'days')::int, (p->>'percent')::int,
           p->>'razorpay_offer_id',
           ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'plans', '[]'))),
           ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'periods', '[]'))),
           (p->>'tokens')::bigint,
           ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'industries', '[]'))),
           p->>'who', (p->>'signup_days')::int,
           ARRAY(SELECT lower(jsonb_array_elements_text(coalesce(p->'emails', '[]')))),
           ARRAY(SELECT lower(jsonb_array_elements_text(coalesce(p->'domains', '[]')))),
           (p->>'starts_at')::timestamptz, (p->>'expires_at')::timestamptz, (p->>'max_uses')::int,
           p->>'note', coalesce((p->>'active')::boolean, true), p_by;
    RETURN 'ok';
  END IF;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF c.uses > 0 AND (c.kind IS DISTINCT FROM p->>'kind' OR c.plan IS DISTINCT FROM p->>'plan'
       OR c.months IS DISTINCT FROM (p->>'months')::int OR c.days IS DISTINCT FROM (p->>'days')::int
       OR c.percent IS DISTINCT FROM (p->>'percent')::int OR c.tokens IS DISTINCT FROM (p->>'tokens')::bigint
       OR c.razorpay_offer_id IS DISTINCT FROM p->>'razorpay_offer_id') THEN
    RETURN 'used';
  END IF;
  UPDATE coupons SET kind = p->>'kind', plan = p->>'plan', months = (p->>'months')::int, days = (p->>'days')::int,
         percent = (p->>'percent')::int, razorpay_offer_id = p->>'razorpay_offer_id',
         plans = ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'plans', '[]'))),
         periods = ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'periods', '[]'))),
         tokens = (p->>'tokens')::bigint,
         industries = ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'industries', '[]'))),
         who = p->>'who', signup_days = (p->>'signup_days')::int,
         emails = ARRAY(SELECT lower(jsonb_array_elements_text(coalesce(p->'emails', '[]')))),
         domains = ARRAY(SELECT lower(jsonb_array_elements_text(coalesce(p->'domains', '[]')))),
         starts_at = (p->>'starts_at')::timestamptz, expires_at = (p->>'expires_at')::timestamptz,
         max_uses = greatest((p->>'max_uses')::int, c.uses), note = p->>'note',
         active = coalesce((p->>'active')::boolean, c.active), updated_at = now()
   WHERE code = v;
  RETURN 'ok';
END $$;
GRANT EXECUTE ON FUNCTION private.staff_save_coupon(jsonb, boolean, uuid) TO kritvia_app;

CREATE FUNCTION private.staff_delete_coupon(p_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM coupon_redemptions WHERE code = p_code) THEN RETURN 'used'; END IF;
  DELETE FROM coupons WHERE code = p_code;
  RETURN CASE WHEN FOUND THEN 'ok' ELSE 'missing' END;
END $$;
GRANT EXECUTE ON FUNCTION private.staff_delete_coupon(text) TO kritvia_app;
