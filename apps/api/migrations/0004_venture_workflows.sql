-- =============================================================================
-- Kritvia 0004 — Data for the three dogfood workflows.
--   Sitelytc      lead triage & proposal drafting  (rate card, proposals)
--   Truhome       loan document verification      (applications, checklists)
--   Cloud kitchen demand forecast & PO generation  (BOM, vendors, sales, POs)
-- Money is numeric(14,2) INR and is only ever computed in code, never by an LLM.
-- =============================================================================

-- ---------------------------------------------------------------- Sitelytc --
ALTER TABLE leads
  ADD COLUMN phone            text,
  ADD COLUMN budget_inr       numeric(14, 2),
  ADD COLUMN timeline         text,
  ADD COLUMN priority         text CHECK (priority IS NULL OR priority IN ('hot', 'warm', 'cold')),
  ADD COLUMN score_reasons    jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN details_enc      bytea,          -- extracted requirements, venture DEK
  ADD COLUMN inquiry_count    int NOT NULL DEFAULT 1,
  ADD COLUMN last_inquiry_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_run_id      uuid;
CREATE INDEX leads_email_idx ON leads (venture_id, lower(email));

CREATE TABLE rate_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  code         text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  unit         text NOT NULL CHECK (unit IN ('project', 'page', 'screen', 'integration', 'hour',
                                             'month', 'workflow', 'assessment', 'item')),
  rate_inr     numeric(14, 2) NOT NULL CHECK (rate_inr >= 0),
  min_units    numeric(10, 2) NOT NULL DEFAULT 1 CHECK (min_units > 0),
  active       boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, code),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  lead_id       uuid NOT NULL,
  run_id        uuid,
  title         text NOT NULL,
  content_enc   bytea NOT NULL,
  line_items    jsonb NOT NULL DEFAULT '[]',   -- [{code, name, unit, qty, rate, amount}]
  subtotal_inr  numeric(14, 2) NOT NULL,
  gst_inr       numeric(14, 2) NOT NULL DEFAULT 0,
  total_inr     numeric(14, 2) NOT NULL,
  reference     jsonb NOT NULL DEFAULT '{}',   -- matched past projects: ids, price range
  citations     jsonb NOT NULL DEFAULT '[]',   -- [{document_id, title}]
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'superseded')),
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX proposals_lead_idx ON proposals (venture_id, lead_id, created_at DESC);

-- ----------------------------------------------------------------- Truhome --
CREATE TABLE document_checklists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  loan_type   text NOT NULL CHECK (loan_type ~ '^[a-z0-9_]{2,40}$'),
  version     int  NOT NULL DEFAULT 1,
  name        text NOT NULL,
  items       jsonb NOT NULL,   -- [{doc_type, label, min_count, max_age_days, required}]
  rules       jsonb NOT NULL DEFAULT '[]',   -- [{id, kind, params, severity}]
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, loan_type, version),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE loan_applications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  venture_id           uuid NOT NULL,
  reference            text NOT NULL,            -- human-friendly id, no PII
  loan_type            text NOT NULL,
  amount_inr           numeric(14, 2),
  applicant_enc        bytea NOT NULL,           -- {name, email, phone, pan, dob}
  data_principal       text NOT NULL,            -- keyed hash, for DPDP requests
  consent_id           uuid,
  status               text NOT NULL DEFAULT 'collecting'
                       CHECK (status IN ('collecting', 'verifying', 'needs_info', 'complete',
                                         'submitted', 'closed')),
  checklist_id         uuid,
  checklist_result     jsonb NOT NULL DEFAULT '{}',  -- codes only (present/missing/rule ids)
  upload_token_hash    text,
  upload_token_expires timestamptz,
  last_run_id          uuid,
  access_roles         text[] NOT NULL DEFAULT '{loan_officer}',
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, reference),
  UNIQUE (venture_id, id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE loan_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  application_id   uuid NOT NULL,
  document_id      uuid NOT NULL,
  doc_type         text,
  confidence       real,
  fields_enc       bytea,                       -- extracted typed fields
  issues           jsonb NOT NULL DEFAULT '[]', -- [{code, severity}] no PII
  status           text NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received', 'classified', 'extracted', 'rejected')),
  access_roles     text[] NOT NULL DEFAULT '{loan_officer}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, document_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, application_id) REFERENCES loan_applications(venture_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, document_id) REFERENCES documents(venture_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------ Cloud kitchen --
CREATE TABLE dishes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[a-z0-9_-]{1,60}$'),
  name        text NOT NULL,
  price_inr   numeric(10, 2),
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (venture_id, code),
  UNIQUE (venture_id, id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE ingredients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[a-z0-9_-]{1,60}$'),
  name        text NOT NULL,
  unit        text NOT NULL CHECK (unit IN ('kg', 'g', 'l', 'ml', 'pcs', 'dozen', 'pack')),
  UNIQUE (venture_id, code),
  UNIQUE (venture_id, id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE recipe_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  dish_id          uuid NOT NULL,
  ingredient_id    uuid NOT NULL,
  qty_per_portion  numeric(12, 4) NOT NULL CHECK (qty_per_portion > 0),  -- in ingredient unit
  wastage_pct      numeric(5, 2) NOT NULL DEFAULT 0 CHECK (wastage_pct BETWEEN 0 AND 100),
  UNIQUE (dish_id, ingredient_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, dish_id) REFERENCES dishes(venture_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, ingredient_id) REFERENCES ingredients(venture_id, id) ON DELETE CASCADE
);

CREATE TABLE vendors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[a-z0-9_-]{1,60}$'),
  name        text NOT NULL,
  email       text,
  phone       text,
  lead_days   int NOT NULL DEFAULT 1 CHECK (lead_days BETWEEN 0 AND 30),
  active      boolean NOT NULL DEFAULT true,
  UNIQUE (venture_id, code),
  UNIQUE (venture_id, id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE vendor_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  vendor_id        uuid NOT NULL,
  ingredient_id    uuid NOT NULL,
  sku              text,
  pack_size        numeric(12, 3) NOT NULL CHECK (pack_size > 0),   -- in ingredient unit
  price_per_pack   numeric(12, 2) NOT NULL CHECK (price_per_pack >= 0),
  min_order_packs  int NOT NULL DEFAULT 1 CHECK (min_order_packs >= 1),
  preferred        boolean NOT NULL DEFAULT true,
  UNIQUE (vendor_id, ingredient_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, vendor_id) REFERENCES vendors(venture_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, ingredient_id) REFERENCES ingredients(venture_id, id) ON DELETE CASCADE
);

CREATE TABLE stock_counts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  ingredient_id  uuid NOT NULL,
  qty            numeric(12, 3) NOT NULL CHECK (qty >= 0),
  counted_at     timestamptz NOT NULL DEFAULT now(),
  counted_by     uuid REFERENCES users(id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, ingredient_id) REFERENCES ingredients(venture_id, id) ON DELETE CASCADE
);
CREATE INDEX stock_counts_latest_idx ON stock_counts (venture_id, ingredient_id, counted_at DESC);

CREATE TABLE sales_daily (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  sale_date    date NOT NULL,
  dish_id      uuid NOT NULL,
  channel      text NOT NULL DEFAULT 'all' CHECK (channel IN ('all', 'swiggy', 'zomato', 'direct', 'other')),
  qty          numeric(10, 2) NOT NULL CHECK (qty >= 0),
  revenue_inr  numeric(14, 2),
  source       text NOT NULL DEFAULT 'csv' CHECK (source IN ('csv', 'email', 'manual', 'api')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, sale_date, dish_id, channel),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, dish_id) REFERENCES dishes(venture_id, id) ON DELETE CASCADE
);
CREATE INDEX sales_daily_date_idx ON sales_daily (venture_id, sale_date);

