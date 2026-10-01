-- =============================================================================
-- Kritvia 0007 — Voice: vocabulary, auto-learn, per-user voice settings, dictation stats.
--
-- vocabulary_terms   the correct spelling of a word/phrase plus the ways the speech
--                    model mishears it ("sounds like"). Shared terms (user_id NULL) are
--                    used for everyone in the venture, including meeting transcripts;
--                    personal terms only for their owner's dictation.
-- vocabulary_usage   how often each term fixed a transcript. Kept apart from the audited
--                    terms table: per-dictation audit rows would tell every venture reader
--                    who said which name, and when.
-- voice_settings     one row per user: engine, language, filters, hotkey, widget.
-- dictation_events   metadata of each dictation (duration, words, engine, language) for
--                    the Insights page. Never the text or the audio.
-- venture_settings   + speech_people_hints: whether vocabulary and names from the knowledge
--                    graph may be sent to hosted speech models as spelling hints (local
--                    models always get them). Off by default.
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

GRANT SELECT, INSERT, UPDATE, DELETE ON vocabulary_terms TO kritvia_app;

-- ---------------------------------------------------------- vocabulary_usage --
CREATE TABLE vocabulary_usage (
  term_id       uuid PRIMARY KEY REFERENCES vocabulary_terms(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  uses          int NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
ALTER TABLE vocabulary_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE vocabulary_usage FORCE ROW LEVEL SECURITY;
-- visible exactly when the term is (the subquery runs under vocabulary_terms' own RLS)
CREATE POLICY vocabulary_usage_select ON vocabulary_usage FOR SELECT
  USING (EXISTS (SELECT 1 FROM vocabulary_terms t WHERE t.id = term_id));
INSERT INTO private.tenant_tables VALUES ('vocabulary_usage') ON CONFLICT DO NOTHING;
GRANT SELECT ON vocabulary_usage TO kritvia_app;

-- Count a use of terms the caller can see (dictation by viewers counts too). Not audited.
CREATE FUNCTION public.vocabulary_touch(p_ids uuid[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO vocabulary_usage AS u (term_id, org_id, venture_id, uses, last_used_at)
  SELECT t.id, t.org_id, t.venture_id, 1, now() FROM vocabulary_terms t
   WHERE t.id = ANY (p_ids)
     AND t.venture_id = ANY (private.readable_ventures())
     AND (t.user_id IS NULL OR t.user_id = private.current_user_id())
  ON CONFLICT (term_id) DO UPDATE SET uses = u.uses + 1, last_used_at = now();
$$;

-- Which of these terms may be sent to a speech model as spelling hints: none that name a
-- role-restricted record (e.g. a loan applicant), whether or not the caller can see it.
-- Server-side only; the answer is never shown to the caller.
CREATE FUNCTION public.vocabulary_hint_filter(p_venture uuid, p_terms text[]) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(x ORDER BY i), '{}') FROM unnest(p_terms) WITH ORDINALITY AS a(x, i)
   WHERE p_venture = ANY (private.readable_ventures())
     AND NOT EXISTS (SELECT 1 FROM entities e
                      WHERE e.venture_id = p_venture AND e.access_roles IS NOT NULL
                        AND (e.canonical = lower(btrim(x)) OR lower(e.name) = lower(btrim(x))))
$$;

REVOKE EXECUTE ON FUNCTION public.vocabulary_touch(uuid[]), public.vocabulary_hint_filter(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vocabulary_touch(uuid[]), public.vocabulary_hint_filter(uuid, text[]) TO kritvia_app;

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
