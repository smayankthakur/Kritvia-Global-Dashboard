-- =============================================================================
-- 0051 Trade: exporters, importers and C&F (customs clearing and forwarding) agents.
--
--   venture kind 'trade'   a business that ships goods across the border, or clears them for clients.
--   trade_profiles         the details printed on export invoices and packing lists: name, address,
--                          IEC, GSTIN, AD code, bank, LUT (ARN and validity), CHA licence, default
--                          currency, number prefixes, and how many months export proceeds have to be
--                          realised in (RBI rule; 9 by default, changeable as the rule changes).
--   trade_series           one counter per business, kind of file and financial year (EXP/26-27/0001).
--   shipments              one file per consignment: our own export or import, or a client's job for
--                          a C&F agent. Party, Incoterm, mode, ports, vessel or flight, container
--                          numbers, BL/AWB, shipping bill or bill of entry, cut-off, ETD/ETA, stage,
--                          value and currency, payment terms, LC, money received, realisation and
--                          BRC, duty, and a C&F agent's fee and reimbursable costs.
--   shipment_items         invoice lines: description, HS code, quantity, unit, price in the file's currency.
--   shipment_packages      packing list: marks, kind and number of packages, net and gross weight, size.
--   shipment_docs          the document checklist: each document's status, number, date and file
--                          (a file in business memory).
--   shipment_events        the file's timeline: stage changes, notes, updates sent.
--
-- Money is whole minor units of the file's currency (cents, paise); a C&F agent's fee, reimbursable
-- costs and import duty are paise.
-- =============================================================================
ALTER TABLE venture_settings DROP CONSTRAINT IF EXISTS venture_settings_kind_check;
ALTER TABLE venture_settings ADD CONSTRAINT venture_settings_kind_check
  CHECK (kind IN ('general', 'software', 'finance', 'kitchen', 'trade'));

CREATE TABLE trade_profiles (
  venture_id          uuid PRIMARY KEY,
  org_id              uuid NOT NULL,
  roles               text[] NOT NULL DEFAULT '{exporter}'
                      CHECK (roles <@ ARRAY['exporter', 'importer', 'cha']::text[] AND cardinality(roles) BETWEEN 1 AND 3),
  legal_name          text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 160),
  address             text NOT NULL CHECK (char_length(address) BETWEEN 5 AND 400),
  iec                 text CHECK (iec IS NULL OR iec ~ '^[0-9A-Z]{10}$'),
  gstin               text CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  ad_code             text CHECK (ad_code IS NULL OR ad_code ~ '^[0-9]{7,14}$'),
  bank_details        text CHECK (char_length(bank_details) <= 600),
  lut_arn             text CHECK (char_length(lut_arn) <= 30),
  lut_valid_until     date,
  cha_licence         text CHECK (char_length(cha_licence) <= 40),
  email               text CHECK (char_length(email) <= 254),
  phone               text CHECK (char_length(phone) <= 24),
  default_currency    text NOT NULL DEFAULT 'USD' CHECK (default_currency ~ '^[A-Z]{3}$'),
  realisation_months  int NOT NULL DEFAULT 9 CHECK (realisation_months BETWEEN 1 AND 36),
  prefix_export       text NOT NULL DEFAULT 'EXP' CHECK (prefix_export ~ '^[A-Z0-9]{1,5}$'),
  prefix_import       text NOT NULL DEFAULT 'IMP' CHECK (prefix_import ~ '^[A-Z0-9]{1,5}$'),
  prefix_job          text NOT NULL DEFAULT 'JOB' CHECK (prefix_job ~ '^[A-Z0-9]{1,5}$'),
  declaration         text CHECK (char_length(declaration) <= 600),   -- printed at the foot of export invoices
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('trade_profiles');
GRANT SELECT, INSERT, UPDATE, DELETE ON trade_profiles TO kritvia_app;

