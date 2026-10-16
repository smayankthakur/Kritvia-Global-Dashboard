-- =============================================================================
-- 0044 Bookings from chat.
--
--   booking_settings   when the business takes bookings: opening hours per weekday, slot step, notice,
--                      how far ahead, how many at once, and whether to check and fill Google Calendar.
--   booking_services   what can be booked, with its length (and price, shown to customers).
--   bookings           who, what, when, and how they asked (WhatsApp, Telegram, email or by hand).
--
-- The Inbox assistant offers free times from these when a customer asks to book; when the customer
-- picks one, the reply that confirms it carries the booking, which is made when the reply is approved
-- (and checked again then, so two chats can't take the same last slot). The Booking reminders agent
-- writes a reminder the day before, for a person's yes.
-- =============================================================================
CREATE TABLE booking_settings (
  venture_id        uuid PRIMARY KEY,
  org_id            uuid NOT NULL,
  enabled           boolean NOT NULL DEFAULT true,
  -- {"mon": [["10:00","13:00"],["14:00","19:00"]], "tue": [...], ...}; a missing day is closed
  hours             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(hours) = 'object'),
  slot_minutes      int NOT NULL DEFAULT 30 CHECK (slot_minutes IN (10, 15, 20, 30, 45, 60, 90, 120)),
  notice_hours      int NOT NULL DEFAULT 2 CHECK (notice_hours BETWEEN 0 AND 168),
  days_ahead        int NOT NULL DEFAULT 14 CHECK (days_ahead BETWEEN 1 AND 90),
  capacity          int NOT NULL DEFAULT 1 CHECK (capacity BETWEEN 1 AND 50),
  use_calendar      boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('booking_settings');
GRANT SELECT, INSERT, UPDATE, DELETE ON booking_settings TO kritvia_app;

CREATE TABLE booking_services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  minutes       int NOT NULL CHECK (minutes BETWEEN 5 AND 600),
  price_paise   bigint CHECK (price_paise >= 0),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX booking_services_name_uq ON booking_services (venture_id, lower(name)) WHERE active;
SELECT private.protect_tenant_table('booking_services');
GRANT SELECT, INSERT, UPDATE, DELETE ON booking_services TO kritvia_app;

CREATE TABLE bookings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  venture_id         uuid NOT NULL,
  service_id         uuid REFERENCES booking_services(id) ON DELETE SET NULL,
  service_name       text NOT NULL CHECK (char_length(service_name) BETWEEN 1 AND 80),
  customer_name      text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 160),
  channel            text NOT NULL CHECK (channel IN ('whatsapp', 'telegram', 'email', 'manual')),
  address            text CHECK (char_length(address) <= 254),     -- phone / chat id / email to remind
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'done', 'no_show')),
  notes              text CHECK (char_length(notes) <= 500),
  run_id             uuid,                                     -- the chat reply that made it
  calendar_event_id  text CHECK (char_length(calendar_event_id) <= 200),
  reminded_at        timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX bookings_time_idx ON bookings (venture_id, starts_at) WHERE status = 'confirmed';
CREATE UNIQUE INDEX bookings_run_uq ON bookings (run_id) WHERE run_id IS NOT NULL;
SELECT private.protect_tenant_table('bookings');
GRANT SELECT, INSERT, UPDATE, DELETE ON bookings TO kritvia_app;

CREATE OR REPLACE FUNCTION private.default_role(p_workflow text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_workflow
    WHEN 'inbox_assistant' THEN 'front_desk'
    WHEN 'booking_reminders' THEN 'front_desk'
    WHEN 'lead_triage' THEN 'sales'
    WHEN 'prospector' THEN 'sales'
    WHEN 'whatsapp_followup' THEN 'sales'
    WHEN 'loan_verification' THEN 'accounts'
    WHEN 'collections' THEN 'accounts'
    ELSE 'ops' END
$$;
