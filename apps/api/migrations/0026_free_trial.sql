-- =============================================================================
-- Kritvia 0026 — The Free plan becomes a 15-day free trial.
--
--   * organisations.trial_ends_at: 15 days after the organisation is created. Organisations
--     that exist today get 15 days from this migration, so no one loses access overnight.
--   * When the trial is over and no paid plan has been chosen, the API treats the organisation
--     as read-only (plan "expired" in plans.py): people can sign in, view, export and delete,
--     but agents stop and nothing new is added. Until online payment is live (PAYMENTS_LIVE_AT
--     in the API settings) trials are held open: they end 15 days after sign-up or 3 days after
--     payments go live, whichever is later.
--   * org_plan_state / venture_plan_state: the plan and trial end, for members (and the system).
-- =============================================================================
ALTER TABLE organisations ADD COLUMN trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '15 days';
GRANT SELECT (trial_ends_at) ON organisations TO kritvia_app;

CREATE FUNCTION public.org_plan_state(p_org uuid)
RETURNS TABLE (plan text, trial_ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.plan, o.trial_ends_at FROM organisations o LEFT JOIN org_plans p ON p.org_id = o.id
   WHERE o.id = p_org AND (p_org = ANY (private.member_orgs()) OR private.current_actor_type() = 'system')
$$;
GRANT EXECUTE ON FUNCTION public.org_plan_state(uuid) TO kritvia_app;

CREATE FUNCTION public.venture_plan_state(p_venture uuid)
RETURNS TABLE (org_id uuid, plan text, trial_ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.org_id, p.plan, o.trial_ends_at
    FROM ventures v JOIN organisations o ON o.id = v.org_id LEFT JOIN org_plans p ON p.org_id = v.org_id
   WHERE v.id = p_venture
     AND (v.org_id = ANY (private.member_orgs()) OR private.current_actor_type() = 'system')
$$;
GRANT EXECUTE ON FUNCTION public.venture_plan_state(uuid) TO kritvia_app;

-- Organisations this person owns that have no paid plan (each person gets one free trial).
CREATE FUNCTION public.my_unpaid_owned_orgs() RETURNS TABLE (org_id uuid, name text, plan text, trial_ends_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.name, p.plan, o.trial_ends_at
    FROM memberships m JOIN organisations o ON o.id = m.org_id LEFT JOIN org_plans p ON p.org_id = o.id
   WHERE m.user_id = private.current_user_id() AND m.role = 'org_owner' AND o.closed_at IS NULL
     AND (p.plan IS NULL OR p.plan = 'free')
$$;
GRANT EXECUTE ON FUNCTION public.my_unpaid_owned_orgs() TO kritvia_app;
