-- =============================================================================
-- 0066 Always on (24x7).
--
--   workflow_runs.retries / next_retry_at   a run that fails for a passing reason (a timeout, an AI provider
--                                           or Google answering 5xx/429, a dropped connection, a database
--                                           deadlock) is queued again by itself: after 2, 10 and 60 minutes,
--                                           then it stays failed and the owner sees it as before
--   system_heartbeats                       each worker writes its heartbeat every 30 s; the API's /livez and
--                                           the server's watchdog read them (a stale one restarts the worker)
--   platform_alerts                         the in-app watchdog's alerts to Kritvia's team, deduplicated
--   private.watchdog_stats()                counts only: queue age, stuck and failed runs, failing AI calls
-- =============================================================================

ALTER TABLE workflow_runs
  ADD COLUMN retries       int NOT NULL DEFAULT 0 CHECK (retries BETWEEN 0 AND 10),
  ADD COLUMN next_retry_at timestamptz;
CREATE INDEX workflow_runs_retry_idx ON workflow_runs (next_retry_at) WHERE status = 'queued' AND next_retry_at IS NOT NULL;

CREATE OR REPLACE FUNCTION private.runnable_runs(p_limit int) RETURNS TABLE (run_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, run_as FROM workflow_runs
   WHERE (status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now()))
      OR (status = 'running' AND lease_until < now())
   ORDER BY updated_at LIMIT p_limit
$$;

-- Platform-level tables: no tenant data, read and written only through these functions.
CREATE TABLE system_heartbeats (
  name       text PRIMARY KEY CHECK (name ~ '^[a-z0-9_-]{2,40}$'),
  worker_id  text,
  beat_at    timestamptz NOT NULL DEFAULT now(),
  info       jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE system_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_heartbeats FORCE ROW LEVEL SECURITY;

CREATE TABLE platform_alerts (
  key          text PRIMARY KEY CHECK (char_length(key) <= 80),
  detail       text CHECK (char_length(detail) <= 1000),
  first_at     timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  resolved_at  timestamptz
);
ALTER TABLE platform_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_alerts FORCE ROW LEVEL SECURITY;

CREATE FUNCTION private.heartbeat(p_name text, p_worker text, p_info jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO system_heartbeats (name, worker_id, beat_at, info) VALUES (p_name, p_worker, now(), coalesce(p_info, '{}'))
  ON CONFLICT (name) DO UPDATE SET worker_id = EXCLUDED.worker_id, beat_at = now(), info = EXCLUDED.info
$$;
GRANT EXECUTE ON FUNCTION private.heartbeat(text, text, jsonb) TO kritvia_app;

-- Seconds since each heartbeat (anyone may read: names and ages only).
CREATE FUNCTION public.heartbeat_ages() RETURNS TABLE (name text, age_s int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT name, extract(epoch FROM now() - beat_at)::int FROM system_heartbeats
$$;
GRANT EXECUTE ON FUNCTION public.heartbeat_ages() TO kritvia_app;

CREATE FUNCTION public.watchdog_stats()
RETURNS TABLE (queued int, oldest_queued_s int, stuck int, retrying int, failed_15m int, ai_calls_15m int,
               ai_failed_15m int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    (SELECT count(*)::int FROM workflow_runs WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now())),
    coalesce((SELECT extract(epoch FROM now() - min(updated_at))::int FROM workflow_runs
               WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now())), 0),
    (SELECT count(*)::int FROM workflow_runs WHERE status = 'running' AND lease_until < now() - interval '5 minutes'),
    (SELECT count(*)::int FROM workflow_runs WHERE status = 'queued' AND next_retry_at > now()),
    (SELECT count(*)::int FROM workflow_runs WHERE status = 'failed' AND finished_at > now() - interval '15 minutes'),
    (SELECT count(*)::int FROM model_calls WHERE created_at > now() - interval '15 minutes'),
    (SELECT count(*)::int FROM model_calls WHERE created_at > now() - interval '15 minutes' AND status <> 'ok')
$$;
GRANT EXECUTE ON FUNCTION public.watchdog_stats() TO kritvia_app;

-- An alert for Kritvia's team: true when it should be sent now (new, or still open after p_every minutes).
CREATE FUNCTION private.platform_alert(p_key text, p_detail text, p_every int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a platform_alerts;
BEGIN
  SELECT * INTO a FROM platform_alerts WHERE key = p_key FOR UPDATE;
  IF NOT FOUND OR a.resolved_at IS NOT NULL THEN
    INSERT INTO platform_alerts (key, detail, first_at, last_sent_at, resolved_at)
    VALUES (p_key, p_detail, now(), now(), NULL)
    ON CONFLICT (key) DO UPDATE SET detail = p_detail, first_at = now(), last_sent_at = now(), resolved_at = NULL;
    RETURN true;
  END IF;
  IF a.last_sent_at < now() - make_interval(mins => p_every) THEN
    UPDATE platform_alerts SET detail = p_detail, last_sent_at = now() WHERE key = p_key;
    RETURN true;
  END IF;
  UPDATE platform_alerts SET detail = p_detail WHERE key = p_key;
  RETURN false;
END $$;
GRANT EXECUTE ON FUNCTION private.platform_alert(text, text, int) TO kritvia_app;

-- Closes alerts that are no longer firing; returns the ones just resolved (to say "recovered").
CREATE FUNCTION private.platform_alerts_resolve(p_open text[]) RETURNS SETOF text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE platform_alerts SET resolved_at = now()
   WHERE resolved_at IS NULL AND NOT (key = ANY (p_open)) RETURNING key
$$;
GRANT EXECUTE ON FUNCTION private.platform_alerts_resolve(text[]) TO kritvia_app;

-- A failed run that failed for a passing reason: back on the queue after a pause (2, 10, 60 minutes).
CREATE FUNCTION private.retry_later(p_run uuid, p_error text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  UPDATE workflow_runs SET status = 'queued', retries = retries + 1, error = p_error, finished_at = NULL,
         lease_owner = NULL, lease_until = NULL, updated_at = now(),
         next_retry_at = now() + CASE retries WHEN 0 THEN interval '2 minutes' WHEN 1 THEN interval '10 minutes'
                                              ELSE interval '60 minutes' END
   WHERE id = p_run AND status = 'failed' AND retries < 3
  RETURNING retries INTO n;
  RETURN coalesce(n, 0);
END $$;
GRANT EXECUTE ON FUNCTION private.retry_later(uuid, text) TO kritvia_app;
