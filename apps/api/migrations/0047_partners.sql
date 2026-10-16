-- =============================================================================
-- 0047 Partner programme: CAs and agencies who bring businesses to Kritvia.
--
--   partners              a Kritvia user who applied (and Kritvia's team approved): their referral code,
--                         firm, and the UPI ID payouts go to.
--   partner_referrals     an organisation that signed up with a partner's code (one partner per org, set
--                         in its first 30 days and before it first pays). The business gets 10% off its
--                         first 3 months; the partner earns 20% of what it pays for 12 months.
--   partner_commissions   20% of each payment Razorpay confirms in those 12 months (once per payment).
--   partner_payouts       what Kritvia's team paid out, with the UPI or bank reference.
--
-- A partner sees only their own row, their referrals (organisation name, plan and dates, never its
-- data) and their money. Approvals and payouts are made by Kritvia's team through the API (STAFF_EMAILS).
-- =============================================================================
CREATE TABLE partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{4,12}$'),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  firm          text CHECK (char_length(firm) <= 160),
  kind          text NOT NULL CHECK (kind IN ('ca', 'agency', 'consultant', 'other')),
  city          text CHECK (char_length(city) <= 80),
  phone         text CHECK (phone IS NULL OR phone ~ '^[0-9]{8,15}$'),
  upi_id        text CHECK (upi_id IS NULL OR (upi_id ~ '^[A-Za-z0-9._-]+@[A-Za-z][A-Za-z0-9.-]+$' AND char_length(upi_id) <= 300)),
  status        text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'active', 'paused', 'rejected')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz
);
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners FORCE ROW LEVEL SECURITY;
CREATE POLICY partners_self_read ON partners FOR SELECT USING (user_id = private.current_user_id());
CREATE POLICY partners_self_apply ON partners FOR INSERT
  WITH CHECK (user_id = private.current_user_id() AND status = 'applied' AND approved_at IS NULL);
CREATE POLICY partners_self_edit ON partners FOR UPDATE
  USING (user_id = private.current_user_id()) WITH CHECK (user_id = private.current_user_id());
-- A partner edits their contact and payout details; status and code change only through Kritvia's team.
GRANT SELECT, INSERT ON partners TO kritvia_app;
GRANT UPDATE (name, firm, city, phone, upi_id) ON partners TO kritvia_app;

CREATE TABLE partner_referrals (
  org_id            uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  partner_id        uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  commission_until  timestamptz NOT NULL DEFAULT now() + interval '12 months'
);
CREATE INDEX partner_referrals_partner_idx ON partner_referrals (partner_id);
ALTER TABLE partner_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_referrals FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_referrals_read ON partner_referrals FOR SELECT
  USING (org_id = ANY (private.owned_orgs())
         OR partner_id IN (SELECT p.id FROM partners p WHERE p.user_id = private.current_user_id()));
GRANT SELECT ON partner_referrals TO kritvia_app;

CREATE TABLE partner_payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  reference     text NOT NULL CHECK (char_length(reference) BETWEEN 3 AND 80),
  paid_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE partner_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_payouts_read ON partner_payouts FOR SELECT
  USING (partner_id IN (SELECT p.id FROM partners p WHERE p.user_id = private.current_user_id()));
GRANT SELECT ON partner_payouts TO kritvia_app;

CREATE TABLE partner_commissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  org_id           uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  payment_ref      text NOT NULL UNIQUE CHECK (char_length(payment_ref) BETWEEN 1 AND 120),
  paid_paise       bigint NOT NULL CHECK (paid_paise > 0),
  commission_paise bigint NOT NULL CHECK (commission_paise >= 0),
  earned_at        timestamptz NOT NULL DEFAULT now(),
  payout_id        uuid REFERENCES partner_payouts(id) ON DELETE SET NULL
);
CREATE INDEX partner_commissions_partner_idx ON partner_commissions (partner_id, earned_at);
ALTER TABLE partner_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_commissions FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_commissions_read ON partner_commissions FOR SELECT
  USING (partner_id IN (SELECT p.id FROM partners p WHERE p.user_id = private.current_user_id()));
GRANT SELECT ON partner_commissions TO kritvia_app;

-- An owner enters a partner's code: only an active partner, only in the organisation's first 30 days, and
-- only before it has paid. A partner can't refer their own organisation.
CREATE FUNCTION private.use_partner_code(p_org uuid, p_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_partner partners; v_created timestamptz;
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'organisation not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_partner FROM partners WHERE code = upper(trim(p_code)) AND status = 'active';
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF v_partner.user_id = private.current_user_id()
     OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p_org AND m.user_id = v_partner.user_id AND m.role = 'org_owner') THEN
    RETURN 'own';
  END IF;
  IF EXISTS (SELECT 1 FROM partner_referrals WHERE org_id = p_org) THEN RETURN 'already'; END IF;
  SELECT created_at INTO v_created FROM organisations WHERE id = p_org;
  IF v_created < now() - interval '30 days'
     OR EXISTS (SELECT 1 FROM billing_events e WHERE e.org_id = p_org AND e.amount_paise > 0) THEN
    RETURN 'too_late';
  END IF;
  INSERT INTO partner_referrals (org_id, partner_id) VALUES (p_org, v_partner.id);
  RETURN 'ok';
