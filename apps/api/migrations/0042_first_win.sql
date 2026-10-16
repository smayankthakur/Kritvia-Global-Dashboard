-- =============================================================================
-- 0042 First win: the steps from sign-up to a business's first approved draft, and Kritvia's own
-- "Pilot health" view of every organisation's progress (staff only; gated in the API by STAFF_EMAILS).
--
-- Nothing new is stored: progress is read from what the business has done (profile, connectors,
-- agents, approvals, phone notifications).
-- =============================================================================

-- One business's steps, for anyone who can see it.
CREATE FUNCTION private.first_win(p_venture uuid)
RETURNS TABLE (created_at timestamptz, has_profile boolean, has_channel boolean, agents_on int,
               first_draft_at timestamptz, first_yes_at timestamptz, on_phone boolean, has_invoice boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.created_at,
         EXISTS (SELECT 1 FROM venture_settings s WHERE s.venture_id = v.id AND coalesce(s.business_name, '') <> ''
                                                    AND coalesce(s.city, '') <> ''),
         EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = v.id AND c.status = 'active'
                                              AND c.provider IN ('google', 'whatsapp', 'telegram', 'email_in')),
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
GRANT EXECUTE ON FUNCTION private.first_win(uuid) TO kritvia_app;

-- Every organisation, for Kritvia's team. Counts and dates only: no customer data.
CREATE FUNCTION private.pilot_health()
RETURNS TABLE (org_id uuid, org_name text, owner_email text, plan text, trial_ends_at timestamptz,
               created_at timestamptz, businesses int, members int, has_profile boolean, has_channel boolean,
               agents_on int, first_draft_at timestamptz, first_yes_at timestamptz, on_phone boolean,
               drafts_7d int, decided_7d int, last_active_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.name,
         (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = o.id AND m.role = 'org_owner' ORDER BY m.created_at LIMIT 1),
         p.plan, o.trial_ends_at, o.created_at,
         (SELECT count(*)::int FROM ventures v WHERE v.org_id = o.id AND v.removed_at IS NULL),
         (SELECT count(DISTINCT m.user_id)::int FROM memberships m WHERE m.org_id = o.id),
         EXISTS (SELECT 1 FROM venture_settings s JOIN ventures v ON v.id = s.venture_id
                  WHERE v.org_id = o.id AND coalesce(s.business_name, '') <> '' AND coalesce(s.city, '') <> ''),
         EXISTS (SELECT 1 FROM connectors c WHERE c.org_id = o.id AND c.status = 'active'
                                              AND c.provider IN ('google', 'whatsapp', 'telegram', 'email_in')),
         (SELECT count(*)::int FROM workflow_configs w JOIN ventures v ON v.id = w.venture_id
           WHERE v.org_id = o.id AND w.enabled),
         (SELECT min(a.created_at) FROM approvals a WHERE a.org_id = o.id),
         (SELECT min(a.decided_at) FROM approvals a WHERE a.org_id = o.id AND a.decided_by IS NOT NULL
                                                    AND a.status IN ('approved', 'edited', 'executed')),
         EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.org_id = o.id)
           OR EXISTS (SELECT 1 FROM approver_links l WHERE l.org_id = o.id),
         (SELECT count(*)::int FROM approvals a WHERE a.org_id = o.id AND a.created_at > now() - interval '7 days'),
         (SELECT count(*)::int FROM approvals a WHERE a.org_id = o.id AND a.decided_by IS NOT NULL
                                                 AND a.decided_at > now() - interval '7 days'),
         greatest((SELECT max(r.created_at) FROM workflow_runs r WHERE r.org_id = o.id),
                  (SELECT max(a.decided_at) FROM approvals a WHERE a.org_id = o.id))
    FROM organisations o LEFT JOIN org_plans p ON p.org_id = o.id
   WHERE o.closed_at IS NULL
   ORDER BY o.created_at DESC
   LIMIT 500
$$;
-- Only the API calls this, and only for STAFF_EMAILS.
GRANT EXECUTE ON FUNCTION private.pilot_health() TO kritvia_app;
