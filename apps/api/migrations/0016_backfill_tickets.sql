-- =============================================================================
-- Kritvia 0016 — Board cards for runs that started before the board existed.
-- Every run still open (queued, running, waiting, failed) and every run that
-- finished in the last 7 days gets its ticket, so the board is not empty on day one.
-- =============================================================================
INSERT INTO tickets (org_id, venture_id, run_id, workflow, role, title, status, note, created_by,
                     created_at, updated_at, finished_at)
SELECT r.org_id, r.venture_id, r.id, r.workflow,
       coalesce(c.role, private.default_role(r.workflow)),
       left(coalesce(nullif(r.title, ''), r.workflow), 200),
       CASE
         WHEN r.status = 'waiting' AND EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending')
           THEN 'waiting_approval'
         WHEN r.status IN ('queued', 'running', 'waiting') THEN 'open'
         WHEN r.status = 'failed' THEN 'blocked'
         WHEN r.status = 'cancelled' THEN 'cancelled'
         ELSE 'done'
       END,
       left(coalesce(CASE WHEN r.status = 'failed' THEN split_part(coalesce(r.error, ''), ': ', 2) ELSE r.outcome END, ''), 500),
       r.started_by, r.created_at, r.updated_at, r.finished_at
  FROM workflow_runs r
  LEFT JOIN workflow_configs c ON c.venture_id = r.venture_id AND c.workflow = r.workflow
 WHERE NOT EXISTS (SELECT 1 FROM tickets t WHERE t.run_id = r.id)
   AND (r.status IN ('queued', 'running', 'waiting', 'failed') OR r.finished_at > now() - interval '7 days');
