-- =============================================================================
-- Kritvia 0023 — Pricing 2026–27: Free, Starter, Growth, Scale, Enterprise.
--
--   * "pro" becomes "growth"; "scale" and "enterprise" are new plan codes.
--   * org_usage also reports business-memory storage (bytes of documents, recordings and
--     loan files across the organisation's businesses still in use).
--   * venture_plan(v): the plan of a business's organisation, for agents and run checks.
--   * limit_autonomy(org, cap): after a downgrade, keeps at most `cap` earned autonomous
--     actions per agent (most recently granted first); cap 0 switches them all off.
-- =============================================================================
ALTER TABLE org_plans DROP CONSTRAINT IF EXISTS org_plans_plan_check;
UPDATE org_plans SET plan = 'growth' WHERE plan = 'pro';
ALTER TABLE org_plans ADD CONSTRAINT org_plans_plan_check
  CHECK (plan IN ('free', 'starter', 'growth', 'scale', 'enterprise', 'internal'));

DROP FUNCTION public.org_usage(uuid, text[]);
CREATE FUNCTION public.org_usage(p_org uuid, p_local text[])
RETURNS TABLE (plan text, tokens bigint, ventures bigint, members bigint, storage bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT o.plan FROM org_plans o WHERE o.org_id = p_org),
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
GRANT EXECUTE ON FUNCTION public.org_usage(uuid, text[]) TO kritvia_app;

CREATE FUNCTION public.venture_plan(p_venture uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.plan FROM ventures v LEFT JOIN org_plans o ON o.org_id = v.org_id
   WHERE v.id = p_venture AND v.org_id = ANY (private.member_orgs())
$$;
GRANT EXECUTE ON FUNCTION public.venture_plan(uuid) TO kritvia_app;

-- Called by the billing webhook (system context) after a plan change.
CREATE FUNCTION public.limit_autonomy(p_org uuid, p_cap int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF coalesce(private.current_actor_type(), '') <> 'system' AND NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  WITH ranked AS (
    SELECT venture_id, agent, action,
           row_number() OVER (PARTITION BY venture_id, agent ORDER BY promoted_at DESC NULLS LAST) AS rn
      FROM agent_trust WHERE org_id = p_org AND auto_run)
  UPDATE agent_trust t SET auto_run = false, updated_at = now()
    FROM ranked r
   WHERE t.venture_id = r.venture_id AND t.agent = r.agent AND t.action = r.action AND r.rn > p_cap;
  GET DIAGNOSTICS n = ROW_COUNT;   -- each change is in the audit log through agent_trust's row trigger
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION public.limit_autonomy(uuid, int) TO kritvia_app;
