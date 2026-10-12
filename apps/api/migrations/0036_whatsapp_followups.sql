-- =============================================================================
-- 0036 WhatsApp follow-ups by agents, and who agreed to hear from the business.
--
-- WhatsApp's rules: a business may only message people who gave it their number and agreed to
-- hear from it. Kritvia records that per chat:
--   opted_in_at / opt_in_source  'wrote_first'    the customer messaged the business
--                                'team_confirmed' a team member confirmed consent (New chat)
-- Agents only ever write to opted-in chats, never to cold numbers (a Prospector's first WhatsApp
-- still goes from the owner's own phone).
--
-- The WhatsApp follow-up agent writes, once a day, to enquiries that went quiet: it fills one of the
-- business's approved templates from the chat and waits for a yes. followups_sent counts its
-- messages since the customer last wrote (a reply resets it), so a chat gets at most the number the
-- owner set.
-- =============================================================================
ALTER TABLE wa_contacts
  ADD COLUMN opted_in_at       timestamptz,
  ADD COLUMN opt_in_source     text CHECK (opt_in_source IS NULL OR opt_in_source IN ('wrote_first', 'team_confirmed')),
  ADD COLUMN followups_sent    int NOT NULL DEFAULT 0 CHECK (followups_sent BETWEEN 0 AND 20),
  ADD COLUMN last_followup_at  timestamptz;

UPDATE wa_contacts SET opted_in_at = created_at, opt_in_source = 'wrote_first' WHERE last_inbound_at IS NOT NULL;
UPDATE wa_contacts c SET opted_in_at = c.created_at, opt_in_source = 'team_confirmed'
 WHERE c.opted_in_at IS NULL
   AND EXISTS (SELECT 1 FROM wa_messages m WHERE m.contact_id = c.id AND m.kind = 'template' AND m.sent_by = 'person');

CREATE INDEX wa_contacts_quiet_idx ON wa_contacts (venture_id, last_message_at)
  WHERE opted_out_at IS NULL AND opted_in_at IS NOT NULL;

-- The follow-up agent sits with Sales on the org chart.
CREATE OR REPLACE FUNCTION private.default_role(p_workflow text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_workflow
    WHEN 'inbox_assistant' THEN 'front_desk'
    WHEN 'lead_triage' THEN 'sales'
    WHEN 'prospector' THEN 'sales'
    WHEN 'whatsapp_followup' THEN 'sales'
    WHEN 'loan_verification' THEN 'accounts'
    ELSE 'ops' END
$$;