CREATE TABLE trade_series (
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('export', 'import', 'job')),
  fy          text NOT NULL CHECK (fy ~ '^[0-9]{2}-[0-9]{2}$'),
  last_no     int NOT NULL CHECK (last_no BETWEEN 1 AND 99999),
  PRIMARY KEY (venture_id, kind, fy),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('trade_series');
GRANT SELECT, INSERT, UPDATE ON trade_series TO kritvia_app;

CREATE TABLE shipments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  venture_id           uuid NOT NULL,
  number               text NOT NULL CHECK (char_length(number) BETWEEN 1 AND 30),
  direction            text NOT NULL CHECK (direction IN ('export', 'import')),
  for_client           boolean NOT NULL DEFAULT false,        -- a C&F agent's job for a client
  stage                text NOT NULL DEFAULT 'order'
                       CHECK (stage IN ('order', 'production', 'booking', 'documents', 'customs', 'cleared', 'duty_paid',
                                        'shipped', 'arrived', 'delivered', 'paid', 'closed', 'cancelled')),
  -- the buyer (export), the supplier (import), or the client (a C&F job)
  party_name           text NOT NULL CHECK (char_length(party_name) BETWEEN 1 AND 160),
  party_country        text CHECK (party_country IS NULL OR party_country ~ '^[A-Z]{2}$'),
  party_email          text CHECK (char_length(party_email) <= 254),
  party_phone          text CHECK (char_length(party_phone) <= 24),
  party_address        text CHECK (char_length(party_address) <= 400),
  other_party          text CHECK (char_length(other_party) <= 300),   -- consignee / notify party / a job's buyer or seller
  reference            text CHECK (char_length(reference) <= 80),      -- buyer's PO or the client's reference
  incoterm             text CHECK (incoterm IS NULL OR incoterm IN ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  incoterm_place       text CHECK (char_length(incoterm_place) <= 80),
  mode                 text NOT NULL DEFAULT 'sea' CHECK (mode IN ('sea', 'air', 'road', 'rail', 'courier')),
  port_loading         text CHECK (char_length(port_loading) <= 80),
  port_discharge       text CHECK (char_length(port_discharge) <= 80),
  final_destination    text CHECK (char_length(final_destination) <= 80),
  carrier              text CHECK (char_length(carrier) <= 80),       -- shipping line, airline, forwarder
  vessel               text CHECK (char_length(vessel) <= 80),        -- vessel and voyage, or flight
  booking_no           text CHECK (char_length(booking_no) <= 40),
  containers           text CHECK (char_length(containers) <= 400),
  bl_no                text CHECK (char_length(bl_no) <= 40),         -- bill of lading or air waybill
  bl_date              date,
  customs_no           text CHECK (char_length(customs_no) <= 40),    -- shipping bill (export) or bill of entry (import)
  customs_date         date,
  cutoff_at            timestamptz,                                    -- documents / gate-in cut-off
  etd                  date,
  eta                  date,
  shipped_on           date,                                           -- on board / departed
  arrived_on           date,
  currency             text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  value_minor          bigint NOT NULL DEFAULT 0 CHECK (value_minor >= 0),   -- the invoice value (sum of lines, or typed)
  freight_minor        bigint NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  insurance_minor      bigint NOT NULL DEFAULT 0 CHECK (insurance_minor >= 0),
  payment_terms        text CHECK (payment_terms IS NULL OR payment_terms IN ('advance', 'lc', 'dp', 'da', 'cad', 'open', 'other')),
  payment_days         int CHECK (payment_days BETWEEN 0 AND 365),
  lc_no                text CHECK (char_length(lc_no) <= 40),
  lc_expiry            date,
  lc_last_shipment     date,
  received_minor       bigint NOT NULL DEFAULT 0 CHECK (received_minor >= 0),
  realise_by           date,                                           -- export proceeds due by (shipped + profile months)
  realised_on          date,
  brc_no               text CHECK (char_length(brc_no) <= 40),         -- bank realisation certificate / eBRC
  duty_paise           bigint CHECK (duty_paise >= 0),
  fee_paise            bigint CHECK (fee_paise >= 0),                  -- a C&F agent's agency fee
  reimbursable_paise   bigint CHECK (reimbursable_paise >= 0),         -- costs paid for the client (duty, port, CFS…)
  invoice_id           uuid REFERENCES invoices(id) ON DELETE SET NULL, -- the bill for a C&F job
  lut                  boolean NOT NULL DEFAULT true,                  -- export under LUT without paying IGST
  notes                text CHECK (char_length(notes) <= 4000),
  last_update_at       timestamptz,                                    -- last status update sent to the party
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, number),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX shipments_stage_idx ON shipments (venture_id, stage, updated_at DESC);
SELECT private.protect_tenant_table('shipments');
GRANT SELECT, INSERT, UPDATE, DELETE ON shipments TO kritvia_app;

