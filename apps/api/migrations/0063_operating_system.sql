-- =============================================================================
-- 0063 The operating system: one stream of business events every agent can react to, routines the
-- assistant sets up (after a yes), hiring, and attendance.
--
--   business_events    what just happened in a business: a lead came in or was won, an invoice was issued or
--                      paid, money arrived, a booking was made or done, a bill or a review came in, a customer
--                      opted out, a candidate applied, a campaign went out. Written by database triggers (so
--                      nothing can change without its event), read by the worker every minute: skills that
--                      start "right after" an event run, and "tell me when" alerts are sent. Only a short,
--                      non-sensitive summary is kept; the record itself stays where it is.
--   event_alerts       "Tell me when an invoice over ₹50,000 is paid": the owners and admins are told.
--   skills.on_event    a skill can now start right after an event (trigger 'on_event').
--   jobs / candidates  open roles, and the people who applied (CVs uploaded or emailed in with the job's code).
--                      Each CV is read and scored against the role by Kritvia; the interview invite to a
--                      shortlisted person goes out after a yes. CV text is encrypted and deleted 180 days after
--                      the role closes.
--   staff / attendance the team, and who came in when: staff send IN / OUT to the business's WhatsApp number
--                      (or a person marks it). A monthly sheet adds it up for salaries.
-- =============================================================================

-- --------------------------------------------------------------------------------------- events --
CREATE TABLE business_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  kind           text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$'),
  subject_table  text NOT NULL CHECK (char_length(subject_table) <= 40),
  subject_id     uuid,
  summary        text NOT NULL CHECK (char_length(summary) <= 300),
  amount_paise   bigint,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX business_events_venture_idx ON business_events (venture_id, occurred_at DESC);
CREATE INDEX business_events_todo_idx ON business_events (id) WHERE dispatched_at IS NULL;
ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_events FORCE ROW LEVEL SECURITY;
CREATE POLICY business_events_select ON business_events FOR SELECT
  USING (venture_id = ANY ((SELECT private.readable_ventures())::uuid[]));
INSERT INTO private.tenant_tables VALUES ('business_events') ON CONFLICT DO NOTHING;
GRANT SELECT ON business_events TO kritvia_app;

-- The only way in: from the triggers below (and Kritvia's own code through them).
CREATE FUNCTION private.emit_event(p_org uuid, p_venture uuid, p_kind text, p_table text, p_id uuid,
                                   p_summary text, p_amount bigint DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO business_events (org_id, venture_id, kind, subject_table, subject_id, summary, amount_paise)
  VALUES (p_org, p_venture, p_kind, p_table, p_id, left(coalesce(nullif(btrim(p_summary), ''), p_kind), 300), p_amount)
$$;

-- The worker takes events nobody has acted on yet (oldest first), so each is acted on once.
CREATE FUNCTION private.claim_events(p_limit int)
RETURNS TABLE (id bigint, org_id uuid, venture_id uuid, kind text, subject_table text, subject_id uuid,
               summary text, amount_paise bigint, occurred_at timestamptz, run_as uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH todo AS (
    SELECT e.id FROM business_events e WHERE e.dispatched_at IS NULL ORDER BY e.id
     LIMIT greatest(1, least(p_limit, 2000)) FOR UPDATE SKIP LOCKED
  )
  UPDATE business_events e SET dispatched_at = now() FROM todo WHERE e.id = todo.id
  RETURNING e.id, e.org_id, e.venture_id, e.kind, e.subject_table, e.subject_id, e.summary, e.amount_paise,
            e.occurred_at, private.provision_service_account(e.org_id, e.venture_id)
$$;
GRANT EXECUTE ON FUNCTION private.claim_events(int) TO kritvia_app;

CREATE FUNCTION private.rupees(p bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '₹' || to_char(p / 100.0, 'FM99,99,99,99,990.##')
$$;

CREATE FUNCTION private.events_leads() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'lead.new', 'leads', NEW.id,
                               'New lead: ' || coalesce(nullif(NEW.company, ''), NEW.name) || ' (' || NEW.source || ')');
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('qualified', 'won', 'lost') THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'lead.' || NEW.status, 'leads', NEW.id,
                               'Lead ' || NEW.status || ': ' || coalesce(nullif(NEW.company, ''), NEW.name));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER leads_events AFTER INSERT OR UPDATE OF status ON leads FOR EACH ROW EXECUTE FUNCTION private.events_leads();

CREATE FUNCTION private.events_invoices() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE who text := NEW.customer_name || coalesce(' (' || nullif(NEW.number, '') || ')', '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'draft' THEN
      PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'invoice.drafted', 'invoices', NEW.id,
                                 'Invoice drafted for ' || who || ', ' || private.rupees(NEW.amount_paise), NEW.amount_paise);
    ELSIF NEW.status = 'open' THEN
      PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'invoice.issued', 'invoices', NEW.id,
                                 'Invoice issued to ' || who || ', ' || private.rupees(NEW.amount_paise), NEW.amount_paise);
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'open' AND OLD.status = 'draft' THEN
      PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'invoice.issued', 'invoices', NEW.id,
                                 'Invoice issued to ' || who || ', ' || private.rupees(NEW.amount_paise), NEW.amount_paise);
    ELSIF NEW.status = 'paid' THEN
      PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'invoice.paid', 'invoices', NEW.id,
                                 'Invoice paid by ' || who || ', ' || private.rupees(NEW.amount_paise), NEW.amount_paise);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER invoices_events AFTER INSERT OR UPDATE OF status ON invoices FOR EACH ROW
  EXECUTE FUNCTION private.events_invoices();

