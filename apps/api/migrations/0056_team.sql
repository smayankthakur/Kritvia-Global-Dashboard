-- =============================================================================
-- 0056 The agent team: leads with goals, check-ins, budgets and hand-offs; business templates.
--
-- The board already puts every agent in a role (Front desk, Sales, Accounts, Operations) with its own
-- budget. Now each role can have a LEAD:
--
--   team_roles     the lead's goal (encrypted), when it checks in (weekdays at HH:MM, business time
--                  zone), and a monthly token budget for the whole role (its agents and the lead).
--                  At check-in the lead looks over its area with the assistant's tools, does up to a few
--                  useful things (drafts wait for a yes as always), hands work to another lead when it
--                  belongs there, and reports to the owner in a few lines.
--   team_reports   those reports (encrypted), kept for the Team page and sent to the person who set the
--                  team up (their linked Telegram/WhatsApp chat) and as a push.
--   team_handoffs_today(v)   hand-offs started today, for the daily cap.
--   role_usage(v, role)      hosted tokens a role's work (its agents' runs and its lead's) used this IST month.
--
-- Templates (services/templates.py) need no table: applying one switches on agents and adds
-- automations, skills and leads' goals through the same rows as doing it by hand.
-- =============================================================================
CREATE TABLE team_roles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  role           text NOT NULL CHECK (role IN ('front_desk', 'sales', 'accounts', 'ops')),
  goal_enc       bytea NOT NULL,
  enabled        boolean NOT NULL DEFAULT false,
  weekdays       int[] NOT NULL DEFAULT '{0,1,2,3,4,5}' CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6] AND cardinality(weekdays) > 0),
  at_time        text NOT NULL DEFAULT '09:30' CHECK (at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  monthly_tokens bigint CHECK (monthly_tokens IS NULL OR monthly_tokens >= 0),
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  last_error     text CHECK (char_length(last_error) <= 300),
  created_by     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, role),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX team_roles_due_idx ON team_roles (next_run_at) WHERE enabled;
SELECT private.protect_tenant_table('team_roles');
GRANT SELECT, INSERT, UPDATE, DELETE ON team_roles TO kritvia_app;

CREATE TABLE team_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('front_desk', 'sales', 'accounts', 'ops')),
  run_id      uuid,
  body_enc    bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX team_reports_idx ON team_reports (venture_id, created_at DESC);
SELECT private.protect_tenant_table('team_reports');
GRANT SELECT, INSERT, DELETE ON team_reports TO kritvia_app;

CREATE FUNCTION private.claim_due_team(p_now timestamptz)
RETURNS TABLE (team_role_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE team_roles t SET next_run_at = NULL
   WHERE t.id IN (SELECT id FROM team_roles WHERE enabled AND next_run_at <= p_now
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING t.id, t.venture_id, private.provision_service_account(t.org_id, t.venture_id)
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_team(timestamptz) TO kritvia_app;

CREATE FUNCTION private.set_team_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE team_roles SET next_run_at = p_next, last_error = p_error,
                        last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END
   WHERE id = p_id
$$;
GRANT EXECUTE ON FUNCTION private.set_team_next(uuid, timestamptz, text) TO kritvia_app;

CREATE FUNCTION public.role_usage(p_venture uuid, p_role text, p_local text[]) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(coalesce(m.prompt_tokens, 0) + coalesce(m.completion_tokens, 0)), 0)::bigint
    FROM model_calls m JOIN tickets t ON t.id = m.ticket_id
   WHERE m.venture_id = p_venture AND t.role = p_role AND m.status = 'ok'
     AND NOT (coalesce(m.provider_model, '') = ANY (p_local))
     AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
     AND p_venture = ANY (private.readable_ventures())
$$;
GRANT EXECUTE ON FUNCTION public.role_usage(uuid, text, text[]) TO kritvia_app;

CREATE FUNCTION public.team_handoffs_today(p_venture uuid) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int FROM workflow_runs r
   WHERE r.venture_id = p_venture AND r.trigger_ref LIKE 'team:%:handoff:%'
     AND r.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
     AND p_venture = ANY (private.readable_ventures())
$$;
GRANT EXECUTE ON FUNCTION public.team_handoffs_today(uuid) TO kritvia_app;
