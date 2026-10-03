-- =============================================================================
-- Kritvia 0010 — Plans and limits per organisation.
--
-- org_plans      the organisation's plan (free when absent). Written only through
--                public.set_org_plan, called by the billing webhook after a verified
--                payment event; members can read their own org's row.
-- Organisations that existed before plans (the founder's own) are 'internal' (no limits).
-- =============================================================================
CREATE TABLE org_plans (
  org_id      uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  plan        text NOT NULL CHECK (plan IN ('free', 'starter', 'pro', 'internal')),
  renews_at   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE org_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY org_plans_member_read ON org_plans FOR SELECT
  USING (org_id = ANY (private.member_orgs()));
GRANT SELECT ON org_plans TO kritvia_app;

INSERT INTO org_plans (org_id, plan) SELECT id, 'internal' FROM organisations ON CONFLICT DO NOTHING;

CREATE FUNCTION public.set_org_plan(p_org uuid, p_plan text, p_renews timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO org_plans (org_id, plan, renews_at) VALUES (p_org, p_plan, p_renews)
  ON CONFLICT (org_id) DO UPDATE SET plan = EXCLUDED.plan, renews_at = EXCLUDED.renews_at, updated_at = now()
$$;

-- Plan (NULL = default plan) + hosted-model tokens used this calendar month (IST) + counts, for limits.
CREATE FUNCTION public.org_usage(p_org uuid, p_local text[])
RETURNS TABLE (plan text, tokens bigint, ventures bigint, members bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT o.plan FROM org_plans o WHERE o.org_id = p_org),
         coalesce((SELECT sum(coalesce(m.prompt_tokens, 0) + coalesce(m.completion_tokens, 0))
                     FROM model_calls m
                    WHERE m.org_id = p_org AND m.status = 'ok'
                      AND NOT (coalesce(m.provider_model, '') = ANY (p_local))
                      AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
                                          AT TIME ZONE 'Asia/Kolkata'), 0)::bigint,
         (SELECT count(*) FROM ventures v WHERE v.org_id = p_org),
         (SELECT count(DISTINCT ms.user_id) FROM memberships ms JOIN users u ON u.id = ms.user_id
           WHERE ms.org_id = p_org AND NOT u.is_service)
   WHERE p_org = ANY (private.member_orgs())   -- only for members of that organisation
$$;

GRANT EXECUTE ON FUNCTION public.set_org_plan(uuid, text, timestamptz), public.org_usage(uuid, text[]) TO kritvia_app;
