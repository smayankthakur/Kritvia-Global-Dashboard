-- =============================================================================
-- Kritvia 0021 — Free models by default; each organisation may bring its own paid keys.
--
--   org_ai_settings  allow_training_models: the owner may also switch on free models whose
--                    providers may learn from the content they receive (Gemini free tier,
--                    OpenRouter free models, Mistral free tier). Off by default. The router never
--                    uses them for sensitive records or for a business with Google connected
--                    (Google's API rules forbid sending Workspace data to models that train).
--   org_ai_keys      the organisation's own API keys for paid models (OpenAI, Anthropic, Gemini,
--                    Groq, OpenRouter, Mistral, Cerebras). Stored wrapped by the master key with the
--                    organisation and provider as associated data; never returned to the browser.
--                    Calls on these keys are billed by the provider to the customer, so they do
--                    not count against the plan's hosted-AI allowance.
-- =============================================================================
CREATE TABLE org_ai_settings (
  org_id                uuid PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  allow_training_models boolean NOT NULL DEFAULT false,
  updated_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE org_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_ai_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_settings_read ON org_ai_settings FOR SELECT USING (org_id = ANY (private.member_orgs()));
CREATE POLICY ai_settings_write ON org_ai_settings FOR ALL
  USING (org_id = ANY (private.owned_orgs())) WITH CHECK (org_id = ANY (private.owned_orgs()));
GRANT SELECT, INSERT, UPDATE ON org_ai_settings TO kritvia_app;

CREATE TABLE org_ai_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'gemini', 'groq', 'openrouter',
                                                'mistral', 'cerebras')),
  model       text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  key_wrapped bytea NOT NULL,
  key_hint    text NOT NULL CHECK (char_length(key_hint) <= 12),   -- last four characters, for the UI
  position    int NOT NULL DEFAULT 0,                              -- tried in ascending order
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  last_error  text CHECK (char_length(last_error) <= 300),
  UNIQUE (org_id, provider)
);
ALTER TABLE org_ai_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_ai_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_keys_read ON org_ai_keys FOR SELECT USING (org_id = ANY (private.member_orgs()));
CREATE POLICY ai_keys_write ON org_ai_keys FOR ALL
  USING (org_id = ANY (private.owned_orgs())) WITH CHECK (org_id = ANY (private.owned_orgs()));
-- The wrapped key is not readable through the app role; the router reads it via ai_route().
GRANT SELECT (id, org_id, provider, model, key_hint, position, created_by, created_at, updated_at,
              last_ok_at, last_error) ON org_ai_keys TO kritvia_app;
GRANT INSERT, UPDATE, DELETE ON org_ai_keys TO kritvia_app;

-- What the model router needs for one venture's call: may it use training models, is Google
-- connected there, and the organisation's own keys in order. Only for callers who can read it.
CREATE FUNCTION private.ai_route(p_venture uuid)
RETURNS TABLE (org_id uuid, allow_training boolean, google_connected boolean,
               provider text, model text, key_wrapped bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH v AS (SELECT id, org_id FROM ventures WHERE id = p_venture AND p_venture = ANY (private.readable_ventures()))
  SELECT v.org_id,
         coalesce((SELECT s.allow_training_models FROM org_ai_settings s WHERE s.org_id = v.org_id), false),
         EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = v.id AND c.provider = 'google' AND c.status = 'active'),
         k.provider, k.model, k.key_wrapped
    FROM v LEFT JOIN org_ai_keys k ON k.org_id = v.org_id
   ORDER BY k.position, k.created_at
$$;
GRANT EXECUTE ON FUNCTION private.ai_route(uuid) TO kritvia_app;

-- A key the provider rejected is marked so the owner sees it; a key that works clears the mark.
CREATE FUNCTION private.ai_key_result(p_org uuid, p_provider text, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE org_ai_keys SET last_error = left(p_error, 300),
         last_ok_at = CASE WHEN p_error IS NULL THEN now() ELSE last_ok_at END
   WHERE org_id = p_org AND provider = p_provider
$$;
GRANT EXECUTE ON FUNCTION private.ai_key_result(uuid, text, text) TO kritvia_app;

-- For the customer notice page: may this business's AI requests reach models that train?
CREATE FUNCTION private.notice_ai_may_train(p_venture uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT s.allow_training_models FROM ventures v JOIN org_ai_settings s ON s.org_id = v.org_id
                    WHERE v.id = p_venture), false)
     AND NOT EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = p_venture AND c.provider = 'google'
                      AND c.status = 'active')
$$;
GRANT EXECUTE ON FUNCTION private.notice_ai_may_train(uuid) TO kritvia_app;

-- Saving a key goes through a function: the app role cannot read key_wrapped, which an upsert needs.
CREATE FUNCTION private.ai_key_save(p_org uuid, p_provider text, p_model text, p_wrapped bytea, p_hint text,
                                    p_position int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) THEN
    RAISE EXCEPTION 'only an owner can change AI models' USING ERRCODE = '42501';
  END IF;
  INSERT INTO org_ai_keys (org_id, provider, model, key_wrapped, key_hint, position, created_by, last_ok_at)
  VALUES (p_org, p_provider, p_model, p_wrapped, p_hint,
          coalesce(p_position, (SELECT coalesce(max(position) + 1, 0) FROM org_ai_keys WHERE org_id = p_org)),
          private.current_user_id(), now())
  ON CONFLICT (org_id, provider) DO UPDATE SET model = EXCLUDED.model, key_wrapped = EXCLUDED.key_wrapped,
         key_hint = EXCLUDED.key_hint, position = coalesce(p_position, org_ai_keys.position), last_error = NULL,
         last_ok_at = now(), updated_at = now();
END $$;
GRANT EXECUTE ON FUNCTION private.ai_key_save(uuid, text, text, bytea, text, int) TO kritvia_app;