CREATE FUNCTION private.events_payments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'payment.received', 'invoices', NEW.invoice_id,
                             private.rupees(NEW.amount_paise) || ' received from '
                             || coalesce((SELECT customer_name FROM invoices WHERE id = NEW.invoice_id), 'a customer')
                             || ' (' || NEW.method || ')', NEW.amount_paise);
  RETURN NULL;
END $$;
CREATE TRIGGER invoice_payments_events AFTER INSERT ON invoice_payments FOR EACH ROW
  EXECUTE FUNCTION private.events_payments();

CREATE FUNCTION private.events_bookings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'booking.new', 'bookings', NEW.id,
                               'Booking: ' || NEW.customer_name || ', ' || NEW.service_name || ' on '
                               || to_char(NEW.starts_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'));
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('done', 'cancelled', 'no_show') THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'booking.' || NEW.status, 'bookings', NEW.id,
                               'Booking ' || replace(NEW.status, '_', ' ') || ': ' || NEW.customer_name || ', '
                               || NEW.service_name);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER bookings_events AFTER INSERT OR UPDATE OF status ON bookings FOR EACH ROW
  EXECUTE FUNCTION private.events_bookings();

CREATE FUNCTION private.events_bills() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'bill.new', 'bills', NEW.id,
                               'Bill from ' || NEW.vendor || ', ' || private.rupees(NEW.amount_paise) || ', due '
                               || to_char(NEW.due_on, 'DD Mon'), NEW.amount_paise);
  ELSIF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'bill.paid', 'bills', NEW.id,
                               'Bill paid: ' || NEW.vendor || ', ' || private.rupees(NEW.amount_paise), NEW.amount_paise);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER bills_events AFTER INSERT OR UPDATE OF status ON bills FOR EACH ROW EXECUTE FUNCTION private.events_bills();

CREATE FUNCTION private.events_reviews() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'review.new', 'review_replies', NEW.id,
                             'New ' || NEW.rating || '-star Google review');
  RETURN NULL;
END $$;
CREATE TRIGGER review_replies_events AFTER INSERT ON review_replies FOR EACH ROW
  EXECUTE FUNCTION private.events_reviews();

CREATE FUNCTION private.events_optout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'customer.opted_out', 'wa_contacts', NEW.id,
                             coalesce(NEW.name, 'A customer') || ' asked not to get messages');
  RETURN NULL;
END $$;
CREATE TRIGGER wa_contacts_optout_events AFTER UPDATE OF opted_out_at ON wa_contacts FOR EACH ROW
  WHEN (NEW.opted_out_at IS NOT NULL AND OLD.opted_out_at IS NULL) EXECUTE FUNCTION private.events_optout();

