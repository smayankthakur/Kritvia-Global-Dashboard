-- =============================================================================
-- 0073 The assistant's trust boundary and where customers pay (test report round 2: S11, S16).
--
--   invoices.upi_id                  the UPI ID an invoice was issued with. The pay page shows it, not whatever the
--                                    payment settings say today, so a later change of UPI ID (by mistake, or by
--                                    someone who shouldn't) can't redirect money owed on invoices already sent.
--   private.auth_family_signed_in_at when a sign-in started (its refresh-token family's first token), so changing
--                                    where customers pay can require a fresh sign-in.
--   private.org_owner_emails         the business's owners, told by email when the UPI ID changes.
--   set_prospector_autonomy(…, why)  turning on "send without asking" for the Prospector records who and why in
--                                    the audit log, like every other grant of autonomy (the plan's limits are
--                                    checked by the API before this is called).
-- =============================================================================

ALTER TABLE invoices
  ADD COLUMN upi_id text CHECK (upi_id IS NULL OR upi_id ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9.-]{1,63}$');

-- Invoices already issued keep the UPI ID that is set today.
UPDATE invoices i SET upi_id = s.upi_id
  FROM venture_payment_settings s
 WHERE s.venture_id = i.venture_id AND i.status IN ('open', 'paid') AND s.upi_id IS NOT NULL;

-- An invoice takes the business's UPI ID when it is issued (created open, or a draft becoming open).
CREATE FUNCTION private.stamp_invoice_upi() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('open', 'paid') AND NEW.upi_id IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    NEW.upi_id := (SELECT upi_id FROM venture_payment_settings WHERE venture_id = NEW.venture_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.stamp_invoice_upi() FROM PUBLIC;
CREATE TRIGGER invoices_stamp_upi BEFORE INSERT OR UPDATE OF status ON invoices
  FOR EACH ROW EXECUTE FUNCTION private.stamp_invoice_upi();

-- The public payment page: the invoice's own UPI ID; the business's current one only for an invoice issued
-- before any UPI ID was set.
CREATE OR REPLACE FUNCTION private.public_invoice(p_token text)
RETURNS TABLE (invoice_id uuid, venture_id uuid, org_id uuid, business text, number text, customer_name text,
               balance_paise bigint, amount_paise bigint, due_on date, status text, upi_id text, payee_name text,
               razorpay boolean, customer_says_paid_at timestamptz, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.venture_id, i.org_id, v.name, i.number, i.customer_name, i.amount_paise - i.paid_paise,
         i.amount_paise, i.due_on, i.status, coalesce(i.upi_id, s.upi_id), coalesce(nullif(s.payee_name, ''), v.name),
         EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = i.venture_id AND c.provider = 'razorpay'
                                              AND c.status = 'active'),
         i.customer_says_paid_at, private.provision_service_account(i.org_id, i.venture_id)
    FROM invoices i
    JOIN ventures v ON v.id = i.venture_id AND v.removed_at IS NULL
    LEFT JOIN venture_payment_settings s ON s.venture_id = i.venture_id
   WHERE p_token ~ '^[0-9a-f]{32}$' AND i.pay_token = p_token
$$;

-- When the caller's own sign-in (refresh-token family) began.
CREATE FUNCTION private.auth_family_signed_in_at(p_family uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT min(created_at) FROM refresh_tokens
   WHERE family_id = p_family AND user_id = private.current_user_id() AND revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION private.auth_family_signed_in_at(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.auth_family_signed_in_at(uuid) TO kritvia_app;

-- The owners of a business the caller can see (for "your UPI ID was changed" emails).
CREATE FUNCTION private.org_owner_emails(p_venture uuid) RETURNS TABLE (email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.email
    FROM ventures v JOIN memberships m ON m.org_id = v.org_id AND m.role = 'org_owner' AND m.venture_id IS NULL
    JOIN users u ON u.id = m.user_id
   WHERE v.id = p_venture AND p_venture = ANY ((SELECT private.readable_ventures())::uuid[])
     AND u.is_active AND NOT u.is_service
   LIMIT 20
$$;
REVOKE ALL ON FUNCTION private.org_owner_emails(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.org_owner_emails(uuid) TO kritvia_app;

-- The Prospector's "send without asking", with a reason in the audit log.
DROP FUNCTION public.set_prospector_autonomy(uuid, boolean);
CREATE FUNCTION public.set_prospector_autonomy(p_venture uuid, p_auto boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid; a text; changed boolean;
BEGIN
  IF NOT (p_venture = ANY (private.readable_ventures())) OR NOT private.can_admin_venture(p_venture)
     OR private.is_service_user() THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_auto AND char_length(coalesce(trim(p_reason), '')) < 3 THEN
    RAISE EXCEPTION 'say why the Prospector may send without asking' USING ERRCODE = '22023';
  END IF;
  SELECT org_id INTO v_org FROM ventures WHERE id = p_venture;
  FOREACH a IN ARRAY ARRAY['gmail.send', 'whatsapp.send'] LOOP
    INSERT INTO agent_trust (org_id, venture_id, agent, action, auto_run, promoted_by, promoted_at)
    VALUES (v_org, p_venture, 'prospector', a, p_auto,
            CASE WHEN p_auto THEN private.current_user_id() END, CASE WHEN p_auto THEN now() END)
    ON CONFLICT (venture_id, agent, action) DO UPDATE SET auto_run = EXCLUDED.auto_run,
      promoted_by = coalesce(EXCLUDED.promoted_by, agent_trust.promoted_by),
      promoted_at = coalesce(EXCLUDED.promoted_at, agent_trust.promoted_at), updated_at = now()
    WHERE agent_trust.auto_run IS DISTINCT FROM EXCLUDED.auto_run
    RETURNING true INTO changed;
    IF changed THEN
      PERFORM public.audit_event(v_org, p_venture,
        CASE WHEN p_auto THEN 'autonomy.promoted' ELSE 'autonomy.demoted' END,
        'agent_trust', 'prospector/' || a, jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)));
    END IF;
    changed := false;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.set_prospector_autonomy(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_prospector_autonomy(uuid, boolean, text) TO kritvia_app;
