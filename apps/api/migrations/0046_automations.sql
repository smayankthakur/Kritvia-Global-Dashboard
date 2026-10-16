-- =============================================================================
-- 0046 Automations from plain words ("every Monday send me last week's sales").
--
--   automations         a standing request: what to do (in the person's words, tidied), when (daily,
--                       weekly on some days, or monthly on a date, at a time), which period it covers,
--                       and where the result goes. Results for the person who made it go straight to
--                       them (email, their linked Telegram chat, the business's Slack, or the app);
--                       an email to anyone else waits for a yes like every other draft.
--   automation_results  each result, encrypted, to read in the app.
-- =============================================================================
CREATE TABLE automations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  venture_id      uuid NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  said            text NOT NULL CHECK (char_length(said) BETWEEN 3 AND 500),       -- the person's own words
  task            text NOT NULL CHECK (char_length(task) BETWEEN 3 AND 500),       -- what to produce
  period          text NOT NULL CHECK (period IN ('today', 'yesterday', 'last_7_days', 'last_week', 'this_month',
                                                  'last_month', 'last_30_days')),
  freq            text NOT NULL CHECK (freq IN ('daily', 'weekly', 'monthly')),
  weekdays        int[] NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]),   -- 0 = Monday
  day_of_month    int CHECK (day_of_month BETWEEN 1 AND 28),
  at_time         text NOT NULL CHECK (at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  channel         text NOT NULL CHECK (channel IN ('email', 'telegram', 'slack', 'app')),
  recipients      text[] NOT NULL DEFAULT '{}',          -- other people's emails (each send needs a yes)
  enabled         boolean NOT NULL DEFAULT true,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  last_error      text CHECK (char_length(last_error) <= 300),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (freq <> 'weekly' OR cardinality(weekdays) > 0),
  CHECK (freq <> 'monthly' OR day_of_month IS NOT NULL),
  CHECK (cardinality(recipients) <= 10),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX automations_due_idx ON automations (next_run_at) WHERE enabled;
SELECT private.protect_tenant_table('automations');
GRANT SELECT, INSERT, UPDATE, DELETE ON automations TO kritvia_app;

CREATE TABLE automation_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  automation_id  uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  run_id         uuid,
  body_enc       bytea NOT NULL,
  delivered      text CHECK (char_length(delivered) <= 200),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX automation_results_idx ON automation_results (automation_id, created_at DESC);
SELECT private.protect_tenant_table('automation_results');
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_results TO kritvia_app;

-- The worker, every minute: automations whose time has come. Each is claimed (next_run_at cleared) so a
-- second worker can't start it twice; the worker sets the next time after starting the run.
CREATE FUNCTION private.claim_due_automations(p_now timestamptz)
RETURNS TABLE (automation_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE automations a SET next_run_at = NULL
   WHERE a.id IN (SELECT id FROM automations WHERE enabled AND next_run_at <= p_now
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING a.id, a.venture_id, private.provision_service_account(a.org_id, a.venture_id)
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_automations(timestamptz) TO kritvia_app;

CREATE FUNCTION private.set_automation_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE automations SET next_run_at = p_next, last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END,
                         last_error = p_error WHERE id = p_id
$$;
GRANT EXECUTE ON FUNCTION private.set_automation_next(uuid, timestamptz, text) TO kritvia_app;

-- The automation's maker, so the business's runtime can deliver to them (users aren't visible to it).
CREATE FUNCTION private.automation_owner(p_automation uuid)
RETURNS TABLE (email text, full_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.email, u.full_name FROM automations a JOIN users u ON u.id = a.created_by
   WHERE a.id = p_automation AND a.venture_id = ANY ((SELECT private.readable_ventures())::uuid[])
$$;
GRANT EXECUTE ON FUNCTION private.automation_owner(uuid) TO kritvia_app;