CREATE FUNCTION private.events_campaigns() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'campaign.sent', 'campaigns', NEW.id,
                             'Campaign ''' || NEW.name || ''' sent to ' || NEW.sent || ' people');
  RETURN NULL;
END $$;
CREATE TRIGGER campaigns_events AFTER UPDATE OF status ON campaigns FOR EACH ROW
  WHEN (NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent') EXECUTE FUNCTION private.events_campaigns();

CREATE TABLE event_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  kind          text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$'),
  min_paise     bigint CHECK (min_paise IS NULL OR min_paise > 0),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz,
  UNIQUE (venture_id, kind, min_paise),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('event_alerts');
GRANT SELECT, INSERT, UPDATE, DELETE ON event_alerts TO kritvia_app;

ALTER TABLE skills DROP CONSTRAINT skills_trigger_check;
ALTER TABLE skills ADD CONSTRAINT skills_trigger_check CHECK (trigger IN ('manual', 'schedule', 'event', 'on_event'));
ALTER TABLE skills ADD COLUMN on_event text CHECK (on_event IS NULL OR on_event ~ '^[a-z_]+\.[a-z_]+$');
ALTER TABLE skills ADD CONSTRAINT skills_on_event_required CHECK (trigger <> 'on_event' OR on_event IS NOT NULL);

-- --------------------------------------------------------------------------------------- hiring --
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  code          text NOT NULL CHECK (code ~ '^JOB-[0-9A-Z]{4}$'),
  title         text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  location      text CHECK (char_length(location) <= 120),
  description   text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  must_have     text NOT NULL DEFAULT '' CHECK (char_length(must_have) <= 2000),
  nice_to_have  text NOT NULL DEFAULT '' CHECK (char_length(nice_to_have) <= 2000),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at     timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, code),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('jobs');
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO kritvia_app;

CREATE TABLE candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  job_id        uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  email         text CHECK (char_length(email) <= 254),
  phone         text CHECK (char_length(phone) <= 24),
  source        text NOT NULL CHECK (source IN ('upload', 'email')),
  cv_enc        bytea,
  file_name     text CHECK (char_length(file_name) <= 200),
  score         int CHECK (score BETWEEN 0 AND 100),
  verdict       text CHECK (verdict IN ('shortlist', 'maybe', 'reject')),
  reasons       text CHECK (char_length(reasons) <= 2000),
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'screened', 'shortlisted', 'invited', 'rejected', 'hired')),
  run_id        uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX candidates_email_uq ON candidates (job_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX candidates_job_idx ON candidates (job_id, score DESC NULLS LAST);
SELECT private.protect_tenant_table('candidates');
GRANT SELECT, INSERT, UPDATE, DELETE ON candidates TO kritvia_app;

CREATE FUNCTION private.events_candidates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE role text := (SELECT title FROM jobs WHERE id = NEW.job_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'candidate.new', 'candidates', NEW.id,
                               'New application for ' || coalesce(role, 'a role') || ': ' || NEW.name);
  ELSIF NEW.status = 'shortlisted' AND OLD.status IS DISTINCT FROM 'shortlisted' THEN
    PERFORM private.emit_event(NEW.org_id, NEW.venture_id, 'candidate.shortlisted', 'candidates', NEW.id,
                               NEW.name || ' shortlisted for ' || coalesce(role, 'a role')
                               || coalesce(' (score ' || NEW.score || ')', ''));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER candidates_events AFTER INSERT OR UPDATE OF status ON candidates FOR EACH ROW
  EXECUTE FUNCTION private.events_candidates();

-- CVs are personal data: kept 180 days after the role closes (the worker's purge calls this).
CREATE FUNCTION private.purge_old_candidates() RETURNS int
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM candidates c USING jobs j
     WHERE j.id = c.job_id AND j.status = 'closed' AND j.closed_at < now() - interval '180 days'
    RETURNING c.id
  ) SELECT count(*)::int FROM gone
$$;
GRANT EXECUTE ON FUNCTION private.purge_old_candidates() TO kritvia_app;

-- ----------------------------------------------------------------------------------- attendance --
CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  phone         text CHECK (phone IS NULL OR phone ~ '^[0-9]{8,15}$'),
  role          text CHECK (char_length(role) <= 80),
  pay_kind      text NOT NULL DEFAULT 'monthly' CHECK (pay_kind IN ('monthly', 'daily')),
  pay_paise     bigint NOT NULL DEFAULT 0 CHECK (pay_paise >= 0),
  starts_at     time NOT NULL DEFAULT '10:00',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX staff_phone_uq ON staff (venture_id, phone) WHERE phone IS NOT NULL;
SELECT private.protect_tenant_table('staff');
GRANT SELECT, INSERT, UPDATE, DELETE ON staff TO kritvia_app;

CREATE TABLE attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day         date NOT NULL,
  in_at       timestamptz,
  out_at      timestamptz,
  status      text NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'half_day', 'absent', 'leave')),
  source      text NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp', 'manual')),
  note        text CHECK (char_length(note) <= 200),
  UNIQUE (staff_id, day),
  CHECK (out_at IS NULL OR in_at IS NULL OR out_at >= in_at),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX attendance_day_idx ON attendance (venture_id, day);
SELECT private.protect_tenant_table('attendance');
GRANT SELECT, INSERT, UPDATE, DELETE ON attendance TO kritvia_app;

-- Who hasn't checked in an hour after their start time, today, per business (the worker tells the owners once).
CREATE FUNCTION private.attendance_missing(p_day date, p_now time)
RETURNS TABLE (venture_id uuid, org_id uuid, run_as uuid, names text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.venture_id, s.org_id, private.venture_owner(s.org_id), array_agg(s.name ORDER BY s.name)
    FROM staff s JOIN ventures v ON v.id = s.venture_id AND v.removed_at IS NULL
   WHERE s.active AND s.phone IS NOT NULL AND s.starts_at + interval '1 hour' <= p_now
     AND extract(isodow FROM p_day) <> 7
     AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.staff_id = s.id AND a.day = p_day)
   GROUP BY s.venture_id, s.org_id
$$;
GRANT EXECUTE ON FUNCTION private.attendance_missing(date, time) TO kritvia_app;

-- A staff member writing to the business's WhatsApp number (before their message is treated as a customer's).
CREATE FUNCTION private.staff_by_phone(p_venture uuid, p_phone text)
RETURNS TABLE (staff_id uuid, org_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, org_id, name FROM staff WHERE venture_id = p_venture AND phone = p_phone AND active
$$;
GRANT EXECUTE ON FUNCTION private.staff_by_phone(uuid, text) TO kritvia_app;

-- Runs started by an event (a skill reacting right after something happened).
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_trigger_kind_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind IN ('manual', 'email', 'webhook', 'schedule', 'upload', 'api', 'whatsapp', 'telegram',
                          'indiamart', 'event'));
