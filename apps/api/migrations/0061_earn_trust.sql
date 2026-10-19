-- =============================================================================
-- 0061 Earn trust: invoices drafted by themselves.
--
--   invoices.status 'draft'    drafted by Kritvia, not yet issued: not owed, not reminded, not payable, not
--                              counted, until a person checks it and presses Issue
--   invoices.source 'booking'  drafted when a booking with a priced service is marked done
--   invoices.source 'proposal' drafted when a lead is marked won (or a proposal accepted): from the
--                              proposal that was sent
--   invoices.booking_id / proposal_id   one draft per booking and per proposal
-- =============================================================================
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'open', 'paid', 'cancelled'));
ALTER TABLE invoices DROP CONSTRAINT invoices_source_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_source_check
  CHECK (source IN ('manual', 'file', 'tally', 'booking', 'proposal'));
ALTER TABLE invoices
  ADD COLUMN booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  ADD COLUMN proposal_id uuid REFERENCES proposals(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX invoices_booking_uq ON invoices (booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX invoices_proposal_uq ON invoices (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX invoices_draft_idx ON invoices (venture_id) WHERE status = 'draft';

-- A customer's phone as the invoices table keeps it (digits with country code), or NULL.
CREATE FUNCTION private.invoice_phone(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN d ~ '^[0-9]{10}$' THEN '91' || d
              WHEN d ~ '^[0-9]{8,15}$' THEN d END
    FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) x
$$;

CREATE FUNCTION private.draft_invoice_for_proposal(p_proposal uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p proposals; l leads; v_id uuid;
BEGIN
  SELECT * INTO p FROM proposals WHERE id = p_proposal;
  IF NOT FOUND OR p.total_inr IS NULL OR p.total_inr <= 0
     OR EXISTS (SELECT 1 FROM invoices WHERE proposal_id = p.id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO l FROM leads WHERE id = p.lead_id AND venture_id = p.venture_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO invoices (org_id, venture_id, customer_name, customer_email, customer_phone, amount_paise, due_on,
                        status, source, proposal_id, lead_id, notes)
  VALUES (p.org_id, p.venture_id,
          left(coalesce(nullif(btrim(l.company), ''), nullif(btrim(l.name), ''), 'Customer'), 160),
          CASE WHEN l.email LIKE '%@%' AND char_length(l.email) <= 254 THEN l.email END,
          private.invoice_phone(l.phone),
          round(p.total_inr * 100)::bigint,
          (now() AT TIME ZONE 'Asia/Kolkata')::date + 7,
          'draft', 'proposal', p.id, l.id,
          'Drafted by Kritvia from the proposal of ' || to_char(p.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY')
            || '. Check the amount and details, then issue it.')
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- A lead marked won: its last sent proposal is accepted, and its invoice is drafted.
CREATE FUNCTION private.on_lead_won() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pid uuid;
BEGIN
  SELECT id INTO pid FROM proposals
   WHERE lead_id = NEW.id AND venture_id = NEW.venture_id AND status IN ('sent', 'accepted')
   ORDER BY created_at DESC LIMIT 1;
  IF pid IS NOT NULL THEN
    UPDATE proposals SET status = 'accepted' WHERE id = pid AND status = 'sent';
    PERFORM private.draft_invoice_for_proposal(pid);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER leads_won_invoice AFTER UPDATE OF status ON leads FOR EACH ROW
  WHEN (NEW.status = 'won' AND OLD.status IS DISTINCT FROM 'won') EXECUTE FUNCTION private.on_lead_won();

CREATE FUNCTION private.on_proposal_accepted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM private.draft_invoice_for_proposal(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER proposals_accepted_invoice AFTER UPDATE OF status ON proposals FOR EACH ROW
  WHEN (NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted')
  EXECUTE FUNCTION private.on_proposal_accepted();

-- A booking marked done, for a service with a price: its invoice is drafted.
CREATE FUNCTION private.on_booking_done() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE price bigint;
BEGIN
  SELECT price_paise INTO price FROM booking_services WHERE id = NEW.service_id AND venture_id = NEW.venture_id;
  IF price IS NULL OR price <= 0 OR EXISTS (SELECT 1 FROM invoices WHERE booking_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO invoices (org_id, venture_id, customer_name, customer_email, customer_phone, amount_paise, due_on,
                        status, source, booking_id, notes)
  VALUES (NEW.org_id, NEW.venture_id, left(NEW.customer_name, 160),
          CASE WHEN NEW.channel = 'email' AND NEW.address LIKE '%@%' THEN NEW.address END,
          CASE WHEN NEW.channel = 'whatsapp' THEN private.invoice_phone(NEW.address) END,
          price, (now() AT TIME ZONE 'Asia/Kolkata')::date + 7, 'draft', 'booking', NEW.id,
          left('Drafted by Kritvia for ' || NEW.service_name || ' on '
               || to_char(NEW.starts_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY') || '.', 1000));
  RETURN NULL;
END $$;
CREATE TRIGGER bookings_done_invoice AFTER UPDATE OF status ON bookings FOR EACH ROW
  WHEN (NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done') EXECUTE FUNCTION private.on_booking_done();

-- A draft has no payment page.
CREATE OR REPLACE FUNCTION private.public_invoice_document(p_token text)
RETURNS TABLE (invoice_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.venture_id, private.provision_service_account(i.org_id, i.venture_id)
    FROM invoices i JOIN ventures v ON v.id = i.venture_id AND v.removed_at IS NULL
   WHERE p_token ~ '^[0-9a-f]{32}$' AND i.pay_token = p_token AND i.status NOT IN ('cancelled', 'draft')
$$;
