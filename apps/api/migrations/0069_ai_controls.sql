-- =============================================================================
-- 0069 AI controls (pre-launch audit, S10): what the platform spent on AI in the last 24 hours, for the
-- watchdog's spend alert (AI_DAILY_SPEND_ALERT_USD). The kill switch itself is a setting (AI_PAUSED).
-- =============================================================================
CREATE FUNCTION private.ai_spend_24h() RETURNS TABLE (cost_usd numeric, calls bigint, tokens bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(cost_usd), 0), count(*), coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0)
    FROM model_calls WHERE created_at > now() - interval '24 hours' AND status = 'ok'
$$;
GRANT EXECUTE ON FUNCTION private.ai_spend_24h() TO kritvia_app;

-- Is a platform alert still open (between the spend checks the watchdog keeps it open instead of resolving it)?
CREATE FUNCTION private.platform_alert_open(p_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM platform_alerts WHERE key = p_key AND resolved_at IS NULL)
$$;
GRANT EXECUTE ON FUNCTION private.platform_alert_open(text) TO kritvia_app;
