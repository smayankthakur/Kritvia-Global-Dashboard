-- Round 3 test report, data fixes.
--
-- B8  A proposal belongs to its lead: deleting the lead deletes its proposals (they were left behind,
--     still counting towards the monthly proposal allowance, feeding "similar past projects" prices and
--     holding the deleted person's details). Proposals whose lead is already gone are deleted here.
--     The constraint is added NOT VALID (no long lock); 0079 validates it outside a transaction.
-- B7  The record of a sent message (outbox_messages) no longer pins its run forever: it now carries the
--     run, workflow and send time itself, and the approval it came from may be purged (approval_id is set
--     to NULL). Old runs that sent something are purged like any other, and message bodies are cleared a
--     year after sending (the metadata row stays: what was sent to whom, and when).

-- B8 ----------------------------------------------------------------------------------------------------
DELETE FROM proposals p WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = p.lead_id);
ALTER TABLE proposals ADD CONSTRAINT proposals_lead_fk FOREIGN KEY (lead_id) REFERENCES leads(id)
  ON DELETE CASCADE NOT VALID;
CREATE INDEX proposals_lead_id_idx ON proposals (lead_id);

-- B7 ----------------------------------------------------------------------------------------------------
ALTER TABLE outbox_messages ADD COLUMN run_id uuid, ADD COLUMN workflow text;
UPDATE outbox_messages o SET run_id = a.run_id, workflow = r.workflow
  FROM approvals a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = o.approval_id;
ALTER TABLE outbox_messages ALTER COLUMN approval_id DROP NOT NULL;
ALTER TABLE outbox_messages DROP CONSTRAINT outbox_messages_approval_id_fkey;
ALTER TABLE outbox_messages ADD CONSTRAINT outbox_messages_approval_id_fkey FOREIGN KEY (approval_id)
  REFERENCES approvals(id) ON DELETE SET NULL NOT VALID;

-- New rows get run and workflow from their approval.
CREATE FUNCTION private.outbox_fill_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.run_id IS NULL AND NEW.approval_id IS NOT NULL THEN
    SELECT a.run_id, r.workflow INTO NEW.run_id, NEW.workflow
      FROM approvals a JOIN workflow_runs r ON r.id = a.run_id WHERE a.id = NEW.approval_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_fill_run BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION private.outbox_fill_run();

