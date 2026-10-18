-- =============================================================================
-- 0054 Run the business from Telegram or WhatsApp.
--
-- A team member who linked their chat (Account → Approve from your phone) can now also talk to the
-- business there: a message or a voice note in Hindi, Hinglish or English goes to the Kritvia assistant
-- as that person, and the answer comes back in the same chat. Drafts that need their yes arrive as cards.
--
--   approver_links / approval_notes / private.approver_link_codes   channel 'whatsapp' too: a person
--                         links their own phone by sending the one-time code to the business's WhatsApp
--                         number; from then on that number is them (never a customer chat).
--   approver_links.last_inbound_at   when the person last wrote from that chat. WhatsApp only lets a
--                         business message someone freely for 24 hours after they wrote, so cards and
--                         answers go to WhatsApp only inside that window (Telegram has no such limit).
--   private.whatsapp_number_for(venture)   the business's WhatsApp number, read as its runtime.
-- =============================================================================
ALTER TABLE approver_links DROP CONSTRAINT approver_links_channel_check;
ALTER TABLE approver_links ADD CONSTRAINT approver_links_channel_check
  CHECK (channel IN ('telegram', 'slack', 'whatsapp'));
ALTER TABLE approver_links ADD COLUMN last_inbound_at timestamptz;

ALTER TABLE approval_notes DROP CONSTRAINT approval_notes_channel_check;
ALTER TABLE approval_notes ADD CONSTRAINT approval_notes_channel_check
  CHECK (channel IN ('telegram', 'slack', 'whatsapp'));

ALTER TABLE private.approver_link_codes DROP CONSTRAINT approver_link_codes_channel_check;
ALTER TABLE private.approver_link_codes ADD CONSTRAINT approver_link_codes_channel_check
  CHECK (channel IN ('telegram', 'slack', 'whatsapp'));

CREATE FUNCTION private.whatsapp_number_for(p_venture uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.venture_id = p_venture AND c.provider = 'whatsapp' AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.whatsapp_number_for(uuid) TO kritvia_app;

-- Voice notes sent to the business's chat count as dictation like the web and desktop ones (words, time saved).
ALTER TABLE dictation_events DROP CONSTRAINT dictation_events_surface_check;
ALTER TABLE dictation_events ADD CONSTRAINT dictation_events_surface_check
  CHECK (surface IN ('web', 'desktop', 'telegram', 'whatsapp'));
