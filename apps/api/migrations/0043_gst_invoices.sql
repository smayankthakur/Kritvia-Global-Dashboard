-- =============================================================================
-- 0043 GST invoices made in Kritvia.
--
--   gst_profiles      the business's details printed on every tax invoice: legal name, GSTIN (and so
--                     its state), address, and the prefix of its invoice numbers.
--   invoice_series    one gapless counter per business and financial year (April to March), so tax
--                     invoice numbers run PREFIX/26-27/0001, 0002, ... (at most 16 characters).
--   invoices          kind 'gst' adds the customer's GSTIN, address and place of supply, reverse charge,
--                     and the taxable value with its CGST + SGST (same state) or IGST (other state).
--   invoice_items     the lines: description, HSN/SAC, quantity, unit, rate, discount, GST rate.
--
-- Money is whole paise; every line's tax is rounded to the paisa and the invoice totals are their sums.
-- A tax invoice can't be re-priced once issued (a credit note is the way); its contacts, due date and
-- notes can still change, and it can be cancelled.
-- =============================================================================
CREATE TABLE gst_profiles (
  venture_id   uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  legal_name   text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 160),
  trade_name   text CHECK (char_length(trade_name) <= 160),
  gstin        text NOT NULL CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code   text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),
  address      text NOT NULL CHECK (char_length(address) BETWEEN 5 AND 400),
  email        text CHECK (char_length(email) <= 254),
  phone        text CHECK (char_length(phone) <= 24),
  prefix       text NOT NULL DEFAULT 'INV' CHECK (prefix ~ '^[A-Z0-9]{1,5}$'),
  terms        text CHECK (char_length(terms) <= 600),     -- printed at the foot (bank details, terms)
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (substr(gstin, 1, 2) = state_code),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('gst_profiles');
GRANT SELECT, INSERT, UPDATE, DELETE ON gst_profiles TO kritvia_app;

CREATE TABLE invoice_series (
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  fy          text NOT NULL CHECK (fy ~ '^[0-9]{2}-[0-9]{2}$'),
  last_no     int NOT NULL CHECK (last_no BETWEEN 1 AND 9999),
  PRIMARY KEY (venture_id, fy),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('invoice_series');
GRANT SELECT, INSERT, UPDATE ON invoice_series TO kritvia_app;

ALTER TABLE invoices
  ADD COLUMN kind              text NOT NULL DEFAULT 'simple' CHECK (kind IN ('simple', 'gst')),
  ADD COLUMN customer_gstin    text CHECK (customer_gstin IS NULL OR customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ADD COLUMN customer_address  text CHECK (char_length(customer_address) <= 400),
  ADD COLUMN place_of_supply   text CHECK (place_of_supply IS NULL OR place_of_supply ~ '^[0-9]{2}$'),
  ADD COLUMN reverse_charge    boolean NOT NULL DEFAULT false,
  ADD COLUMN taxable_paise     bigint CHECK (taxable_paise >= 0),
  ADD COLUMN cgst_paise        bigint NOT NULL DEFAULT 0 CHECK (cgst_paise >= 0),
  ADD COLUMN sgst_paise        bigint NOT NULL DEFAULT 0 CHECK (sgst_paise >= 0),
  ADD COLUMN igst_paise        bigint NOT NULL DEFAULT 0 CHECK (igst_paise >= 0),
  ADD COLUMN supplier          jsonb,      -- the GST profile as printed on the day it was issued
  ADD CONSTRAINT invoices_gst_fields CHECK (kind <> 'gst' OR (place_of_supply IS NOT NULL AND taxable_paise IS NOT NULL
                                                               AND supplier IS NOT NULL AND number <> '' AND issued_on IS NOT NULL));

CREATE TABLE invoice_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  venture_id      uuid NOT NULL,
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position        int NOT NULL CHECK (position BETWEEN 1 AND 100),
  description     text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  hsn_sac         text CHECK (hsn_sac IS NULL OR hsn_sac ~ '^[0-9]{4,8}$'),
  qty             numeric(12, 3) NOT NULL CHECK (qty > 0),
  unit            text CHECK (char_length(unit) <= 12),
  rate_paise      bigint NOT NULL CHECK (rate_paise >= 0),
  discount_paise  bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  taxable_paise   bigint NOT NULL CHECK (taxable_paise >= 0),
  gst_rate        numeric(5, 2) NOT NULL CHECK (gst_rate IN (0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28, 40)),
  cgst_paise      bigint NOT NULL DEFAULT 0,
  sgst_paise      bigint NOT NULL DEFAULT 0,
  igst_paise      bigint NOT NULL DEFAULT 0,
  UNIQUE (invoice_id, position),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('invoice_items');
DROP POLICY tenant_update ON invoice_items;
GRANT SELECT, INSERT, DELETE ON invoice_items TO kritvia_app;

-- The invoice as printed, for the customer's payment page (same token as /pay/<token>).
CREATE FUNCTION private.public_invoice_document(p_token text)
RETURNS TABLE (invoice_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.venture_id, private.provision_service_account(i.org_id, i.venture_id)
    FROM invoices i JOIN ventures v ON v.id = i.venture_id AND v.removed_at IS NULL
   WHERE p_token ~ '^[0-9a-f]{32}$' AND i.pay_token = p_token AND i.status <> 'cancelled'
$$;
GRANT EXECUTE ON FUNCTION private.public_invoice_document(text) TO kritvia_app;
