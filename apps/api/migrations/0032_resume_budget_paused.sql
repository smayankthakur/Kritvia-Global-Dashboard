-- =============================================================================
-- 0032 Runs paused by an agent's monthly budget resume on their own.
--
-- When an agent uses the monthly token budget its owner set on the board, its runs park
-- (workflow_runs.status = 'waiting', summary.blocked = 'budget') on the step that needed the AI.
-- Until now each one had to be retried by hand. They now go back on the queue by themselves
-- when there is budget again: the owner raised or cleared the budget, or a new month (IST)
-- began. The worker calls this every 10 minutes; the board calls it straight after a budget
-- change. Only the queue status changes; the run's checkpoint and state are untouched.
--
-- Usage is counted here directly, not with agent_usage(), because the worker has no user and
-- agent_usage() only counts ventures the caller can read.
-- =============================================================================
CREATE FUNCTION private.resume_budget_paused(p_local text[], p_venture uuid DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS TABLE (run_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
BEGIN
  -- Called by a person (the board) only for a business they may manage; the worker (no user) for all.
  IF p_venture IS NOT NULL AND private.current_user_id() IS NOT NULL
     AND NOT (p_venture = ANY (private.writable_ventures())) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  WITH ready AS (
    SELECT r.id
      FROM workflow_runs r
      JOIN workflow_configs c ON c.venture_id = r.venture_id AND c.workflow = r.workflow
     WHERE r.status = 'waiting'
       AND r.summary ->> 'blocked' = 'budget'
       AND (p_venture IS NULL OR r.venture_id = p_venture)
       AND c.enabled
       AND (c.monthly_tokens IS NULL OR c.monthly_tokens > (
             SELECT coalesce(sum(coalesce(m.prompt_tokens, 0) + coalesce(m.completion_tokens, 0)), 0)
               FROM model_calls m
              WHERE m.venture_id = r.venture_id AND m.workflow = r.workflow AND m.status = 'ok'
                AND NOT (coalesce(m.provider_model, '') = ANY (p_local))
                AND m.created_at >= month_start))
     ORDER BY r.updated_at
     LIMIT p_limit
     FOR UPDATE OF r SKIP LOCKED
  ), resumed AS (
    UPDATE workflow_runs w SET status = 'queued', summary = w.summary - 'blocked', error = NULL, updated_at = now()
      FROM ready WHERE w.id = ready.id
    RETURNING w.id
  ), cards AS (
    UPDATE tickets t SET status = 'open', note = 'Resumed: the agent has budget again', updated_at = now()
      FROM resumed WHERE t.run_id = resumed.id
    RETURNING t.run_id
  )
  SELECT resumed.id FROM resumed;
END $$;
GRANT EXECUTE ON FUNCTION private.resume_budget_paused(text[], uuid, int) TO kritvia_app;
