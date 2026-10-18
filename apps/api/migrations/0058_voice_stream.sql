-- =============================================================================
-- 0058 Phone calls within India (Exotel) and anywhere, with Kritvia's own speech pipeline and the
-- business's own speech keys (BYOK).
--
--   connectors.provider 'exotel_voice'   the business's ExoPhone (number in external_id/account_email;
--                                        account SID, API key, region and the hash of the stream link's
--                                        secret in meta; the API token encrypted in connector_tokens).
--   phone_settings.twilio_mode           'gather' (Twilio speaks and listens) or 'stream' (Kritvia does, with
--                                        the voices below, over Twilio Media Streams)
--   phone_settings.stt_provider / tts_provider / stt_model / tts_model / tts_voice
--                                        whose speech-to-text and voice a call uses: Kritvia's ('platform'),
--                                        the business's own key (sarvam, openai, deepgram, elevenlabs), or the
--                                        speech server on Kritvia's own machine ('local')
--   voice_keys                           the business's speech keys, encrypted; never shown again
--   private.exotel_principal(connector)  the business behind an Exotel stream or callback, before its secret
--                                        (or the call's signature) is checked
-- =============================================================================
ALTER TABLE connectors DROP CONSTRAINT connectors_provider_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_provider_check
  CHECK (provider IN ('google', 'webhook', 'whatsapp', 'tally', 'email_in', 'telegram', 'slack', 'razorpay',
                      'indiamart', 'twilio_voice', 'exotel_voice'));

ALTER TABLE phone_settings
  ADD COLUMN twilio_mode  text NOT NULL DEFAULT 'gather' CHECK (twilio_mode IN ('gather', 'stream')),
  ADD COLUMN stt_provider text NOT NULL DEFAULT 'platform'
             CHECK (stt_provider IN ('platform', 'sarvam', 'openai', 'deepgram', 'local')),
  ADD COLUMN tts_provider text NOT NULL DEFAULT 'platform'
             CHECK (tts_provider IN ('platform', 'sarvam', 'openai', 'elevenlabs', 'local')),
  ADD COLUMN stt_model    text CHECK (char_length(stt_model) <= 80),
  ADD COLUMN tts_model    text CHECK (char_length(tts_model) <= 80),
  ADD COLUMN tts_voice    text CHECK (char_length(tts_voice) <= 80);

CREATE TABLE voice_keys (
  venture_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('sarvam', 'openai', 'deepgram', 'elevenlabs')),
  key_enc     bytea NOT NULL,
  base_url    text CHECK (base_url ~ '^https://[^\s]{4,300}$'),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venture_id, provider),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('voice_keys');
GRANT SELECT, INSERT, UPDATE, DELETE ON voice_keys TO kritvia_app;

CREATE FUNCTION private.exotel_principal(p_connector uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid, secret_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id),
         c.meta ->> 'secret_hash'
    FROM connectors c
   WHERE c.id = p_connector AND c.provider = 'exotel_voice' AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.exotel_principal(uuid) TO kritvia_app;
