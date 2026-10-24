-- =============================================================================
-- 0080 Autopilot (services/autopilot.py): one switch per business that lets the agents do routine work by
-- themselves. Off until the business switches it on (onboarding asks; existing businesses get a card).
--
-- The database decides what autopilot may ever approve by itself, whatever the code asks for: only these
-- agent / step / action combinations, only in a run of the matching workflow, only while the business's
-- autopilot is on, and never a sensitive draft (checked by guard_approval_insert as before). Invoices,
-- purchase orders, proposals, refunds, campaigns, payments, calls and changes in other apps are not on the
-- list, so they always wait for a person. The owner draft of the inbox (money, complaints, orders) is not
-- on it either.
-- =============================================================================
ALTER TABLE venture_settings ADD COLUMN autopilot boolean NOT NULL DEFAULT false,
  ADD COLUMN autopilot_changed_at timestamptz,
  ADD COLUMN autopilot_changed_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE FUNCTION private.autopilot_allows(p_venture uuid, p_run uuid, p_agent text, p_step text, p_action text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM venture_settings s
      JOIN workflow_runs r ON r.venture_id = s.venture_id AND r.id = p_run
     WHERE s.venture_id = p_venture AND s.autopilot
       AND (r.workflow, p_agent, p_step) IN (
             ('inbox_assistant', 'inbox', 'draft'), ('inbox_assistant', 'inbox', 'hold'),
             ('inbox_assistant', 'inbox', 'facts'),
             ('booking_reminders', 'booking_reminders', 'draft'),
             ('collections', 'collections', 'draft'),
             ('reviews', 'reviews', 'reply'), ('reviews', 'reviews', 'ask'),
             ('social', 'social', 'draft'),
             ('whatsapp_followup', 'followup', 'draft'),
             ('prospector', 'prospector', 'draft'))
       AND p_action IN ('whatsapp.send', 'whatsapp.template', 'telegram.send', 'gmail.send',
                        'google.review_reply', 'social.post'))
$$;
REVOKE ALL ON FUNCTION private.autopilot_allows(uuid, uuid, text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION private.guard_approval_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE chan text := CASE NEW.action WHEN 'whatsapp.send' THEN 'whatsapp' WHEN 'telegram.send' THEN 'telegram'
                                     WHEN 'gmail.send' THEN 'email' END;
BEGIN
  IF NEW.status NOT IN ('pending', 'auto_approved') THEN
    RAISE EXCEPTION 'approvals must be created pending' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'auto_approved' AND (NEW.sensitive OR NOT (
       EXISTS (SELECT 1 FROM agent_trust t WHERE t.venture_id = NEW.venture_id AND t.agent = NEW.agent
                  AND t.action = NEW.action AND t.auto_run)
       OR (NEW.agent = 'inbox' AND NEW.step = 'facts' AND chan IS NOT NULL
           AND EXISTS (SELECT 1 FROM workflow_runs r
                         JOIN workflow_configs c ON c.venture_id = r.venture_id AND c.workflow = r.workflow
                        WHERE r.id = NEW.run_id AND r.venture_id = NEW.venture_id
                          AND r.workflow = 'inbox_assistant' AND c.enabled
                          AND jsonb_typeof(c.settings -> 'answer_facts') = 'boolean'
                          AND (c.settings ->> 'answer_facts')::boolean))
       OR (NEW.agent = 'inbox' AND NEW.step IN ('draft', 'hold', 'facts') AND chan IS NOT NULL
           AND EXISTS (SELECT 1 FROM workflow_runs r
                         JOIN workflow_configs c ON c.venture_id = r.venture_id AND c.workflow = r.workflow
                        WHERE r.id = NEW.run_id AND r.venture_id = NEW.venture_id
                          AND r.workflow = 'inbox_assistant' AND c.enabled
                          AND jsonb_typeof(c.settings -> 'auto_reply') = 'boolean'
                          AND (c.settings ->> 'auto_reply')::boolean
                          AND (NOT (c.settings ? 'auto_reply_channels')
                               OR (jsonb_typeof(c.settings -> 'auto_reply_channels') = 'array'
                                   AND c.settings -> 'auto_reply_channels' ? chan))))
       OR private.autopilot_allows(NEW.venture_id, NEW.run_id, NEW.agent, NEW.step, NEW.action))) THEN
    RAISE EXCEPTION 'action %/% may not be auto-approved', NEW.agent, NEW.action USING ERRCODE = '42501';
  END IF;
  IF NEW.required_roles IS NULL OR cardinality(NEW.required_roles) = 0
     OR NOT (NEW.required_roles <@ ARRAY(SELECT name FROM roles WHERE can_approve)) THEN
    RAISE EXCEPTION 'required_roles must be approving roles' USING ERRCODE = '42501';
  END IF;
  -- decisions and execution are never supplied by the inserter
  NEW.decided_by := NULL; NEW.comment := NULL; NEW.executed_at := NULL; NEW.execution_result := NULL;
  IF NEW.status = 'auto_approved' THEN
    NEW.final_payload_enc := NEW.payload_enc;
    NEW.decided_at := now();
  ELSE
    NEW.final_payload_enc := NULL;
    NEW.decided_at := NULL;
  END IF;
  RETURN NEW;
END $$;

-- Businesses with autopilot on, and who reads as the business for the 8 pm summary.
CREATE FUNCTION private.autopilot_targets()
RETURNS TABLE (venture_id uuid, org_id uuid, run_as uuid, business text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.venture_id, v.org_id, private.venture_owner(v.org_id), coalesce(nullif(s.business_name, ''), v.name)
    FROM venture_settings s
    JOIN ventures v ON v.id = s.venture_id AND v.removed_at IS NULL
    JOIN organisations o ON o.id = v.org_id AND o.closed_at IS NULL
   WHERE s.autopilot
$$;
REVOKE ALL ON FUNCTION private.autopilot_targets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.autopilot_targets() TO kritvia_app;
