-- =============================================================================
-- 0037 Invoices and payment reminders.
--
-- A simple list of what customers owe the business: added by hand, read from a photo or PDF of the
-- invoice (OCR on the server, then the fields are checked by a person before saving), or created
-- from the customers Tally shows as owing money.
--
-- The "Payment reminders" agent (workflow collections) writes polite reminders before and after
-- the due date, by email (Gmail) or by an approved WhatsApp template to customers who chat with
-- the business. Each reminder waits for a person's yes. Recording a payment stops the reminders,
-- and a person can pause them for one invoice (e.g. a promise to pay).
--
-- Amounts are whole paise (bigint): money is never a float.
-- =============================================================================
CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  venture_id        uuid NOT NULL,
  number            text NOT NULL DEFAULT '' CHECK (char_length(number) <= 60),
  customer_name     text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 160),
  customer_email    text CHECK (customer_email IS NULL OR (char_length(customer_email) <= 254 AND customer_email LIKE '%@%')),
  customer_phone    text CHECK (customer_phone IS NULL OR customer_phone ~ '^[0-9]{8,15}$'),   -- digits with country code
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise < 10000000000000),
  paid_paise        bigint NOT NULL DEFAULT 0 CHECK (paid_paise >= 0),
  issued_on         date,
  due_on            date NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  paid_on           date,
  notes             text CHECK (char_length(notes) <= 1000),
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'file', 'tally')),
  lead_id           uuid REFERENCES leads(id) ON DELETE SET NULL,
  reminders_paused  boolean NOT NULL DEFAULT false,
  reminders_sent    int NOT NULL DEFAULT 0 CHECK (reminders_sent BETWEEN 0 AND 50),
  last_reminder_at  timestamptz,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (paid_paise <= amount_paise),
  CHECK (status <> 'paid' OR paid_on IS NOT NULL),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices (venture_id, lower(number)) WHERE number <> '';
CREATE INDEX invoices_open_idx ON invoices (venture_id, due_on) WHERE status = 'open';
SELECT private.protect_tenant_table('invoices');
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO kritvia_app;

-- The Payment reminders agent sits with Accounts on the org chart.
CREATE OR REPLACE FUNCTION private.default_role(p_workflow text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_workflow
    WHEN 'inbox_assistant' THEN 'front_desk'
    WHEN 'lead_triage' THEN 'sales'
    WHEN 'prospector' THEN 'sales'
    WHEN 'whatsapp_followup' THEN 'sales'
    WHEN 'loan_verification' THEN 'accounts'
    WHEN 'collections' THEN 'accounts'
    ELSE 'ops' END
$$;
