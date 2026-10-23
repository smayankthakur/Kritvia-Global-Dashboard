-- =============================================================================
-- 0075 The answering machine, customer side (services/customer_facts.py).
-- A customer's question about their own records (balance, pay link, booking, shipment) is answered with
-- text built by code from those records. When the business switches on the inbox assistant's option
-- "answer_facts", that answer is approved by itself. The database lets an approval be created as
-- auto_approved either by earned autonomy (agent_trust, as before) or by this one switch, and only for:
--   agent 'inbox' at the step 'facts' (the code-built answer; never the AI-written reply drafts),
--   the three reply actions (whatsapp.send, telegram.send, gmail.send),
--   a run of inbox_assistant in the same business, whose settings have answer_facts = true,
--   never a sensitive draft.
-- Everything else is unchanged from 0006.
-- =============================================================================
CREATE OR REPLACE FUNCTION private.guard_approval_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status NOT IN ('pending', 'auto_approved') THEN
    RAISE EXCEPTION 'approvals must be created pending' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'auto_approved' AND (NEW.sensitive OR NOT (
       EXISTS (SELECT 1 FROM agent_trust t WHERE t.venture_id = NEW.venture_id AND t.agent = NEW.agent
                  AND t.action = NEW.action AND t.auto_run)
       OR (NEW.agent = 'inbox' AND NEW.step = 'facts'
           AND NEW.action IN ('whatsapp.send', 'telegram.send', 'gmail.send')
           AND EXISTS (SELECT 1 FROM workflow_runs r
                         JOIN workflow_configs c ON c.venture_id = r.venture_id AND c.workflow = r.workflow
                        WHERE r.id = NEW.run_id AND r.venture_id = NEW.venture_id
                          AND r.workflow = 'inbox_assistant' AND c.enabled
                          AND jsonb_typeof(c.settings -> 'answer_facts') = 'boolean'
                          AND (c.settings ->> 'answer_facts')::boolean)))) THEN
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
