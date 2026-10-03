-- =============================================================================
-- Kritvia 0015 — The board: roles, per-agent budgets, tickets; push notifications.
--
-- An "agent" the owner sees is a workflow, so its role on the org chart and its
-- monthly token budget live on workflow_configs. A ticket is the board card for a
-- run: created with the run, moved by the runner, costed from model_calls. A
-- mission is a ticket without a run that the owner writes at the top of the board.
-- Budgets are enforced in the model router (services/quota.py), not here.
-- =============================================================================

-- Roles and budgets per agent (workflow) per venture. NULL budget = no cap beyond the plan.
ALTER TABLE workflow_configs
  ADD COLUMN role text NOT NULL DEFAULT 'ops'
    CHECK (role IN ('front_desk', 'sales', 'accounts', 'ops')),
  ADD COLUMN monthly_tokens bigint CHECK (monthly_tokens IS NULL OR monthly_tokens >= 0);

-- Where each agent sits on the org chart unless the owner moves it.
CREATE FUNCTION private.default_role(p_workflow text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_workflow
    WHEN 'inbox_assistant' THEN 'front_desk'
    WHEN 'lead_triage' THEN 'sales'
    WHEN 'loan_verification' THEN 'accounts'
    ELSE 'ops' END
$$;
CREATE FUNCTION private.workflow_config_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.role = 'ops' THEN NEW.role := private.default_role(NEW.workflow); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_configs_role BEFORE INSERT ON workflow_configs
  FOR EACH ROW EXECUTE FUNCTION private.workflow_config_role();
UPDATE workflow_configs SET role = private.default_role(workflow);
GRANT EXECUTE ON FUNCTION private.default_role(text), private.workflow_config_role() TO kritvia_app;

-- Attribution: which step agent and which ticket a model call belongs to.
ALTER TABLE model_calls ADD COLUMN agent_id text, ADD COLUMN ticket_id uuid;
CREATE INDEX model_calls_workflow_month_idx ON model_calls (venture_id, workflow, created_at DESC);
CREATE INDEX model_calls_ticket_idx ON model_calls (ticket_id) WHERE ticket_id IS NOT NULL;

-- Hosted tokens one agent (workflow) used this IST month, for the per-agent cap.
CREATE FUNCTION public.agent_usage(p_venture uuid, p_workflow text, p_local text[]) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(coalesce(m.prompt_tokens, 0) + coalesce(m.completion_tokens, 0)), 0)::bigint
    FROM model_calls m
   WHERE m.venture_id = p_venture AND m.workflow = p_workflow AND m.status = 'ok'
     AND NOT (coalesce(m.provider_model, '') = ANY (p_local))
     AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
     AND p_venture = ANY (private.readable_ventures())
$$;
GRANT EXECUTE ON FUNCTION public.agent_usage(uuid, text, text[]) TO kritvia_app;

-- Tickets: one per run (run_id set) or a mission the owner wrote (run_id NULL).
CREATE TABLE tickets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  mission_id     uuid REFERENCES tickets(id) ON DELETE SET NULL,
  run_id         uuid UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow       text,
  role           text NOT NULL DEFAULT 'ops' CHECK (role IN ('front_desk', 'sales', 'accounts', 'ops', 'owner')),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'waiting_approval', 'blocked', 'done', 'cancelled')),
  note           text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  delegated_from text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX tickets_venture_status_idx ON tickets (venture_id, status, updated_at DESC);
SELECT private.protect_tenant_table('tickets');
GRANT SELECT, INSERT, UPDATE, DELETE ON tickets TO kritvia_app;

-- The runner moves a run's ticket as the run moves. Called as the run principal.
CREATE FUNCTION public.ticket_for_run(p_run uuid, p_status text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE tickets SET status = p_status, note = coalesce(left(p_note, 500), note), updated_at = now(),
         finished_at = CASE WHEN p_status IN ('done', 'cancelled') THEN now() ELSE finished_at END
   WHERE run_id = p_run AND venture_id = ANY (private.readable_ventures())
$$;
GRANT EXECUTE ON FUNCTION public.ticket_for_run(uuid, text, text) TO kritvia_app;

-- Board summary: roles with spend against budget, counts per status, this month's cost.
CREATE FUNCTION public.board_roles(p_venture uuid, p_local text[])
RETURNS TABLE (workflow text, role text, enabled boolean, monthly_tokens bigint, used_tokens bigint,
               cost_usd numeric, open_tickets bigint, waiting bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.workflow, c.role, c.enabled, c.monthly_tokens,
         public.agent_usage(p_venture, c.workflow, p_local),
         coalesce((SELECT sum(m.cost_usd) FROM model_calls m
                    WHERE m.venture_id = p_venture AND m.workflow = c.workflow AND m.status = 'ok'
                      AND m.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'), 0),
         (SELECT count(*) FROM tickets t WHERE t.venture_id = p_venture AND t.workflow = c.workflow AND t.status = 'open'),
         (SELECT count(*) FROM tickets t WHERE t.venture_id = p_venture AND t.workflow = c.workflow AND t.status = 'waiting_approval')
    FROM workflow_configs c
   WHERE c.venture_id = p_venture AND p_venture = ANY (private.readable_ventures())
   ORDER BY c.role, c.workflow
$$;
GRANT EXECUTE ON FUNCTION public.board_roles(uuid, text[]) TO kritvia_app;

-- Web push: one row per browser the member subscribed from.
CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  keys        jsonb NOT NULL,             -- {p256dh, auth} from PushSubscription.toJSON()
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  failures    int NOT NULL DEFAULT 0
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY push_own ON push_subscriptions FOR ALL
  USING (user_id = private.current_user_id()) WITH CHECK (user_id = private.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO kritvia_app;

-- Who should be told about a new pending approval: members who can decide it, with their subscriptions.
CREATE FUNCTION private.approval_push_targets(p_approval uuid)
RETURNS TABLE (user_id uuid, subscription_id uuid, endpoint text, keys jsonb, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT m.user_id, s.id, s.endpoint, s.keys, a.org_id
    FROM approvals a
    JOIN memberships m ON m.org_id = a.org_id
         AND (m.venture_id IS NULL OR m.venture_id = a.venture_id)
         AND (m.role = ANY (a.required_roles) OR m.role = 'org_owner')
    JOIN push_subscriptions s ON s.user_id = m.user_id AND s.failures < 5
   WHERE a.id = p_approval
$$;
GRANT EXECUTE ON FUNCTION private.approval_push_targets(uuid) TO kritvia_app;
-- Delivery bookkeeping, written by the system after a push attempt.
CREATE FUNCTION private.push_result(p_id uuid, p_ok boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE push_subscriptions SET last_ok_at = CASE WHEN p_ok THEN now() ELSE last_ok_at END,
         failures = CASE WHEN p_ok THEN 0 ELSE failures + 1 END WHERE id = p_id
$$;
GRANT EXECUTE ON FUNCTION private.push_result(uuid, boolean) TO kritvia_app;
