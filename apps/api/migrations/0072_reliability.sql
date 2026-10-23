-- =============================================================================
-- 0072 Reliability (test report round 2: P2, P3, P4, P5, P13, P15, P16, P1).
--
--   workflow_runs.reclaims         how many times in a row a run's lease ran out without its step finishing
--   private.reclaim_runs(l, max)   the sweeper: expired leases go back to 'queued' (counted); after `max`
--                                  in a row the run fails with a clear message instead of looping (P2)
--   private.retry_failed_execution an approved send that is recorded as failed may run again (P4)
--   claimed_until on automations, custom_workflows, skills, team_roles
--                                  the every-minute claims are 15-minute leases; next_run_at stays the due
--                                  time (a worker stopped mid-loop leaves nothing stranded) (P3)
--   business_events.claimed_at / dispatch_attempts, private.events_done
--                                  events are marked dispatched only once acted on (P3)
--   scheduled_job_runs, private.claim_daily_job
--                                  daily jobs run once a day after their time, caught up the same day (P1)
--   private.purge_run_history / purge_model_calls / purge_trigger_events
--                                  retention for the tables every message grows (P13)
--   idempotency_keys               Idempotency-Key replays for API-key requests (P16)
--   email_suppressions             addresses that hard-bounced or complained (SES feedback) (P15)
--   public.my_security_events()    the security record about the signed-in person, for their export (P14)
--
-- Short locks only: new nullable columns or constant defaults, function swaps, and indexes on tables that
-- are still small.
-- =============================================================================

-- ---------------------------------------------------------------------------------------------- P2 --
ALTER TABLE workflow_runs ADD COLUMN reclaims int NOT NULL DEFAULT 0;

