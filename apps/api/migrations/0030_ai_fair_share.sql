-- =============================================================================
-- 0030 Fair share of the free AI pool.
--
-- Kritvia's free hosted models (Groq, Cerebras, Cloudflare free tiers) have daily limits that all
-- customers share. One busy business must not use up the day for everyone else, so each
-- organisation gets a fair share of the pool each day (services/model_router.py). Past its share,
-- its steps run on its own keys, a paid model or Kritvia's own server instead.
--
-- This function reports the organisation's free-pool tokens today (IST) and how many
-- organisations used the pool today. Only counts are returned, never content.
-- =============================================================================
CREATE INDEX model_calls_day_idx ON model_calls (created_at);

CREATE FUNCTION public.ai_pool_today(p_org uuid, p_pool text[])
RETURNS TABLE (org_tokens bigint, active_orgs int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH today AS (
    SELECT org_id, coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0) AS tokens
      FROM model_calls
     WHERE status = 'ok' AND provider_model = ANY (p_pool)
       AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
  )
  SELECT coalesce((SELECT sum(tokens) FROM today WHERE org_id = p_org), 0)::bigint,
         (SELECT count(DISTINCT org_id) FROM today)::int
$$;
GRANT EXECUTE ON FUNCTION public.ai_pool_today(uuid, text[]) TO kritvia_app;
