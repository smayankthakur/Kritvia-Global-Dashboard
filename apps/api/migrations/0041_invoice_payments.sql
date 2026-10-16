-- =============================================================================
-- 0041 Getting paid: a payment page for every invoice.
--
--   invoices.pay_token      the unguessable part of the invoice's public payment page (/pay/<token>)
--   venture_payment_settings  the business's UPI ID (always offered on the page, as a QR and an app link)
--   connectors 'razorpay'   the business's OWN Razorpay account (key id; key secret and webhook secret
--                           encrypted in connector_tokens). With it the page also offers card, netbanking
--                           and UPI through a Razorpay payment link, and Razorpay's webhook marks the
--                           invoice paid by itself.
--   invoice_payments        every payment recorded against an invoice (by hand, by Razorpay); Razorpay's
--                           payment id is unique, so a webhook delivered twice is counted once.
--
-- A direct UPI payment can't be seen by Kritvia: the customer can say "I've paid" (with the UPI
-- reference) on the page, which tells the team, and a person confirms it.
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in', 'telegram', 'slack', 'razorpay'));

ALTER TABLE invoices
  ADD COLUMN pay_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '')
             CHECK (pay_token ~ '^[0-9a-f]{32}$'),
  ADD COLUMN pay_link_id text CHECK (char_length(pay_link_id) <= 60),
  ADD COLUMN pay_link_url text CHECK (pay_link_url IS NULL OR pay_link_url ~ '^https://'),
  ADD COLUMN pay_link_paise bigint,
  ADD COLUMN customer_says_paid_at timestamptz,
  ADD COLUMN customer_paid_ref text CHECK (char_length(customer_paid_ref) <= 60);
CREATE UNIQUE INDEX invoices_pay_token_uq ON invoices (pay_token);
CREATE UNIQUE INDEX invoices_pay_link_uq ON invoices (pay_link_id) WHERE pay_link_id IS NOT NULL;

CREATE TABLE venture_payment_settings (
  venture_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  upi_id       text CHECK (upi_id IS NULL OR upi_id ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
  payee_name   text CHECK (char_length(payee_name) <= 100),
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('venture_payment_settings');
GRANT SELECT, INSERT, UPDATE, DELETE ON venture_payment_settings TO kritvia_app;

CREATE TABLE invoice_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  paid_on       date NOT NULL,
  method        text NOT NULL CHECK (method IN ('manual', 'upi', 'razorpay')),
  reference     text CHECK (char_length(reference) <= 80),
  recorded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (invoice_id);
CREATE UNIQUE INDEX invoice_payments_razorpay_uq ON invoice_payments (venture_id, reference) WHERE method = 'razorpay';
SELECT private.protect_tenant_table('invoice_payments');
DROP POLICY tenant_update ON invoice_payments;
GRANT SELECT, INSERT, DELETE ON invoice_payments TO kritvia_app;

-- The public payment page: what the customer needs to pay, nothing more. Anyone with the link can
-- read it, as with a payment link sent by any business.
CREATE FUNCTION private.public_invoice(p_token text)
RETURNS TABLE (invoice_id uuid, venture_id uuid, org_id uuid, business text, number text, customer_name text,
               balance_paise bigint, amount_paise bigint, due_on date, status text, upi_id text, payee_name text,
               razorpay boolean, customer_says_paid_at timestamptz, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.venture_id, i.org_id, v.name, i.number, i.customer_name, i.amount_paise - i.paid_paise,
         i.amount_paise, i.due_on, i.status, s.upi_id, coalesce(nullif(s.payee_name, ''), v.name),
         EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = i.venture_id AND c.provider = 'razorpay'
                                              AND c.status = 'active'),
         i.customer_says_paid_at, private.provision_service_account(i.org_id, i.venture_id)
    FROM invoices i
    JOIN ventures v ON v.id = i.venture_id AND v.removed_at IS NULL
    LEFT JOIN venture_payment_settings s ON s.venture_id = i.venture_id
   WHERE p_token ~ '^[0-9a-f]{32}$' AND i.pay_token = p_token
$$;
GRANT EXECUTE ON FUNCTION private.public_invoice(text) TO kritvia_app;

-- Razorpay's webhook for one business's account.
CREATE FUNCTION private.razorpay_principal(p_connector uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.id = p_connector AND c.provider = 'razorpay' AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.razorpay_principal(uuid) TO kritvia_app;
