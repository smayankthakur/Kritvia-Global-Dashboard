-- =============================================================================
-- Kritvia 0011 — Billing (Razorpay subscriptions).
--
-- billing_profiles   legal name, GSTIN and address for tax invoices (owners edit).
-- billing_events     every verified Razorpay webhook event: subscription changes, payments,
--                    invoices (with Razorpay's invoice link). Written only by the webhook
--                    through public.billing_record; owners read their organisation's rows.
-- =============================================================================
CREATE TABLE billing_profiles (
  org_id        uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  legal_name    text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  gstin         text CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),
  address       text NOT NULL DEFAULT '' CHECK (char_length(address) <= 500),
  state_code    text CHECK (state_code ~ '^[0-9]{2}$'),
  email         text CHECK (char_length(email) <= 200),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_profiles_owner ON billing_profiles FOR ALL
  USING (org_id = ANY (private.owned_orgs())) WITH CHECK (org_id = ANY (private.owned_orgs()));
GRANT SELECT, INSERT, UPDATE ON billing_profiles TO kritvia_app;

CREATE TABLE billing_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  event            text NOT NULL,
  razorpay_id      text NOT NULL,            -- event id (idempotency)
  subscription_id  text,
  plan             text,
  amount_paise     bigint,
  invoice_url      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (razorpay_id)
);
CREATE INDEX billing_events_org_idx ON billing_events (org_id, created_at DESC);
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_events_owner_read ON billing_events FOR SELECT USING (org_id = ANY (private.owned_orgs()));
GRANT SELECT ON billing_events TO kritvia_app;

ALTER TABLE org_plans ADD COLUMN subscription_id text, ADD COLUMN subscription_status text;

-- Webhook writer: records the event once and applies the plan change. Returns false for a
-- duplicate delivery (Razorpay retries), so the caller can answer 200 without re-applying.
CREATE FUNCTION public.billing_record(p_org uuid, p_event text, p_id text, p_sub text, p_plan text,
                                      p_status text, p_renews timestamptz, p_amount bigint, p_invoice text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organisations WHERE id = p_org) THEN RETURN false; END IF;
  INSERT INTO billing_events (org_id, event, razorpay_id, subscription_id, plan, amount_paise, invoice_url)
  VALUES (p_org, p_event, p_id, p_sub, p_plan, p_amount, p_invoice) ON CONFLICT (razorpay_id) DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_plan IS NOT NULL THEN
    INSERT INTO org_plans (org_id, plan, renews_at, subscription_id, subscription_status)
    VALUES (p_org, p_plan, p_renews, p_sub, p_status)
    ON CONFLICT (org_id) DO UPDATE SET plan = EXCLUDED.plan, renews_at = coalesce(EXCLUDED.renews_at, org_plans.renews_at),
      subscription_id = coalesce(EXCLUDED.subscription_id, org_plans.subscription_id),
      subscription_status = EXCLUDED.subscription_status, updated_at = now()
    WHERE org_plans.plan <> 'internal';
  END IF;
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION public.billing_record(uuid, text, text, text, text, text, timestamptz, bigint, text) TO kritvia_app;