-- Finished runs older than p_days: deleted with their steps, cards and tickets (a run with a card still
-- waiting is kept). Steps of runs that are kept go by age, oldest first, so the clean-up keeps moving.
CREATE OR REPLACE FUNCTION private.purge_run_history(p_days int, p_limit int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cutoff timestamptz := now() - make_interval(days => greatest(p_days, 30)); n int; m int; b int;
BEGIN
  WITH old AS (
    SELECT r.id FROM workflow_runs r
     WHERE r.finished_at < cutoff AND r.status IN ('completed', 'failed', 'cancelled')
       AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending')
     ORDER BY r.finished_at LIMIT p_limit)
  DELETE FROM workflow_runs w USING old WHERE w.id = old.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  WITH old_steps AS (SELECT s.ctid FROM workflow_steps s WHERE s.created_at < cutoff LIMIT p_limit)
  DELETE FROM workflow_steps s USING old_steps WHERE s.ctid = old_steps.ctid;
  GET DIAGNOSTICS m = ROW_COUNT;
  WITH old_bodies AS (SELECT o.id FROM outbox_messages o
                       WHERE o.created_at < now() - interval '365 days' AND o.body_enc IS NOT NULL LIMIT p_limit)
  UPDATE outbox_messages o SET body_enc = NULL FROM old_bodies WHERE o.id = old_bodies.id;
  GET DIAGNOSTICS b = ROW_COUNT;
  RETURN n + m + b;
END $$;
GRANT EXECUTE ON FUNCTION private.purge_run_history(int, int) TO kritvia_app;

-- B12 ---------------------------------------------------------------------------------------------------
-- A daily job counts as done only when it finished. One that failed, or was cut short by a restart (a deploy
-- mid-job), is claimed again on a later tick the same day once its 30-minute claim runs out, up to 3 tries.
ALTER TABLE scheduled_job_runs ADD COLUMN done boolean NOT NULL DEFAULT true,
  ADD COLUMN attempts int NOT NULL DEFAULT 1, ADD COLUMN claimed_until timestamptz;
CREATE OR REPLACE FUNCTION private.claim_daily_job(p_name text, p_day date) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO scheduled_job_runs (name, ran_on, done, attempts, claimed_until)
  VALUES (p_name, p_day, false, 1, now() + interval '30 minutes')
  ON CONFLICT (name) DO UPDATE SET
    attempts = CASE WHEN scheduled_job_runs.ran_on < EXCLUDED.ran_on THEN 1 ELSE scheduled_job_runs.attempts + 1 END,
    ran_on = EXCLUDED.ran_on, ran_at = now(), done = false, claimed_until = now() + interval '30 minutes'
   WHERE scheduled_job_runs.ran_on < EXCLUDED.ran_on
      OR (scheduled_job_runs.ran_on = EXCLUDED.ran_on AND NOT scheduled_job_runs.done
          AND scheduled_job_runs.attempts < 3 AND scheduled_job_runs.claimed_until < now())
  RETURNING true
$$;
CREATE FUNCTION private.daily_job_done(p_name text, p_ok boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE scheduled_job_runs SET done = p_ok, claimed_until = CASE WHEN p_ok THEN claimed_until ELSE now() END
   WHERE name = p_name
$$;
GRANT EXECUTE ON FUNCTION private.daily_job_done(text, boolean) TO kritvia_app;

-- A1 ----------------------------------------------------------------------------------------------------
-- First win: "Connect where customers write" is done when replies can also go out.
CREATE OR REPLACE FUNCTION private.first_win(p_venture uuid)
RETURNS TABLE (created_at timestamptz, has_profile boolean, has_channel boolean, agents_on int,
               first_draft_at timestamptz, first_yes_at timestamptz, on_phone boolean, has_invoice boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.created_at,
         EXISTS (SELECT 1 FROM venture_settings s WHERE s.venture_id = v.id AND coalesce(s.business_name, '') <> ''
                                                    AND coalesce(s.city, '') <> ''),
         -- a channel replies can go out on: forwarding alone brings mail in but can't send (round 3, A1)
         EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = v.id AND c.status = 'active'
                                              AND c.provider IN ('google', 'whatsapp', 'telegram')),
         (SELECT count(*)::int FROM workflow_configs w WHERE w.venture_id = v.id AND w.enabled),
         (SELECT min(a.created_at) FROM approvals a WHERE a.venture_id = v.id),
         (SELECT min(a.decided_at) FROM approvals a WHERE a.venture_id = v.id AND a.decided_by IS NOT NULL
                                                    AND a.status IN ('approved', 'edited', 'executed')),
         EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = private.current_user_id())
           OR EXISTS (SELECT 1 FROM approver_links l WHERE l.venture_id = v.id AND l.user_id = private.current_user_id()),
         EXISTS (SELECT 1 FROM invoices i WHERE i.venture_id = v.id)
    FROM ventures v
   WHERE v.id = p_venture AND v.removed_at IS NULL
     AND (p_venture = ANY ((SELECT private.readable_ventures())::uuid[]) OR v.org_id = ANY (private.owned_orgs()))
$$;

-- A14 ---------------------------------------------------------------------------------------------------
-- "Write a post now" with nowhere connected yet writes a post to copy (no channels).
ALTER TABLE social_posts DROP CONSTRAINT social_posts_channels_check;
ALTER TABLE social_posts ADD CONSTRAINT social_posts_channels_check
  CHECK (channels <@ ARRAY['google', 'facebook']::text[]);
