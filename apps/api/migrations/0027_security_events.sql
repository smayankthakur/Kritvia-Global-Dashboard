-- =============================================================================
-- Kritvia 0027 — Security event log, AI guardrail flags, per-person AI metering.
--
--   * security_events: append-only record of security-relevant events (failed sign-ins,
--     lock-outs, bad webhook signatures and replays, payment mismatches, suspected prompt
--     injection, refused uploads). No business content and no email addresses: a person is
--     identified by user id or by a keyed hash of the address. Written only through
--     public.security_event(); the app role can't read, change or delete rows. Kept one year.
--   * workflow_runs.flagged_at / flag_reason: a run that read text trying to give the AI
--     instructions. Its drafts always wait for a person, whatever autonomy the agent earned.
--   * model_calls.user_id: who asked, for interactive AI, so one person can't use up the whole
--     organisation's allowance (per-person daily cap in services/model_router.py).
-- =============================================================================
CREATE TABLE security_events (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z_]*(\.[a-z_]+)+$' AND char_length(kind) <= 64),
  severity    text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  ip          text CHECK (ip IS NULL OR char_length(ip) <= 64),
  user_id     uuid,
  org_id      uuid,
  subject     text CHECK (subject IS NULL OR char_length(subject) <= 64),   -- keyed hash, never an email
  details     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object' AND pg_column_size(details) <= 4096)
);
CREATE INDEX security_events_at_idx ON security_events (at DESC);
CREATE INDEX security_events_kind_idx ON security_events (kind, at DESC);
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.security_event(p_kind text, p_severity text, p_ip text, p_user uuid, p_org uuid,
                                      p_subject text, p_details jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO security_events (kind, severity, ip, user_id, org_id, subject, details)
  VALUES (p_kind, p_severity, left(p_ip, 64), p_user, p_org, left(p_subject, 64), coalesce(p_details, '{}'))
$$;
GRANT EXECUTE ON FUNCTION public.security_event(text, text, text, uuid, uuid, text, jsonb) TO kritvia_app;

-- For the health watchdog: how many critical and warning events in the last N minutes.
CREATE FUNCTION private.security_alert_counts(p_minutes int)
RETURNS TABLE (critical bigint, warning bigint, top_kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*) FILTER (WHERE severity = 'critical'),
         count(*) FILTER (WHERE severity = 'warning'),
         (SELECT kind FROM security_events WHERE at > now() - make_interval(mins => p_minutes)
           AND severity <> 'info' GROUP BY kind ORDER BY count(*) DESC LIMIT 1)
    FROM security_events WHERE at > now() - make_interval(mins => p_minutes)
$$;

CREATE FUNCTION private.purge_security_events(p_days int) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (DELETE FROM security_events WHERE at < now() - make_interval(days => p_days) RETURNING 1)
  SELECT count(*)::int FROM d
$$;
GRANT EXECUTE ON FUNCTION private.purge_security_events(int) TO kritvia_app;

-- Guardrail flag on runs.
ALTER TABLE workflow_runs ADD COLUMN flagged_at timestamptz, ADD COLUMN flag_reason text
  CHECK (flag_reason IS NULL OR char_length(flag_reason) <= 200);
CREATE FUNCTION public.flag_run(p_run uuid, p_reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE workflow_runs SET flagged_at = coalesce(flagged_at, now()), flag_reason = coalesce(flag_reason, left(p_reason, 200))
   WHERE id = p_run
$$;
GRANT EXECUTE ON FUNCTION public.flag_run(uuid, text) TO kritvia_app;
CREATE FUNCTION public.run_flagged(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT flagged_at IS NOT NULL FROM workflow_runs WHERE id = p_run), false)
$$;
GRANT EXECUTE ON FUNCTION public.run_flagged(uuid) TO kritvia_app;

-- Who asked, for interactive calls.
ALTER TABLE model_calls ADD COLUMN user_id uuid;
CREATE INDEX model_calls_user_day_idx ON model_calls (user_id, created_at) WHERE user_id IS NOT NULL;

CREATE FUNCTION public.user_tokens_today(p_user uuid, p_local text[]) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0)::bigint
    FROM model_calls
   WHERE user_id = p_user AND status = 'ok' AND NOT (coalesce(provider_model, '') = ANY (p_local))
     AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
$$;
GRANT EXECUTE ON FUNCTION public.user_tokens_today(uuid, text[]) TO kritvia_app;