END $$;
GRANT EXECUTE ON FUNCTION private.use_partner_code(uuid, text) TO kritvia_app;

-- Called by the billing webhook for each confirmed payment.
CREATE FUNCTION private.partner_commission(p_org uuid, p_payment text, p_paise bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  SELECT pr.partner_id INTO r FROM partner_referrals pr JOIN partners p ON p.id = pr.partner_id
   WHERE pr.org_id = p_org AND pr.commission_until > now() AND p.status IN ('active', 'paused');
  IF NOT FOUND OR p_paise IS NULL OR p_paise <= 0 THEN RETURN false; END IF;
  INSERT INTO partner_commissions (partner_id, org_id, payment_ref, paid_paise, commission_paise)
  VALUES (r.partner_id, p_org, p_payment, p_paise, round(p_paise * 0.20))
  ON CONFLICT (payment_ref) DO NOTHING;
  RETURN FOUND;
END $$;
GRANT EXECUTE ON FUNCTION private.partner_commission(uuid, text, bigint) TO kritvia_app;

CREATE FUNCTION private.org_has_partner_discount(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM partner_referrals WHERE org_id = p_org AND created_at > now() - interval '6 months')
$$;
GRANT EXECUTE ON FUNCTION private.org_has_partner_discount(uuid) TO kritvia_app;

-- A partner's referred organisations: name, plan and dates only.
CREATE FUNCTION private.partner_orgs()
RETURNS TABLE (org_id uuid, name text, plan text, referred_at timestamptz, commission_until timestamptz,
               earned_paise bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.name, coalesce(op.plan, 'trial'), pr.created_at, pr.commission_until,
         coalesce((SELECT sum(c.commission_paise) FROM partner_commissions c WHERE c.org_id = o.id
                    AND c.partner_id = pr.partner_id), 0)::bigint
    FROM partner_referrals pr JOIN partners p ON p.id = pr.partner_id AND p.user_id = private.current_user_id()
    JOIN organisations o ON o.id = pr.org_id LEFT JOIN org_plans op ON op.org_id = o.id
   ORDER BY pr.created_at DESC
$$;
GRANT EXECUTE ON FUNCTION private.partner_orgs() TO kritvia_app;

-- Kritvia's team (the API checks STAFF_EMAILS before calling these).
CREATE FUNCTION private.staff_partners()
RETURNS TABLE (id uuid, name text, firm text, kind text, city text, email text, phone text, upi_id text, code text,
               status text, created_at timestamptz, referrals int, earned_paise bigint, paid_paise bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.name, p.firm, p.kind, p.city, u.email, p.phone, p.upi_id, p.code, p.status, p.created_at,
         (SELECT count(*)::int FROM partner_referrals r WHERE r.partner_id = p.id),
         coalesce((SELECT sum(c.commission_paise) FROM partner_commissions c WHERE c.partner_id = p.id), 0)::bigint,
         coalesce((SELECT sum(x.amount_paise) FROM partner_payouts x WHERE x.partner_id = p.id), 0)::bigint
    FROM partners p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC
$$;
GRANT EXECUTE ON FUNCTION private.staff_partners() TO kritvia_app;

CREATE FUNCTION private.staff_set_partner_status(p_partner uuid, p_status text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE partners SET status = p_status,
         approved_at = CASE WHEN p_status = 'active' THEN coalesce(approved_at, now()) ELSE approved_at END
   WHERE id = p_partner AND p_status IN ('active', 'paused', 'rejected')
$$;
GRANT EXECUTE ON FUNCTION private.staff_set_partner_status(uuid, text) TO kritvia_app;

-- Pays out everything earned and not yet paid, in one payout with the given reference.
CREATE FUNCTION private.staff_record_payout(p_partner uuid, p_reference text, p_by uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_total bigint; v_id uuid;
BEGIN
  SELECT coalesce(sum(commission_paise), 0) INTO v_total FROM partner_commissions
   WHERE partner_id = p_partner AND payout_id IS NULL;
  IF v_total <= 0 THEN RETURN 0; END IF;
  INSERT INTO partner_payouts (partner_id, amount_paise, reference, paid_by)
  VALUES (p_partner, v_total, p_reference, p_by) RETURNING id INTO v_id;
  UPDATE partner_commissions SET payout_id = v_id WHERE partner_id = p_partner AND payout_id IS NULL;
  RETURN v_total;
END $$;
GRANT EXECUTE ON FUNCTION private.staff_record_payout(uuid, text, uuid) TO kritvia_app;

-- The partner an owner's organisation came through (name or firm only).
CREATE FUNCTION private.org_partner_name(p_org uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(nullif(p.firm, ''), p.name) FROM partner_referrals r JOIN partners p ON p.id = r.partner_id
   WHERE r.org_id = p_org AND p_org = ANY (private.owned_orgs())
$$;
GRANT EXECUTE ON FUNCTION private.org_partner_name(uuid) TO kritvia_app;
