-- =============================================================================
-- Kritvia 0002 — Orchestration: service accounts, workflow runs, approvals,
-- earned autonomy, connectors, outbox.
--
-- Agents never act as a human. Each venture gets a service account (role
-- agent_runtime: may write venture data, may NOT approve). The worker executes
-- a run as that account with actor_type = 'agent', so RLS bounds every agent to
-- one venture and the audit log attributes every action to the agent by name.
-- =============================================================================

ALTER TABLE users ADD COLUMN is_service boolean NOT NULL DEFAULT false;

INSERT INTO roles (name, scope, can_write, can_approve, description) VALUES
  ('agent_runtime', 'venture', true, false, 'Service account the agent runtime executes as; can never approve');

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION private.has_venture_role(p_venture uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = private.current_user_id()
       AND m.venture_id = p_venture
       AND m.role = ANY (p_roles))
$$;

CREATE FUNCTION private.is_service_user() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT is_service FROM users WHERE id = private.current_user_id()), false)
$$;

-- Administers a venture: venture_admin on it, or org_owner of its org.
CREATE FUNCTION private.can_admin_venture(p_venture uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT private.has_venture_role(p_venture, '{venture_admin}')
      OR EXISTS (SELECT 1 FROM ventures v
                  WHERE v.id = p_venture AND v.org_id = ANY (private.owned_orgs()))
$$;

-- ---------------------------------------------------------------------------
-- Service accounts: one per venture, provisioned automatically
-- ---------------------------------------------------------------------------
CREATE FUNCTION private.provision_service_account(p_org uuid, p_venture uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT m.user_id INTO v_user FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE m.venture_id = p_venture AND m.role = 'agent_runtime' AND u.is_service LIMIT 1;
  IF v_user IS NOT NULL THEN RETURN v_user; END IF;
  INSERT INTO users (email, full_name, password_hash, is_service)
    VALUES ('svc+' || p_venture::text || '@agents.kritvia.local', 'Kritvia agent runtime', NULL, true)
    RETURNING id INTO v_user;
  INSERT INTO memberships (org_id, venture_id, user_id, role)
    VALUES (p_org, p_venture, v_user, 'agent_runtime');
  RETURN v_user;
END $$;

CREATE FUNCTION private.on_venture_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM private.provision_service_account(NEW.org_id, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER ventures_service_account AFTER INSERT ON ventures
  FOR EACH ROW EXECUTE FUNCTION private.on_venture_created();

SELECT private.provision_service_account(org_id, id) FROM ventures;

CREATE FUNCTION public.venture_service_account(p_venture uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE m.venture_id = p_venture AND m.role = 'agent_runtime' AND u.is_service
     AND p_venture = ANY (private.readable_ventures())
   LIMIT 1
$$;

-- Login must never succeed for a service account (belt and braces: no hash).
CREATE OR REPLACE FUNCTION public.auth_lookup(p_email text)
RETURNS TABLE (id uuid, password_hash text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.password_hash, u.is_active AND NOT u.is_service
    FROM users u WHERE lower(u.email) = lower(p_email)
$$;

-- ---------------------------------------------------------------------------
-- Venture settings
-- ---------------------------------------------------------------------------
CREATE TABLE venture_settings (
  org_id           uuid NOT NULL,
  venture_id       uuid PRIMARY KEY,
  kind             text NOT NULL DEFAULT 'general'
                   CHECK (kind IN ('general', 'software', 'finance', 'kitchen')),
  trust_threshold  int  NOT NULL DEFAULT 30 CHECK (trust_threshold BETWEEN 5 AND 1000),
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

-- Which workflows a venture runs, on what schedule, with what (non-secret) settings.
CREATE TABLE workflow_configs (
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  workflow    text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  schedule    text CHECK (schedule IS NULL OR schedule ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  settings    jsonb NOT NULL DEFAULT '{}',
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, workflow),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Runs, step history, approvals, trust
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  workflow       text NOT NULL,
  version        int  NOT NULL DEFAULT 1,
  title          text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_step   text NOT NULL,
  state_enc      bytea,                    -- encrypted with the venture DEK
  summary        jsonb NOT NULL DEFAULT '{}', -- non-sensitive, shown in the UI
  outcome        text,
  trigger_kind   text NOT NULL DEFAULT 'manual'
                 CHECK (trigger_kind IN ('manual', 'email', 'webhook', 'schedule', 'upload', 'api')),
  trigger_ref    text,
  run_as         uuid NOT NULL REFERENCES users(id),
  started_by     uuid REFERENCES users(id),
  lease_owner    text,
  lease_until    timestamptz,
  step_count     int  NOT NULL DEFAULT 0,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (venture_id, id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_runs_venture_idx ON workflow_runs (venture_id, created_at DESC);
CREATE INDEX workflow_runs_status_idx ON workflow_runs (status, lease_until);

CREATE TABLE workflow_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  run_id       uuid NOT NULL,
  step         text NOT NULL,
  agent        text,
  status       text NOT NULL CHECK (status IN ('ok', 'interrupted', 'failed', 'skipped')),
  note         text,                      -- non-sensitive one-liner for the timeline
  error        text,
  duration_ms  int,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, run_id) REFERENCES workflow_runs(venture_id, id) ON DELETE CASCADE
);
CREATE INDEX workflow_steps_run_idx ON workflow_steps (run_id, created_at);

-- De-duplicates external triggers (same email / webhook delivered twice).
CREATE TABLE trigger_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  source       text NOT NULL,
  external_id  text NOT NULL,
  run_id       uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, source, external_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE approvals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  venture_id          uuid NOT NULL,
  run_id              uuid NOT NULL,
  step                text NOT NULL,
  agent               text NOT NULL,
  action              text NOT NULL,       -- tool name, e.g. gmail.send
  capability          text NOT NULL CHECK (capability IN ('write', 'send')),
  title               text NOT NULL,
  summary             text NOT NULL DEFAULT '',
  payload_enc         bytea NOT NULL,      -- the agent's draft
  final_payload_enc   bytea,               -- what was actually approved (after edits)
  required_roles      text[] NOT NULL DEFAULT '{approver,venture_admin}',
  sensitive           boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'edited', 'rejected',
                                        'auto_approved', 'expired', 'cancelled')),
  decided_by          uuid REFERENCES users(id),
  decided_at          timestamptz,
  comment             text,
  executed_at         timestamptz,
  execution_result    jsonb,
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, run_id) REFERENCES workflow_runs(venture_id, id) ON DELETE CASCADE
);
CREATE INDEX approvals_inbox_idx ON approvals (venture_id, status, created_at DESC);

CREATE TABLE agent_trust (
  org_id             uuid NOT NULL,
  venture_id         uuid NOT NULL,
  agent              text NOT NULL,
  action             text NOT NULL,
  approved_clean     int  NOT NULL DEFAULT 0,
  edited             int  NOT NULL DEFAULT 0,
  rejected           int  NOT NULL DEFAULT 0,
  auto_executed      int  NOT NULL DEFAULT 0,
  consecutive_clean  int  NOT NULL DEFAULT 0,
  auto_run           boolean NOT NULL DEFAULT false,
  promoted_by        uuid REFERENCES users(id),
  promoted_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, agent, action),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Connectors (per-venture OAuth / API credentials, tokens encrypted)
-- ---------------------------------------------------------------------------
CREATE TABLE connectors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  provider       text NOT NULL CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally')),
  account_email  text,
  scopes         text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  cursor         text,                     -- e.g. Gmail history id / last poll time
  last_error     text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, provider),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE connector_tokens (
  connector_id   uuid PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  secret_enc     bytea NOT NULL,           -- refresh token / webhook secret, venture DEK
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

-- Every message an agent sends, whatever the transport. Body encrypted.
CREATE TABLE outbox_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  venture_id           uuid NOT NULL,
  approval_id          uuid NOT NULL REFERENCES approvals(id),
  channel              text NOT NULL CHECK (channel IN ('email', 'calendar', 'whatsapp')),
  recipient            text NOT NULL,
  subject              text,
  body_enc             bytea,
  transport            text NOT NULL,
  status               text NOT NULL CHECK (status IN ('sent', 'failed', 'logged')),
  provider_message_id  text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (approval_id),                    -- an approval can send at most once
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

SELECT private.protect_tenant_table(t) FROM unnest(ARRAY[
  'venture_settings', 'workflow_configs', 'workflow_runs', 'workflow_steps', 'trigger_events',
  'approvals', 'agent_trust', 'connectors', 'connector_tokens', 'outbox_messages']) t;

-- Sensitive drafts (e.g. loan follow-ups) are visible only to the roles that
-- may decide them, and to the venture's agent runtime. RESTRICTIVE: this is
-- AND-ed with the venture-level policy, never a way around it.
CREATE POLICY approvals_sensitive ON approvals AS RESTRICTIVE FOR SELECT
  USING (NOT sensitive
         OR private.has_venture_role(venture_id, required_roles || '{agent_runtime}'::text[])
         OR private.can_admin_venture(venture_id) AND 'venture_admin' = ANY (required_roles));

-- Connector secrets are readable only by the agent runtime and venture admins.
CREATE POLICY connector_tokens_restricted ON connector_tokens AS RESTRICTIVE FOR SELECT
  USING (private.is_service_user() OR private.can_admin_venture(venture_id));

-- ---------------------------------------------------------------------------
-- Approval decisions. Only through this function: it checks the decider's
-- role, refuses service accounts (an agent can never approve its own draft),
-- updates earned-autonomy counters and wakes the run, atomically.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.decide_approval(p_id uuid, p_decision text, p_final bytea, p_comment text)
RETURNS TABLE (decided_run_id uuid, decided_venture_id uuid, decided_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a approvals; v_user uuid := private.current_user_id();
BEGIN
  IF p_decision NOT IN ('approved', 'edited', 'rejected') THEN
    RAISE EXCEPTION 'invalid decision %', p_decision;
  END IF;
  SELECT * INTO a FROM approvals ap WHERE ap.id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT (a.venture_id = ANY (private.readable_ventures())) THEN
    RAISE EXCEPTION 'approval not found' USING ERRCODE = '42501';
  END IF;
  IF private.is_service_user() THEN
    RAISE EXCEPTION 'agents cannot decide approvals' USING ERRCODE = '42501';
  END IF;
  IF NOT (private.has_venture_role(a.venture_id, a.required_roles)
          OR (NOT a.sensitive AND a.org_id = ANY (private.owned_orgs()))
          OR (NOT a.sensitive AND 'venture_admin' = ANY (a.required_roles)
              AND private.can_admin_venture(a.venture_id))) THEN
    RAISE EXCEPTION 'not permitted to decide this approval' USING ERRCODE = '42501';
  END IF;
  IF a.status <> 'pending' THEN
    RAISE EXCEPTION 'approval already %', a.status USING ERRCODE = 'KV409';
  END IF;
  IF a.expires_at IS NOT NULL AND a.expires_at < now() THEN
    UPDATE approvals SET status = 'expired' WHERE id = a.id;
    RAISE EXCEPTION 'approval expired' USING ERRCODE = 'KV409';
  END IF;

  UPDATE approvals ap SET
    status = p_decision,
    final_payload_enc = CASE WHEN p_decision = 'rejected' THEN NULL
                             ELSE coalesce(p_final, a.payload_enc) END,
    decided_by = v_user, decided_at = now(), comment = p_comment
   WHERE ap.id = a.id;

  INSERT INTO agent_trust AS t (org_id, venture_id, agent, action,
                                approved_clean, edited, rejected, consecutive_clean)
  VALUES (a.org_id, a.venture_id, a.agent, a.action,
          (p_decision = 'approved')::int, (p_decision = 'edited')::int,
          (p_decision = 'rejected')::int, (p_decision = 'approved')::int)
  ON CONFLICT (venture_id, agent, action) DO UPDATE SET
    approved_clean    = t.approved_clean + (p_decision = 'approved')::int,
    edited            = t.edited + (p_decision = 'edited')::int,
    rejected          = t.rejected + (p_decision = 'rejected')::int,
    consecutive_clean = CASE WHEN p_decision = 'approved' THEN t.consecutive_clean + 1 ELSE 0 END,
    updated_at        = now();

  UPDATE workflow_runs r SET status = 'queued', updated_at = now()
   WHERE r.id = a.run_id AND r.status = 'waiting';

  RETURN QUERY SELECT a.run_id, a.venture_id, p_decision;
END $$;

-- Promote an (agent, action) to auto-run once it has earned it, or demote it.
CREATE FUNCTION public.set_autonomy(p_venture uuid, p_agent text, p_action text,
                                    p_auto boolean, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t agent_trust; v_threshold int;
BEGIN
  IF NOT (p_venture = ANY (private.readable_ventures())) OR NOT private.can_admin_venture(p_venture)
     OR private.is_service_user() THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM agent_trust WHERE venture_id = p_venture AND agent = p_agent AND action = p_action
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no approval history for %/%', p_agent, p_action USING ERRCODE = 'KV409';
  END IF;
  IF p_auto THEN
    SELECT coalesce((SELECT trust_threshold FROM venture_settings WHERE venture_id = p_venture), 30)
      INTO v_threshold;
    IF t.consecutive_clean < v_threshold THEN
      RAISE EXCEPTION 'needs % consecutive unedited approvals, has %', v_threshold, t.consecutive_clean
        USING ERRCODE = 'KV409';
    END IF;
  END IF;
  UPDATE agent_trust SET auto_run = p_auto,
         promoted_by = CASE WHEN p_auto THEN private.current_user_id() ELSE promoted_by END,
         promoted_at = CASE WHEN p_auto THEN now() ELSE promoted_at END,
         updated_at = now()
   WHERE venture_id = p_venture AND agent = p_agent AND action = p_action;
  PERFORM public.audit_event(t.org_id, p_venture,
    CASE WHEN p_auto THEN 'autonomy.promoted' ELSE 'autonomy.demoted' END,
    'agent_trust', p_agent || '/' || p_action,
    jsonb_build_object('reason', p_reason, 'consecutive_clean', t.consecutive_clean));
END $$;

-- Records that an auto-run action executed without a human (keeps the metric honest).
CREATE FUNCTION public.record_auto_execution(p_venture uuid, p_agent text, p_action text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE agent_trust SET auto_executed = auto_executed + 1, updated_at = now()
   WHERE venture_id = p_venture AND agent = p_agent AND action = p_action AND auto_run
     AND p_venture = ANY (private.writable_ventures())
$$;

-- ---------------------------------------------------------------------------
-- Worker entry points. They return routing ids only (never tenant content);
-- the worker then reads the run itself under RLS as the venture's agent.
-- ---------------------------------------------------------------------------
CREATE FUNCTION private.run_principal(p_run uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT run_as FROM workflow_runs WHERE id = p_run
$$;

CREATE FUNCTION private.runnable_runs(p_limit int) RETURNS TABLE (run_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, run_as FROM workflow_runs
   WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
   ORDER BY updated_at LIMIT p_limit
$$;

CREATE FUNCTION private.scheduled_workflows(p_hhmm text)
RETURNS TABLE (org_id uuid, venture_id uuid, workflow text, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.org_id, c.venture_id, c.workflow, private.provision_service_account(c.org_id, c.venture_id)
    FROM workflow_configs c WHERE c.enabled AND c.schedule = p_hhmm
$$;

CREATE FUNCTION private.active_connectors(p_provider text)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.provider = p_provider AND c.status = 'active'
$$;

-- Expire overdue drafts and wake their runs (the workflow's on_reject path handles them).
CREATE FUNCTION private.expire_approvals() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  WITH gone AS (
    UPDATE approvals SET status = 'expired'
     WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()
    RETURNING run_id)
  UPDATE workflow_runs r SET status = 'queued', updated_at = now()
    FROM gone WHERE r.id = gone.run_id AND r.status = 'waiting';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Webhooks arrive unauthenticated (HMAC-verified by the API); resolve which
-- venture's agent handles them without revealing anything else.
CREATE FUNCTION private.webhook_principal(p_connector uuid)
RETURNS TABLE (org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.id = p_connector AND c.provider = 'webhook' AND c.status = 'active'
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON venture_settings, workflow_configs TO kritvia_app;
GRANT SELECT, INSERT, UPDATE ON workflow_runs TO kritvia_app;
GRANT SELECT, INSERT ON workflow_steps, trigger_events TO kritvia_app;
GRANT UPDATE (run_id) ON trigger_events TO kritvia_app;
GRANT SELECT, INSERT ON approvals TO kritvia_app;
-- Decisions go through decide_approval(); the runtime may only stamp execution
-- or cancel its own pending drafts.
GRANT UPDATE (executed_at, execution_result, status) ON approvals TO kritvia_app;
GRANT SELECT ON agent_trust TO kritvia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON connectors, connector_tokens TO kritvia_app;
GRANT SELECT, INSERT ON outbox_messages TO kritvia_app;

GRANT EXECUTE ON FUNCTION private.has_venture_role(uuid, text[]), private.is_service_user(),
  private.can_admin_venture(uuid), private.run_principal(uuid), private.runnable_runs(int),
  private.scheduled_workflows(text), private.active_connectors(text),
  private.webhook_principal(uuid), private.expire_approvals() TO kritvia_app;
GRANT EXECUTE ON FUNCTION public.decide_approval(uuid, text, bytea, text),
  public.set_autonomy(uuid, text, text, boolean, text),
  public.record_auto_execution(uuid, text, text),
  public.venture_service_account(uuid) TO kritvia_app;

-- The runtime may flip status only on pending drafts it is cancelling, or an
-- approved draft it has executed; humans decide through decide_approval().
CREATE FUNCTION private.guard_approval_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'kritvia_app' AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'pending' AND NEW.status IN ('cancelled', 'expired')) THEN
    RAISE EXCEPTION 'approval status can only change through decide_approval()' USING ERRCODE = '42501';
  END IF;
  IF current_user = 'kritvia_app' AND NEW.executed_at IS NOT NULL AND OLD.executed_at IS NOT NULL
     AND NEW.executed_at IS DISTINCT FROM OLD.executed_at THEN
    RAISE EXCEPTION 'approval already executed' USING ERRCODE = 'KV409';
  END IF;
  IF current_user = 'kritvia_app' AND NEW.executed_at IS NOT NULL AND OLD.executed_at IS NULL
     AND OLD.status NOT IN ('approved', 'edited', 'auto_approved') THEN
    RAISE EXCEPTION 'cannot execute an undecided or rejected approval' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_guard BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION private.guard_approval_update();

-- auto_approved rows are only valid when the (agent, action) is trusted.
CREATE FUNCTION private.guard_approval_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'auto_approved' AND NOT EXISTS (
       SELECT 1 FROM agent_trust t WHERE t.venture_id = NEW.venture_id AND t.agent = NEW.agent
          AND t.action = NEW.action AND t.auto_run) THEN
    RAISE EXCEPTION 'action %/% has not been promoted to auto-run', NEW.agent, NEW.action
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status NOT IN ('pending', 'auto_approved') THEN
    RAISE EXCEPTION 'approvals must be created pending' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'auto_approved' THEN
    NEW.final_payload_enc := NEW.payload_enc;
    NEW.decided_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_guard_insert BEFORE INSERT ON approvals
  FOR EACH ROW EXECUTE FUNCTION private.guard_approval_insert();
