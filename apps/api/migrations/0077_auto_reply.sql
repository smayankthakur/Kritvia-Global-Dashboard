-- =============================================================================
-- 0077 Replying by itself (the inbox assistant's auto_reply option; services/auto_reply.py).
-- With auto_reply on, a customer's message gets its answer straight away. The database lets an approval be
-- created as auto_approved by earned autonomy (agent_trust, as before), by answer_facts (0075, unchanged), or
-- by auto_reply, and only for:
--   agent 'inbox' at the step 'draft' (the reply), 'hold' (the code-written "let me check with the team")
--   or 'facts' (the code-built answer from the customer's records),
--   the reply action of a channel the owner switched on (auto_reply_channels; all three when not narrowed):
--   whatsapp.send / telegram.send / gmail.send (email),
--   a run of inbox_assistant in the same business, with the agent on,
--   never a sensitive draft.
-- The step 'owner_draft' (a money promise or complaint, waiting for the owner) is never auto-approved.
-- =============================================================================
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
                                   AND c.settings -> 'auto_reply_channels' ? chan)))))) THEN
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
