-- =============================================================================
-- 0028 Prospector: an outbound sales agent.
--
-- It finds businesses on Google Maps (Places API) that match a search, keeps the
-- ones without a website, and works each one through a short sequence of
-- touches (email it sends itself, WhatsApp messages the owner sends with one
-- tap). A reply or an opt-out stops the sequence.
--
-- Prospects are ordinary leads (source 'prospector') with a few extra columns.
--
-- Google Maps Platform terms let us store a place's ID and nothing else from the Places API, so a
-- prospect row holds the place ID, the search that found it, our own conclusion about its web
-- presence and our outreach history. Its name, phone, address and rating are fetched live from
-- Google when the agent writes and when someone opens the lead. When a business replies, the owner
-- can save the contact details the business gave them; from then on it is an ordinary lead.
ALTER TABLE leads
  ADD COLUMN place_id             text,          -- Google place ID (the one Places field we may keep)
  ADD COLUMN place_search         text,          -- the owner's search that found it
  ADD COLUMN website_kind         text CHECK (website_kind IS NULL
                                              OR website_kind IN ('none', 'social', 'listing', 'own')),
  ADD COLUMN outreach_step        int NOT NULL DEFAULT 0 CHECK (outreach_step BETWEEN 0 AND 20),
  ADD COLUMN next_touch_at        timestamptz,   -- NULL: nothing scheduled
  ADD COLUMN last_touch_at        timestamptz,
  ADD COLUMN last_touch_channel   text CHECK (last_touch_channel IS NULL
                                              OR last_touch_channel IN ('email', 'whatsapp', 'call')),
  ADD COLUMN outreach_draft_enc   bytea,         -- our WhatsApp message waiting for the owner's one-tap send
  ADD COLUMN thread_id            text,          -- Gmail thread of our first email, to match replies
  ADD COLUMN replied_at           timestamptz,
  ADD COLUMN opted_out_at         timestamptz;   -- asked not to be contacted: never touched again

ALTER TABLE leads DROP CONSTRAINT leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new', 'contacted', 'replied', 'qualified', 'proposal', 'won', 'lost', 'archived'));

CREATE UNIQUE INDEX leads_place_idx ON leads (venture_id, place_id) WHERE place_id IS NOT NULL;
CREATE INDEX leads_next_touch_idx ON leads (venture_id, next_touch_at) WHERE next_touch_at IS NOT NULL;
CREATE INDEX leads_thread_idx ON leads (venture_id, thread_id) WHERE thread_id IS NOT NULL;

-- The Prospector sits with Sales on the org chart.
CREATE OR REPLACE FUNCTION private.default_role(p_workflow text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_workflow
    WHEN 'inbox_assistant' THEN 'front_desk'
    WHEN 'lead_triage' THEN 'sales'
    WHEN 'prospector' THEN 'sales'
    WHEN 'loan_verification' THEN 'accounts'
    ELSE 'ops' END
$$;

-- "Send without asking" on the Prospector: the owner grants autonomy for the Prospector's own messages
-- directly instead of it being earned approval by approval (a cold message has no history to earn it
-- from). Only the Prospector, only its gmail/whatsapp sends, only a venture admin; agent_trust's row
-- trigger audits the change like any other promotion. Sensitive drafts and drafts marked for review
-- still wait for a person (runner + guard_approval_insert).
CREATE FUNCTION public.set_prospector_autonomy(p_venture uuid, p_auto boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid; a text;
BEGIN
  IF NOT (p_venture = ANY (private.readable_ventures())) OR NOT private.can_admin_venture(p_venture)
     OR private.is_service_user() THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  SELECT org_id INTO v_org FROM ventures WHERE id = p_venture;
  FOREACH a IN ARRAY ARRAY['gmail.send', 'whatsapp.send'] LOOP
    INSERT INTO agent_trust (org_id, venture_id, agent, action, auto_run, promoted_by, promoted_at)
    VALUES (v_org, p_venture, 'prospector', a, p_auto,
            CASE WHEN p_auto THEN private.current_user_id() END, CASE WHEN p_auto THEN now() END)
    ON CONFLICT (venture_id, agent, action) DO UPDATE SET auto_run = EXCLUDED.auto_run,
      promoted_by = coalesce(EXCLUDED.promoted_by, agent_trust.promoted_by),
      promoted_at = coalesce(EXCLUDED.promoted_at, agent_trust.promoted_at), updated_at = now()
    WHERE agent_trust.auto_run IS DISTINCT FROM EXCLUDED.auto_run;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.set_prospector_autonomy(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_prospector_autonomy(uuid, boolean) TO kritvia_app;
