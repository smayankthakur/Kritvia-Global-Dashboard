-- =============================================================================
-- 0060 Unstick: drafts don't expire unseen, and Kritvia tells the owner every morning what is stuck.
--
--   approvals.nudged_at           when the owner was told a waiting draft is about to expire (once per draft)
--   automation_checks             the morning self-check per business: what was found and when the owner
--                                 was last told (so the same news isn't repeated every day)
--   private.claim_expiring_approvals(now, within)
--                                 drafts expiring soon that nobody was nudged about; marks them nudged
--   private.self_check_targets()  businesses with an agent switched on, and the owner they are checked as
--   private.record_self_check(v, findings, digest, told)
-- =============================================================================
ALTER TABLE approvals ADD COLUMN nudged_at timestamptz;
CREATE INDEX approvals_expiring_idx ON approvals (expires_at) WHERE status = 'pending' AND nudged_at IS NULL;

CREATE TABLE automation_checks (
  venture_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  findings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  digest       text NOT NULL DEFAULT '' CHECK (char_length(digest) <= 64),
  notified_at  timestamptz,
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('automation_checks');
GRANT SELECT ON automation_checks TO kritvia_app;

CREATE FUNCTION private.claim_expiring_approvals(p_now timestamptz, p_within interval)
RETURNS TABLE (approval_id uuid, venture_id uuid, org_id uuid, title text, agent text, expires_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE approvals a SET nudged_at = p_now
   WHERE a.status = 'pending' AND a.nudged_at IS NULL AND a.expires_at IS NOT NULL
     AND a.expires_at > p_now AND a.expires_at <= p_now + p_within
  RETURNING a.id, a.venture_id, a.org_id, a.title, a.agent, a.expires_at
$$;
-- Only the worker calls this.
GRANT EXECUTE ON FUNCTION private.claim_expiring_approvals(timestamptz, interval) TO kritvia_app;

CREATE FUNCTION private.self_check_targets()
RETURNS TABLE (venture_id uuid, org_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.id, v.org_id,
         (SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = v.org_id AND m.role = 'org_owner' AND m.venture_id IS NULL AND u.is_active
           ORDER BY m.created_at LIMIT 1)
    FROM ventures v JOIN organisations o ON o.id = v.org_id
   WHERE v.removed_at IS NULL AND o.closed_at IS NULL
     AND EXISTS (SELECT 1 FROM workflow_configs w WHERE w.venture_id = v.id AND w.enabled)
   ORDER BY v.created_at
   LIMIT 5000
$$;
GRANT EXECUTE ON FUNCTION private.self_check_targets() TO kritvia_app;

CREATE FUNCTION private.record_self_check(p_venture uuid, p_findings jsonb, p_digest text, p_told boolean)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO automation_checks (venture_id, org_id, checked_at, findings, digest, notified_at)
  SELECT v.id, v.org_id, now(), p_findings, left(p_digest, 64), CASE WHEN p_told THEN now() END
    FROM ventures v WHERE v.id = p_venture
  ON CONFLICT (venture_id) DO UPDATE SET checked_at = now(), findings = EXCLUDED.findings,
    digest = EXCLUDED.digest,
    notified_at = CASE WHEN p_told THEN now() ELSE automation_checks.notified_at END
$$;
GRANT EXECUTE ON FUNCTION private.record_self_check(uuid, jsonb, text, boolean) TO kritvia_app;