CREATE FUNCTION private.reclaim_runs(p_limit int, p_max int) RETURNS TABLE (run_id uuid, run_as uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  -- A step that stopped p_max times in a row without finishing (it keeps running out of time, or the
  -- worker keeps dying on it): fail the run, so it doesn't spend AI tokens forever.
  FOR r IN
    UPDATE workflow_runs w SET status = 'failed', lease_owner = NULL, lease_until = NULL, finished_at = now(),
           updated_at = now(),
           error = 'Stopped: this step ran out of time (or the worker restarted) ' || p_max
                   || ' times in a row. Retry it when you are ready.'
     WHERE w.id IN (SELECT id FROM workflow_runs WHERE status = 'running' AND lease_until < now()
                     AND reclaims >= p_max LIMIT p_limit FOR UPDATE SKIP LOCKED)
    RETURNING w.id
  LOOP
    UPDATE tickets t SET status = 'blocked', note = 'Stopped: a step kept running out of time', updated_at = now()
     WHERE t.run_id = r.id;
  END LOOP;
  -- Other expired leases: back on the queue, counted.
  UPDATE workflow_runs w SET status = 'queued', reclaims = reclaims + 1, lease_owner = NULL, lease_until = NULL,
         updated_at = now()
   WHERE w.id IN (SELECT id FROM workflow_runs WHERE status = 'running' AND lease_until < now()
                   ORDER BY updated_at LIMIT p_limit FOR UPDATE SKIP LOCKED);
  RETURN QUERY
    SELECT w.id, w.run_as FROM workflow_runs w
     WHERE w.status = 'queued' AND (w.next_retry_at IS NULL OR w.next_retry_at <= now())
     ORDER BY w.updated_at LIMIT p_limit;
END $$;
GRANT EXECUTE ON FUNCTION private.reclaim_runs(int, int) TO kritvia_app;

-- A manual retry or an automatic one starts the count again.
CREATE OR REPLACE FUNCTION private.retry_later(p_run uuid, p_error text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  UPDATE workflow_runs SET status = 'queued', retries = retries + 1, error = p_error, finished_at = NULL,
         lease_owner = NULL, lease_until = NULL, updated_at = now(), reclaims = 0,
         next_retry_at = now() + CASE retries WHEN 0 THEN interval '2 minutes' WHEN 1 THEN interval '10 minutes'
                                              ELSE interval '60 minutes' END
   WHERE id = p_run AND status = 'failed' AND retries < 3
  RETURNING retries INTO n;
  RETURN coalesce(n, 0);
END $$;

-- ---------------------------------------------------------------------------------------------- P4 --
-- At most once still holds for anything that may have gone out: only a send recorded as failed (ok:false)
-- of a run that is running (the step itself), and at most 3 attempts in all. The attempt number is kept and
-- `ok` cleared, so a worker stopped during the new attempt can't lead to a third send.
CREATE FUNCTION private.retry_failed_execution(p_approval uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE approvals a SET executed_at = now(),
         execution_result = jsonb_build_object('attempt', coalesce((a.execution_result->>'attempt')::int, 1) + 1)
   WHERE a.id = p_approval AND a.executed_at IS NOT NULL
     AND a.execution_result->>'ok' = 'false'
     AND coalesce((a.execution_result->>'attempt')::int, 1) < 3
     AND a.venture_id = ANY ((SELECT private.readable_ventures())::uuid[])
     AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id = a.run_id AND r.status = 'running')
  RETURNING true
$$;
GRANT EXECUTE ON FUNCTION private.retry_failed_execution(uuid) TO kritvia_app;

-- ---------------------------------------------------------------------------------------------- P3 --
ALTER TABLE automations ADD COLUMN claimed_until timestamptz;
ALTER TABLE custom_workflows ADD COLUMN claimed_until timestamptz;
ALTER TABLE skills ADD COLUMN claimed_until timestamptz;
ALTER TABLE team_roles ADD COLUMN claimed_until timestamptz;

DROP FUNCTION private.claim_due_automations(timestamptz);
CREATE FUNCTION private.claim_due_automations(p_now timestamptz)
RETURNS TABLE (automation_id uuid, venture_id uuid, run_as uuid, due_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE automations a SET claimed_until = p_now + interval '15 minutes'
   WHERE a.id IN (SELECT id FROM automations WHERE enabled AND next_run_at <= p_now
                   AND (claimed_until IS NULL OR claimed_until < p_now)
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING a.id, a.venture_id, private.provision_service_account(a.org_id, a.venture_id), a.next_run_at
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_automations(timestamptz) TO kritvia_app;

CREATE OR REPLACE FUNCTION private.set_automation_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE automations SET next_run_at = p_next, claimed_until = NULL,
         last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END, last_error = p_error
   WHERE id = p_id
$$;

DROP FUNCTION private.claim_due_custom(timestamptz);
CREATE FUNCTION private.claim_due_custom(p_now timestamptz)
RETURNS TABLE (custom_id uuid, venture_id uuid, run_as uuid, due_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE custom_workflows c SET claimed_until = p_now + interval '15 minutes'
   WHERE c.id IN (SELECT id FROM custom_workflows WHERE enabled AND next_run_at <= p_now
                   AND (claimed_until IS NULL OR claimed_until < p_now)
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING c.id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id), c.next_run_at
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_custom(timestamptz) TO kritvia_app;

CREATE OR REPLACE FUNCTION private.set_custom_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE custom_workflows SET next_run_at = p_next, claimed_until = NULL,
         last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END, last_error = p_error
   WHERE id = p_id
$$;

DROP FUNCTION private.claim_due_skills(timestamptz);
CREATE FUNCTION private.claim_due_skills(p_now timestamptz)
RETURNS TABLE (skill_id uuid, venture_id uuid, run_as uuid, due_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE skills s SET claimed_until = p_now + interval '15 minutes'
   WHERE s.id IN (SELECT id FROM skills WHERE enabled AND trigger <> 'manual' AND next_run_at <= p_now
                   AND (claimed_until IS NULL OR claimed_until < p_now)
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING s.id, s.venture_id, private.provision_service_account(s.org_id, s.venture_id), s.next_run_at
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_skills(timestamptz) TO kritvia_app;

CREATE OR REPLACE FUNCTION private.set_skill_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE skills SET next_run_at = p_next, claimed_until = NULL, last_error = p_error,
                    last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END
   WHERE id = p_id
$$;

DROP FUNCTION private.claim_due_team(timestamptz);
CREATE FUNCTION private.claim_due_team(p_now timestamptz)
RETURNS TABLE (team_role_id uuid, venture_id uuid, run_as uuid, due_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE team_roles t SET claimed_until = p_now + interval '15 minutes'
   WHERE t.id IN (SELECT id FROM team_roles WHERE enabled AND next_run_at <= p_now
                   AND (claimed_until IS NULL OR claimed_until < p_now)
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING t.id, t.venture_id, private.provision_service_account(t.org_id, t.venture_id), t.next_run_at
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_team(timestamptz) TO kritvia_app;

CREATE OR REPLACE FUNCTION private.set_team_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE team_roles SET next_run_at = p_next, claimed_until = NULL, last_error = p_error,
                        last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END
   WHERE id = p_id
$$;

-- Business events: a claim is a 10-minute lease; dispatched_at is set only when acted on.
ALTER TABLE business_events ADD COLUMN claimed_at timestamptz,
                            ADD COLUMN dispatch_attempts int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION private.claim_events(p_limit int)
RETURNS TABLE (id bigint, org_id uuid, venture_id uuid, kind text, subject_table text, subject_id uuid,
               summary text, amount_paise bigint, occurred_at timestamptz, run_as uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH todo AS (
    SELECT e.id FROM business_events e
     WHERE e.dispatched_at IS NULL AND (e.claimed_at IS NULL OR e.claimed_at < now() - interval '10 minutes')
     ORDER BY e.id LIMIT greatest(1, least(p_limit, 2000)) FOR UPDATE SKIP LOCKED
  )
  UPDATE business_events e SET claimed_at = now(), dispatch_attempts = e.dispatch_attempts + 1
    FROM todo WHERE e.id = todo.id
  RETURNING e.id, e.org_id, e.venture_id, e.kind, e.subject_table, e.subject_id, e.summary, e.amount_paise,
            e.occurred_at, private.provision_service_account(e.org_id, e.venture_id)
$$;

-- Done: dispatched. Failed: free again for the next pass, unless this was its fifth try (then given up).
CREATE FUNCTION private.events_done(p_ids bigint[], p_ok boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE business_events SET
    dispatched_at = CASE WHEN p_ok OR dispatch_attempts >= 5 THEN now() END,
    claimed_at = CASE WHEN p_ok OR dispatch_attempts >= 5 THEN claimed_at END
   WHERE id = ANY (p_ids)
$$;
GRANT EXECUTE ON FUNCTION private.events_done(bigint[], boolean) TO kritvia_app;

-- ---------------------------------------------------------------------------------------------- P1 --
CREATE TABLE scheduled_job_runs (
  name     text PRIMARY KEY CHECK (name ~ '^[a-z0-9_]{2,40}$'),
  ran_on   date NOT NULL,
  ran_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE scheduled_job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_job_runs FORCE ROW LEVEL SECURITY;

-- True for exactly one caller per job and day.
CREATE FUNCTION private.claim_daily_job(p_name text, p_day date) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO scheduled_job_runs (name, ran_on) VALUES (p_name, p_day)
  ON CONFLICT (name) DO UPDATE SET ran_on = EXCLUDED.ran_on, ran_at = now()
   WHERE scheduled_job_runs.ran_on < EXCLUDED.ran_on
  RETURNING true
$$;
GRANT EXECUTE ON FUNCTION private.claim_daily_job(text, date) TO kritvia_app;

-- --------------------------------------------------------------------------------------------- P13 --
CREATE INDEX workflow_runs_finished_idx ON workflow_runs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX approvals_pending_expiry_idx ON approvals (expires_at) WHERE status = 'pending';
CREATE INDEX trigger_events_created_idx ON trigger_events (created_at);

-- The every-minute counts use the finished-runs index instead of scanning every failed run ever.
CREATE OR REPLACE FUNCTION public.watchdog_stats()
RETURNS TABLE (queued int, oldest_queued_s int, stuck int, retrying int, failed_15m int, ai_calls_15m int,
               ai_failed_15m int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    (SELECT count(*)::int FROM workflow_runs WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now())),
    coalesce((SELECT extract(epoch FROM now() - min(updated_at))::int FROM workflow_runs
               WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= now())), 0),
    (SELECT count(*)::int FROM workflow_runs WHERE status = 'running' AND lease_until < now() - interval '5 minutes'),
    (SELECT count(*)::int FROM workflow_runs WHERE status = 'queued' AND next_retry_at > now()),
    (SELECT count(*)::int FROM workflow_runs WHERE finished_at > now() - interval '15 minutes' AND status = 'failed'),
    (SELECT count(*)::int FROM model_calls WHERE created_at > now() - interval '15 minutes'),
    (SELECT count(*)::int FROM model_calls WHERE created_at > now() - interval '15 minutes' AND status <> 'ok')
$$;

-- Finished runs older than p_days: deleted with their steps, cards and tickets, unless they sent
-- something (outbox_messages is the record of what went out, and points at the card): those keep the run,
-- card and message, and lose only their step log.
CREATE FUNCTION private.purge_run_history(p_days int, p_limit int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cutoff timestamptz := now() - make_interval(days => greatest(p_days, 30)); n int; m int;
BEGIN
  WITH old AS (
    SELECT r.id FROM workflow_runs r
     WHERE r.finished_at < cutoff AND r.status IN ('completed', 'failed', 'cancelled')
       AND NOT EXISTS (SELECT 1 FROM approvals a JOIN outbox_messages o ON o.approval_id = a.id WHERE a.run_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending')
     ORDER BY r.finished_at LIMIT p_limit)
  DELETE FROM workflow_runs w USING old WHERE w.id = old.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  WITH kept AS (SELECT r.id FROM workflow_runs r WHERE r.finished_at < cutoff ORDER BY r.finished_at LIMIT p_limit)
  DELETE FROM workflow_steps s USING kept WHERE s.run_id = kept.id;
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END $$;
GRANT EXECUTE ON FUNCTION private.purge_run_history(int, int) TO kritvia_app;

CREATE FUNCTION private.purge_model_calls(p_days int, p_limit int) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH old AS (SELECT id FROM model_calls WHERE created_at < now() - make_interval(days => greatest(p_days, 400))
                ORDER BY created_at LIMIT p_limit),
       d AS (DELETE FROM model_calls m USING old WHERE m.id = old.id RETURNING 1)
  SELECT count(*)::int FROM d
$$;
GRANT EXECUTE ON FUNCTION private.purge_model_calls(int, int) TO kritvia_app;

-- Pollers only look a few days back, so a start record older than 180 days can never be needed again.
CREATE FUNCTION private.purge_trigger_events(p_days int, p_limit int) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH old AS (SELECT id FROM trigger_events WHERE created_at < now() - make_interval(days => greatest(p_days, 30))
                ORDER BY created_at LIMIT p_limit),
       d AS (DELETE FROM trigger_events t USING old WHERE t.id = old.id RETURNING 1)
  SELECT count(*)::int FROM d
$$;
GRANT EXECUTE ON FUNCTION private.purge_trigger_events(int, int) TO kritvia_app;

-- --------------------------------------------------------------------------------------------- P16 --
-- API-key requests that carry an Idempotency-Key: the first response is kept for 24 hours and replayed
-- for a retry with the same key (and refused if the same key comes with a different request).
CREATE TABLE idempotency_keys (
  scope         text NOT NULL CHECK (char_length(scope) = 64),        -- sha256 of the API key
  key           text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
  method        text NOT NULL,
  path          text NOT NULL CHECK (char_length(path) <= 500),
  request_hash  text NOT NULL,
  status        int,                                                   -- NULL while the first request runs
  body          bytea CHECK (octet_length(body) <= 262144),
  content_type  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- 'new' (go ahead), 'replay' (with the stored response), 'busy' (the first request is still running) or
-- 'mismatch' (the key was used for a different request).
CREATE FUNCTION private.idem_begin(p_scope text, p_key text, p_method text, p_path text, p_hash text)
RETURNS TABLE (state text, status int, body bytea, content_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k idempotency_keys;
BEGIN
  DELETE FROM idempotency_keys i WHERE i.scope = p_scope AND i.key = p_key
     AND (i.created_at < now() - interval '24 hours' OR (i.status IS NULL AND i.created_at < now() - interval '5 minutes'));
  INSERT INTO idempotency_keys (scope, key, method, path, request_hash) VALUES (p_scope, p_key, p_method, p_path, p_hash)
  ON CONFLICT ON CONSTRAINT idempotency_keys_pkey DO NOTHING;
  IF FOUND THEN
    RETURN QUERY SELECT 'new'::text, NULL::int, NULL::bytea, NULL::text; RETURN;
  END IF;
  SELECT * INTO k FROM idempotency_keys i WHERE i.scope = p_scope AND i.key = p_key;
  IF k.request_hash <> p_hash OR k.method <> p_method OR k.path <> p_path THEN
    RETURN QUERY SELECT 'mismatch'::text, NULL::int, NULL::bytea, NULL::text; RETURN;
  END IF;
  IF k.status IS NULL THEN
    RETURN QUERY SELECT 'busy'::text, NULL::int, NULL::bytea, NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'replay'::text, k.status, k.body, k.content_type;
END $$;

CREATE FUNCTION private.idem_finish(p_scope text, p_key text, p_status int, p_body bytea, p_type text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE idempotency_keys SET status = p_status, body = p_body, content_type = left(p_type, 100)
   WHERE scope = p_scope AND key = p_key
$$;

CREATE FUNCTION private.idem_abort(p_scope text, p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM idempotency_keys WHERE scope = p_scope AND key = p_key AND status IS NULL
$$;

CREATE FUNCTION private.purge_idempotency_keys() RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours' RETURNING 1)
  SELECT count(*)::int FROM d
$$;
GRANT EXECUTE ON FUNCTION private.idem_begin(text, text, text, text, text), private.idem_finish(text, text, int, bytea, text),
  private.idem_abort(text, text), private.purge_idempotency_keys() TO kritvia_app;

-- --------------------------------------------------------------------------------------------- P15 --
-- Addresses Amazon SES reported as a permanent bounce or a complaint: Kritvia's own system email stops
-- going to them (SES suspends sending for everyone above 5% bounces or 0.1% complaints).
CREATE TABLE email_suppressions (
  address     text PRIMARY KEY CHECK (address = lower(address) AND char_length(address) <= 254),
  reason      text NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  detail      text CHECK (char_length(detail) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppressions FORCE ROW LEVEL SECURITY;

CREATE FUNCTION private.email_suppressed(p_address text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM email_suppressions WHERE address = lower(btrim(p_address)))
$$;

CREATE FUNCTION private.suppress_email(p_address text, p_reason text, p_detail text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO email_suppressions (address, reason, detail) VALUES (lower(btrim(p_address)), p_reason, left(p_detail, 300))
  ON CONFLICT (address) DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail, created_at = now()
$$;
GRANT EXECUTE ON FUNCTION private.email_suppressed(text), private.suppress_email(text, text, text) TO kritvia_app;

-- --------------------------------------------------------------------------------------------- P14 --
-- The security record about the person asking (their export): kinds, times and IPs, never other people's.
CREATE FUNCTION public.my_security_events() RETURNS TABLE (at timestamptz, kind text, severity text, ip text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT at, kind, severity, ip FROM security_events
   WHERE user_id = private.current_user_id() AND private.current_user_id() IS NOT NULL
   ORDER BY at DESC LIMIT 5000
$$;
GRANT EXECUTE ON FUNCTION public.my_security_events() TO kritvia_app;
