-- =============================================================================
-- Kritvia 0049 — Coupons: a plan for free for a few months, for the first N organisations.
--
-- coupons             one row per code (e.g. FIRST50: Scale, 3 months, 50 places).
-- coupon_redemptions  one per organisation (and one per person per code). While ends_at is in
--                     the future, an organisation that has no paid plan runs on the coupon's plan.
--                     Afterwards it is back on the Free plan, with 7 days to choose a plan before it
--                     becomes read-only (the trial end moves to ends_at + 7 days). A paid plan always
--                     wins over a coupon.
-- private.applied_plan(org) is now the one place that says which plan applies; the plan-state
-- functions below read it instead of org_plans directly.
-- =============================================================================

CREATE TABLE coupons (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{4,20}$'),
  plan        text NOT NULL CHECK (plan IN ('starter', 'growth', 'scale')),
  months      int NOT NULL CHECK (months BETWEEN 1 AND 12),
  max_uses    int NOT NULL CHECK (max_uses BETWEEN 1 AND 100000),
  uses        int NOT NULL DEFAULT 0 CHECK (uses >= 0),
  active      boolean NOT NULL DEFAULT true,
  expires_at  timestamptz,
  note        text CHECK (char_length(note) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (uses <= max_uses)
);
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons FORCE ROW LEVEL SECURITY;

CREATE TABLE coupon_redemptions (
  org_id       uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  code         text NOT NULL REFERENCES coupons(code),
  plan         text NOT NULL,
  redeemed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  redeemed_at  timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX coupon_redemptions_person_uq ON coupon_redemptions (code, redeemed_by);
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY coupon_redemptions_member_read ON coupon_redemptions FOR SELECT
  USING (org_id = ANY (private.member_orgs()));
GRANT SELECT ON coupon_redemptions TO kritvia_app;

-- The launch offer: the first 50 organisations get the Scale plan free for 3 months.
INSERT INTO coupons (code, plan, months, max_uses, note)
VALUES ('FIRST50', 'scale', 3, 50, 'Launch offer: Scale free for 3 months, first 50 businesses');

-- Which plan applies to an organisation now (NULL = the default plan).
CREATE FUNCTION private.applied_plan(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p.plan IS NOT NULL AND p.plan <> 'free' THEN p.plan
              WHEN g.ends_at > now() THEN g.plan
              ELSE p.plan END
    FROM organisations o
    LEFT JOIN org_plans p ON p.org_id = o.id
    LEFT JOIN coupon_redemptions g ON g.org_id = o.id
   WHERE o.id = p_org
$$;
REVOKE ALL ON FUNCTION private.applied_plan(uuid) FROM PUBLIC;

-- When the trial (or a coupon's free months, plus 7 days to choose a plan) runs out.
CREATE FUNCTION private.trial_end(p_org uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT greatest(o.trial_ends_at, g.ends_at + interval '7 days')
    FROM organisations o LEFT JOIN coupon_redemptions g ON g.org_id = o.id
   WHERE o.id = p_org
$$;
REVOKE ALL ON FUNCTION private.trial_end(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.org_plan_state(p_org uuid)
RETURNS TABLE (plan text, trial_ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT private.applied_plan(o.id), private.trial_end(o.id) FROM organisations o
   WHERE o.id = p_org AND (p_org = ANY (private.member_orgs()) OR private.current_actor_type() = 'system')
$$;

CREATE OR REPLACE FUNCTION public.venture_plan_state(p_venture uuid)
RETURNS TABLE (org_id uuid, plan text, trial_ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.org_id, private.applied_plan(v.org_id), private.trial_end(v.org_id)
    FROM ventures v
   WHERE v.id = p_venture
     AND (v.org_id = ANY (private.member_orgs()) OR private.current_actor_type() = 'system')
$$;

CREATE OR REPLACE FUNCTION public.venture_plan(p_venture uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT private.applied_plan(v.org_id) FROM ventures v
   WHERE v.id = p_venture AND v.org_id = ANY (private.member_orgs())
$$;

CREATE OR REPLACE FUNCTION public.org_usage(p_org uuid, p_local text[])
RETURNS TABLE (plan text, tokens bigint, ventures bigint, members bigint, storage bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT private.applied_plan(p_org),
         coalesce((SELECT sum(coalesce(m.prompt_tokens, 0) + coalesce(m.completion_tokens, 0))
                     FROM model_calls m
                    WHERE m.org_id = p_org AND m.status = 'ok'
                      AND NOT (coalesce(m.provider_model, '') = ANY (p_local))
                      AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
                                          AT TIME ZONE 'Asia/Kolkata'), 0)::bigint,
         (SELECT count(*) FROM ventures v WHERE v.org_id = p_org AND v.removed_at IS NULL),
         (SELECT count(DISTINCT ms.user_id) FROM memberships ms JOIN users u ON u.id = ms.user_id
           WHERE ms.org_id = p_org AND NOT u.is_service),
         coalesce((SELECT sum(d.size_bytes) FROM documents d JOIN ventures v ON v.id = d.venture_id
                    WHERE d.org_id = p_org AND v.removed_at IS NULL), 0)::bigint
   WHERE p_org = ANY (private.member_orgs())   -- only for members of that organisation
$$;

-- An owner applies a coupon to their organisation. Returns 'ok' or why not.
CREATE FUNCTION private.use_coupon(p_org uuid, p_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c coupons; uid uuid := private.current_user_id(); paid text;
BEGIN
  IF uid IS NULL OR NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'organisation not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO c FROM coupons WHERE code = upper(trim(p_code)) FOR UPDATE;
  IF NOT FOUND OR NOT c.active OR (c.expires_at IS NOT NULL AND c.expires_at <= now()) THEN RETURN 'unknown'; END IF;
  IF EXISTS (SELECT 1 FROM coupon_redemptions WHERE org_id = p_org) THEN RETURN 'already'; END IF;
  IF EXISTS (SELECT 1 FROM coupon_redemptions WHERE code = c.code AND redeemed_by = uid) THEN RETURN 'person'; END IF;
  SELECT plan INTO paid FROM org_plans WHERE org_id = p_org;
  IF paid IS NOT NULL AND paid <> 'free' THEN RETURN 'paid'; END IF;
  IF EXISTS (SELECT 1 FROM organisations WHERE id = p_org AND closed_at IS NOT NULL) THEN RETURN 'unknown'; END IF;
  IF c.uses >= c.max_uses THEN RETURN 'full'; END IF;
  UPDATE coupons SET uses = uses + 1 WHERE code = c.code;
  INSERT INTO coupon_redemptions (org_id, code, plan, redeemed_by, ends_at)
  VALUES (p_org, c.code, c.plan, uid, now() + make_interval(months => c.months));
  RETURN 'ok';
END $$;
GRANT EXECUTE ON FUNCTION private.use_coupon(uuid, text) TO kritvia_app;

-- How many places a code has left (shown on the sign-up and billing pages).
CREATE FUNCTION public.coupon_places(p_code text)
RETURNS TABLE (code text, plan text, months int, places_left int, open boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.code, c.plan, c.months, greatest(c.max_uses - c.uses, 0),
         c.active AND (c.expires_at IS NULL OR c.expires_at > now()) AND c.uses < c.max_uses
    FROM coupons c WHERE c.code = upper(trim(p_code))
$$;
GRANT EXECUTE ON FUNCTION public.coupon_places(text) TO kritvia_app;

-- Kritvia's team: codes and who used them.
CREATE FUNCTION private.staff_coupons()
RETURNS TABLE (code text, plan text, months int, max_uses int, uses int, active boolean, expires_at timestamptz,
               note text, org_id uuid, org_name text, owner_email text, redeemed_at timestamptz, ends_at timestamptz,
               paid_plan text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.code, c.plan, c.months, c.max_uses, c.uses, c.active, c.expires_at, c.note,
         r.org_id, o.name, u.email, r.redeemed_at, r.ends_at, p.plan
    FROM coupons c
    LEFT JOIN coupon_redemptions r ON r.code = c.code
    LEFT JOIN organisations o ON o.id = r.org_id
    LEFT JOIN users u ON u.id = r.redeemed_by
    LEFT JOIN org_plans p ON p.org_id = r.org_id AND p.plan <> 'free'
   ORDER BY c.created_at, r.redeemed_at
$$;
GRANT EXECUTE ON FUNCTION private.staff_coupons() TO kritvia_app;

CREATE FUNCTION private.staff_set_coupon(p_code text, p_active boolean, p_max int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE coupons SET active = p_active, max_uses = greatest(coalesce(p_max, max_uses), uses) WHERE code = p_code
$$;
GRANT EXECUTE ON FUNCTION private.staff_set_coupon(text, boolean, int) TO kritvia_app;