CREATE TABLE shipment_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  venture_id        uuid NOT NULL,
  shipment_id       uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  position          int NOT NULL CHECK (position BETWEEN 1 AND 200),
  description       text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
  hs_code           text CHECK (hs_code IS NULL OR hs_code ~ '^[0-9]{4,10}$'),
  qty               numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit              text CHECK (char_length(unit) <= 12),
  unit_price_minor  bigint NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (shipment_id, position),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('shipment_items');
GRANT SELECT, INSERT, UPDATE, DELETE ON shipment_items TO kritvia_app;

CREATE TABLE shipment_packages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  shipment_id  uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  position     int NOT NULL CHECK (position BETWEEN 1 AND 200),
  marks        text CHECK (char_length(marks) <= 120),
  kind         text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 30),   -- cartons, pallets, bags…
  count        int NOT NULL CHECK (count BETWEEN 1 AND 1000000),
  contents     text CHECK (char_length(contents) <= 300),
  net_kg       numeric(12, 3) CHECK (net_kg >= 0),
  gross_kg     numeric(12, 3) CHECK (gross_kg >= 0),
  dimensions   text CHECK (char_length(dimensions) <= 60),
  UNIQUE (shipment_id, position),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('shipment_packages');
GRANT SELECT, INSERT, UPDATE, DELETE ON shipment_packages TO kritvia_app;

CREATE TABLE shipment_docs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  shipment_id  uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  code         text NOT NULL CHECK (code ~ '^[a-z0-9_]{1,40}$'),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  needed_by    text CHECK (needed_by IS NULL OR needed_by IN ('order', 'production', 'booking', 'documents', 'customs',
                                                               'cleared', 'duty_paid', 'shipped', 'arrived', 'delivered', 'paid')),
  status       text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'received', 'done', 'not_needed')),
  ref_no       text CHECK (char_length(ref_no) <= 60),
  ref_date     date,
  note         text CHECK (char_length(note) <= 300),
  document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,
  position     int NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, code),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('shipment_docs');
GRANT SELECT, INSERT, UPDATE, DELETE ON shipment_docs TO kritvia_app;

CREATE TABLE shipment_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  shipment_id  uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('created', 'stage', 'note', 'update_sent', 'document', 'payment')),
  text         text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  stage        text,
  by_user      uuid REFERENCES users(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX shipment_events_idx ON shipment_events (shipment_id, at DESC);
SELECT private.protect_tenant_table('shipment_events');
DROP POLICY tenant_update ON shipment_events;
GRANT SELECT, INSERT, DELETE ON shipment_events TO kritvia_app;

-- The business's owners and admins (for the morning shipment list), read as its agent.
CREATE FUNCTION private.venture_admin_people(p_venture uuid)
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.id, u.email
    FROM ventures v JOIN memberships m ON m.org_id = v.org_id
    JOIN users u ON u.id = m.user_id
   WHERE v.id = p_venture AND p_venture = ANY ((SELECT private.readable_ventures())::uuid[])
     AND u.is_active AND NOT u.is_service
     AND ((m.role = 'org_owner' AND m.venture_id IS NULL) OR (m.venture_id = p_venture AND m.role = 'venture_admin'))
   LIMIT 20
$$;
GRANT EXECUTE ON FUNCTION private.venture_admin_people(uuid) TO kritvia_app;