CREATE TABLE calendar_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  event_date   date NOT NULL,
  name         text NOT NULL,
  multiplier   numeric(4, 2) CHECK (multiplier IS NULL OR multiplier BETWEEN 0.2 AND 3),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX calendar_events_date_idx ON calendar_events (venture_id, event_date);

CREATE TABLE forecasts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  venture_id        uuid NOT NULL,
  run_id            uuid NOT NULL,
  target_date       date NOT NULL,
  dish_id           uuid NOT NULL,
  model_qty         numeric(10, 2) NOT NULL,
  lo                numeric(10, 2),
  hi                numeric(10, 2),
  method            text NOT NULL,
  mape_backtest     numeric(6, 1),
  event_multiplier  numeric(4, 2) NOT NULL DEFAULT 1,
  final_qty         numeric(10, 2) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, dish_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, dish_id) REFERENCES dishes(venture_id, id) ON DELETE CASCADE
);
CREATE INDEX forecasts_target_idx ON forecasts (venture_id, target_date);

CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  run_id        uuid NOT NULL,
  po_number     text NOT NULL,
  vendor_id     uuid NOT NULL,
  target_date   date NOT NULL,
  lines         jsonb NOT NULL,
  total_inr     numeric(14, 2) NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'sent', 'rejected', 'cancelled', 'received')),
  approval_id   uuid,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, po_number),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, vendor_id) REFERENCES vendors(venture_id, id)
);

CREATE TABLE prep_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  run_id       uuid NOT NULL UNIQUE,
  target_date  date NOT NULL,
  items        jsonb NOT NULL,        -- [{dish, portions}] and [{ingredient, qty, unit}]
  narrative    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

SELECT private.protect_tenant_table(t) FROM unnest(ARRAY[
  'rate_cards', 'proposals', 'document_checklists', 'loan_applications', 'loan_documents',
  'dishes', 'ingredients', 'recipe_items', 'vendors', 'vendor_items', 'stock_counts', 'sales_daily',
  'calendar_events', 'forecasts', 'purchase_orders', 'prep_lists']) t;

CREATE POLICY loan_applications_roles ON loan_applications AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles));
CREATE POLICY loan_documents_roles ON loan_documents AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles));

GRANT SELECT, INSERT, UPDATE, DELETE ON rate_cards, proposals, document_checklists, loan_applications,
  loan_documents, dishes, ingredients, recipe_items, vendors, vendor_items, calendar_events TO kritvia_app;
GRANT SELECT, INSERT ON stock_counts TO kritvia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_daily TO kritvia_app;
GRANT SELECT, INSERT, UPDATE ON forecasts, prep_lists TO kritvia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_orders TO kritvia_app;

-- Client upload links: resolve an unexpired token hash to its application and
-- the venture's agent runtime (the upload then runs under RLS as that agent).
CREATE FUNCTION private.upload_token_principal(p_hash text)
RETURNS TABLE (application_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.org_id, a.venture_id, private.provision_service_account(a.org_id, a.venture_id)
    FROM loan_applications a
   WHERE a.upload_token_hash = p_hash AND a.upload_token_expires > now()
     AND a.status NOT IN ('submitted', 'closed')
$$;
GRANT EXECUTE ON FUNCTION private.upload_token_principal(text) TO kritvia_app;
