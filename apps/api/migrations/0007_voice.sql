-- =============================================================================
-- Kritvia 0007 — Voice: vocabulary, auto-learn, per-user voice settings, dictation stats.
--
-- vocabulary_terms   the correct spelling of a word/phrase plus the ways the speech
--                    model mishears it ("sounds like"). Shared terms (user_id NULL) are
--                    used for everyone in the venture, including meeting transcripts;
--                    personal terms only for their owner's dictation.
-- voice_settings     one row per user: engine, language, filters, hotkey, widget.
-- dictation_events   metadata of each dictation (duration, words, engine, language) for
--                    the Insights page. Never the text or the audio.
-- venture_settings   + speech_people_hints: whether people's names from the knowledge
--                    graph may be sent to hosted speech models as spelling hints.
-- =============================================================================

-- --------------------------------------------------------- vocabulary_terms --
CREATE TABLE vocabulary_terms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  venture_id      uuid NOT NULL,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,     -- NULL = shared with the venture
  term            text NOT NULL CHECK (length(btrim(term)) BETWEEN 1 AND 64),
  sounds_like     text[] NOT NULL DEFAULT '{}'
                  CHECK (cardinality(sounds_like) <= 20),
  case_sensitive  boolean NOT NULL DEFAULT false,
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto_learn', 'import')),
  uses            int NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX vocabulary_terms_uq ON vocabulary_terms
  (venture_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(term)));

SELECT private.protect_tenant_table('vocabulary_terms');

-- Personal terms are private to their owner, also from venture admins.
CREATE POLICY vocabulary_owner ON vocabulary_terms AS RESTRICTIVE FOR ALL
  USING (user_id IS NULL OR user_id = private.current_user_id())
  WITH CHECK (user_id IS NULL OR user_id = private.current_user_id());

-- Anyone who can read a venture (viewers too) may keep personal terms for it.
CREATE POLICY vocabulary_personal_insert ON vocabulary_terms FOR INSERT
  WITH CHECK (user_id = private.current_user_id()
              AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[]));
CREATE POLICY vocabulary_personal_update ON vocabulary_terms FOR UPDATE
  USING (user_id = private.current_user_id()
         AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[]))
  WITH CHECK (user_id = private.current_user_id()
              AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[]));
CREATE POLICY vocabulary_personal_delete ON vocabulary_terms FOR DELETE
  USING (user_id = private.current_user_id()
         AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[]));

-- Usage counter for any term the caller can see (dictation by viewers counts too).
CREATE FUNCTION public.vocabulary_touch(p_ids uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE vocabulary_terms SET uses = uses + 1
   WHERE id = ANY (p_ids)
     AND venture_id = ANY (private.readable_ventures())
     AND (user_id IS NULL OR user_id = private.current_user_id());
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON vocabulary_terms TO kritvia_app;
GRANT EXECUTE ON FUNCTION public.vocabulary_touch(uuid[]) TO kritvia_app;

-- ------------------------------------------------------------ voice_settings --
CREATE TABLE voice_settings (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  engine           text NOT NULL DEFAULT 'auto' CHECK (engine IN ('auto', 'sarvam', 'whisper', 'local')),
  language         text NOT NULL DEFAULT 'auto' CHECK (language ~ '^(auto|[a-z]{2,3})$'),
  remove_fillers   boolean NOT NULL DEFAULT true,
  profanity_filter boolean NOT NULL DEFAULT false,
  auto_learn       boolean NOT NULL DEFAULT true,
  hotkey           text NOT NULL DEFAULT 'ControlRight' CHECK (hotkey ~ '^[A-Za-z0-9]{2,24}$'),
  widget_enabled   boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE voice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY voice_settings_self ON voice_settings FOR ALL
  USING (user_id = private.current_user_id() AND NOT private.is_service_user())
  WITH CHECK (user_id = private.current_user_id() AND NOT private.is_service_user());
GRANT SELECT, INSERT, UPDATE ON voice_settings TO kritvia_app;

-- ---------------------------------------------------------- dictation_events --
CREATE TABLE dictation_events (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  surface      text NOT NULL CHECK (surface IN ('web', 'desktop')),
  mode         text NOT NULL DEFAULT 'type' CHECK (mode IN ('type', 'note', 'ask')),
  engine       text NOT NULL,
  language     text,
  audio_ms     int NOT NULL CHECK (audio_ms BETWEEN 0 AND 3600000),
  words        int NOT NULL CHECK (words BETWEEN 0 AND 100000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX dictation_events_user_time_idx ON dictation_events (user_id, created_at DESC);

-- Not audited row-by-row (high volume, no content); visible only to the dictating user.
ALTER TABLE dictation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dictation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dictation_select ON dictation_events FOR SELECT
  USING (user_id = private.current_user_id()
         AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[]));
CREATE POLICY dictation_insert ON dictation_events FOR INSERT
  WITH CHECK (user_id = private.current_user_id()
              AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[]));
CREATE POLICY dictation_delete ON dictation_events FOR DELETE
  USING (user_id = private.current_user_id());
INSERT INTO private.tenant_tables VALUES ('dictation_events') ON CONFLICT DO NOTHING;
GRANT SELECT, INSERT, DELETE ON dictation_events TO kritvia_app;
GRANT USAGE ON SEQUENCE dictation_events_id_seq TO kritvia_app;

-- ---------------------------------------------------------- venture_settings --
ALTER TABLE venture_settings ADD COLUMN speech_people_hints boolean NOT NULL DEFAULT false;

-- ----------------------------------------------------------------- model_calls --
-- Metering rows were insertable only for writable ventures, so a viewer's model calls
-- (voice input, Ask) failed when the router tried to record them. Read access is enough
-- to meter your own call; rows remain metadata only.
CREATE POLICY model_calls_reader_insert ON model_calls FOR INSERT
  WITH CHECK (venture_id = ANY ((SELECT private.readable_ventures())::uuid[]));
