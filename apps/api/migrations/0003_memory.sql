-- =============================================================================
-- Kritvia 0003 — Memory: documents, chunks + embeddings, knowledge graph.
--
-- Every fact and edge carries a mandatory source_chunk_id, so any answer the
-- system gives can link back to the exact passage (and, for meetings, the exact
-- timestamp) it came from. Deleting a document cascades to everything derived
-- from it — which is also how DPDP erasure removes derived knowledge.
--
-- Text is encrypted at rest with the venture DEK; retrieval is by vector
-- similarity (embeddings are not reversible to text) plus graph traversal.
-- Documents can be restricted to roles (e.g. loan_officer): enforced by a
-- RESTRICTIVE policy in the database, not by the API.
-- =============================================================================

CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL,
  venture_id          uuid NOT NULL,
  title               text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('upload', 'email', 'drive', 'transcript', 'meeting',
                                                    'note', 'proposal', 'loan_document', 'report')),
  source_uri          text,
  external_id         text,
  mime                text,
  sha256              text NOT NULL,
  size_bytes          int  NOT NULL DEFAULT 0,
  raw_enc             bytea,                -- original bytes, venture DEK
  text_method         text,
  pii_tags            text[] NOT NULL DEFAULT '{}',
  sensitive           boolean NOT NULL DEFAULT false,
  access_roles        text[],               -- NULL = every reader of the venture
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  error               text,
  meta                jsonb NOT NULL DEFAULT '{}',   -- non-sensitive (page count, duration, ...)
  data_principal      text,                 -- keyed hash of the person the data is about (DPDP)
  retention_class     text NOT NULL DEFAULT 'standard',
  delete_after        timestamptz,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, id),
  UNIQUE (venture_id, sha256, kind),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX documents_venture_idx ON documents (venture_id, created_at DESC);
CREATE INDEX documents_principal_idx ON documents (venture_id, data_principal);

CREATE TABLE chunks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  venture_id     uuid NOT NULL,
  document_id    uuid NOT NULL,
  ord            int  NOT NULL,
  text_enc       bytea NOT NULL,
  char_count     int  NOT NULL,
  page           int,
  start_s        real,                      -- transcripts: segment time range
  end_s          real,
  speaker        text,
  embedding      vector(1024),              -- bge-m3
  sensitive      boolean NOT NULL DEFAULT false,
  access_roles   text[],
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, id),
  UNIQUE (document_id, ord),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, document_id) REFERENCES documents(venture_id, id) ON DELETE CASCADE
);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_venture_idx ON chunks (venture_id);

CREATE TABLE entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  type          text NOT NULL CHECK (type IN ('person', 'company', 'project', 'property', 'vendor',
                                              'sku', 'loan', 'product', 'place', 'other')),
  name          text NOT NULL,
  canonical     text NOT NULL,
  attrs         jsonb NOT NULL DEFAULT '{}',
  access_roles  text[],
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, id),
  UNIQUE (venture_id, type, canonical),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);

CREATE TABLE edges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  src_id           uuid NOT NULL,
  dst_id           uuid NOT NULL,
  type             text NOT NULL CHECK (type ~ '^[A-Z][A-Z_]{1,40}$'),
  source_chunk_id  uuid NOT NULL,
  access_roles     text[],
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_id, dst_id, type, source_chunk_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, src_id) REFERENCES entities(venture_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, dst_id) REFERENCES entities(venture_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, source_chunk_id) REFERENCES chunks(venture_id, id) ON DELETE CASCADE
);

CREATE TABLE facts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL,
  venture_id         uuid NOT NULL,
  kind               text NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact', 'decision', 'task', 'commitment')),
  subject_id         uuid,
  statement_enc      bytea NOT NULL,
  owner              text,
  due_date           date,
  status             text CHECK (status IS NULL OR status IN ('open', 'done', 'dropped')),
  confidence         real CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  source_chunk_id    uuid NOT NULL,
  source_start_s     real,
  access_roles       text[],
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (venture_id, subject_id) REFERENCES entities(venture_id, id) ON DELETE SET NULL (subject_id),
  FOREIGN KEY (venture_id, source_chunk_id) REFERENCES chunks(venture_id, id) ON DELETE CASCADE
);
CREATE INDEX facts_venture_kind_idx ON facts (venture_id, kind, created_at DESC);
CREATE INDEX facts_chunk_idx ON facts (source_chunk_id);

SELECT private.protect_tenant_table(t) FROM unnest(ARRAY[
  'documents', 'chunks', 'entities', 'edges', 'facts']) t;

-- Role-restricted knowledge (e.g. Truhome raw loan documents -> loan_officer only).
CREATE FUNCTION private.role_visible(p_venture uuid, p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_roles IS NULL
      OR private.has_venture_role(p_venture, p_roles || '{agent_runtime}'::text[])
$$;

CREATE POLICY documents_roles ON documents AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles));
CREATE POLICY chunks_roles ON chunks AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles));
CREATE POLICY entities_roles ON entities AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles));
CREATE POLICY edges_roles ON edges AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles));
CREATE POLICY facts_roles ON facts AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles));

GRANT SELECT, INSERT, UPDATE, DELETE ON documents, chunks, entities, edges, facts TO kritvia_app;
GRANT EXECUTE ON FUNCTION private.role_visible(uuid, text[]) TO kritvia_app;
