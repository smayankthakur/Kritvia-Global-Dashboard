-- =============================================================================
-- 0067 App store: install any MCP server, a GitHub project, or any web app with an API.
--
--   mcp_servers   now four kinds of installed app:
--                   mcp      a remote MCP server (https), with no auth, a bearer token, a custom header, basic
--                            auth, or OAuth (the MCP authorization spec: client ID metadata document or dynamic
--                            client registration, PKCE, resource indicator, refresh)
--                   hosted   an MCP server from npm, PyPI or a container image that Kritvia's team reviewed;
--                            it runs in the sandboxed MCP runner (services/mcp-runner) with only the internet
--                            hosts it was approved for
--                   openapi  any web app with an OpenAPI description: its operations become tools
--                 .auth / .header_name   how the token is sent; .oauth_enc the OAuth tokens (encrypted)
--                 .hook_secret_hash      an app can send events in (POST /hooks/apps/{id}) -> the event stream
--   app_catalog   the App store's list: Kritvia's verified apps, the official MCP Registry (synced hourly),
--                 and GitHub projects people sent in (pending until Kritvia's team approves them)
--   app_oauth_pending   an OAuth sign-in in progress (state, PKCE verifier; 15 minutes)
-- =============================================================================

ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_url_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_url_check
  CHECK ((url LIKE 'https://%' OR url LIKE 'runner:%') AND char_length(url) <= 500);
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_status_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_status_check
  CHECK (status IN ('active', 'error', 'paused', 'needs_auth'));
ALTER TABLE mcp_servers
  ADD COLUMN kind             text NOT NULL DEFAULT 'mcp' CHECK (kind IN ('mcp', 'hosted', 'openapi')),
  ADD COLUMN auth             text NOT NULL DEFAULT 'bearer' CHECK (auth IN ('none', 'bearer', 'header', 'basic', 'oauth')),
  ADD COLUMN header_name      text CHECK (header_name ~ '^[A-Za-z0-9-]{1,60}$'),
  ADD COLUMN catalog_id       text CHECK (char_length(catalog_id) <= 200),
  ADD COLUMN oauth_enc        bytea,                    -- venture DEK, purpose 'mcp.oauth'
  ADD COLUMN spec             jsonb,                    -- openapi: {base_url, operations: [...]}
  ADD COLUMN hook_secret_hash text CHECK (hook_secret_hash ~ '^[0-9a-f]{64}$');

-- The agent runtime refreshes OAuth tokens (only admins may otherwise change an app).
CREATE FUNCTION private.mcp_save_oauth(p_id uuid, p_enc bytea, p_status text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE mcp_servers SET oauth_enc = coalesce(p_enc, oauth_enc), status = p_status, updated_at = now()
   WHERE id = p_id AND (venture_id = ANY (private.readable_ventures()) OR private.current_actor_type() = 'system')
$$;
GRANT EXECUTE ON FUNCTION private.mcp_save_oauth(uuid, bytea, text) TO kritvia_app;

-- An app sending an event in: the app (by id) and its business, for the hook to check the secret.
CREATE FUNCTION private.app_hook_principal(p_id uuid)
RETURNS TABLE (org_id uuid, venture_id uuid, name text, hook_secret_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.org_id, s.venture_id, s.name, s.hook_secret_hash
    FROM mcp_servers s JOIN ventures v ON v.id = s.venture_id AND v.removed_at IS NULL
   WHERE s.id = p_id AND s.hook_secret_hash IS NOT NULL
$$;
GRANT EXECUTE ON FUNCTION private.app_hook_principal(uuid) TO kritvia_app;

-- ----------------------------------------------------------------------------------------- catalogue --
CREATE TABLE app_catalog (
  id            text PRIMARY KEY CHECK (char_length(id) BETWEEN 2 AND 200),
  source        text NOT NULL CHECK (source IN ('kritvia', 'registry', 'github')),
  kind          text NOT NULL CHECK (kind IN ('mcp', 'hosted', 'skills')),
  title         text NOT NULL CHECK (char_length(title) <= 120),
  description   text CHECK (char_length(description) <= 1000),
  url           text CHECK (url LIKE 'https://%' AND char_length(url) <= 500),
  auth_modes    text[] NOT NULL DEFAULT '{}',
  header_name   text,
  docs_url      text,
  repo_url      text,
  package       jsonb,              -- hosted: {registryType: npm|pypi|oci, identifier, version, env: [{name, secret, required, description}]}
  egress_hosts  text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'pending', 'approved', 'rejected')),
  submitted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  review_note   text CHECK (char_length(review_note) <= 500),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_catalog_search_idx ON app_catalog USING gin (to_tsvector('simple', title || ' ' || coalesce(description, '') || ' ' || id));
ALTER TABLE app_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_catalog FORCE ROW LEVEL SECURITY;
-- Everyone signed in sees what is listed or approved, and their own submissions.
CREATE POLICY app_catalog_read ON app_catalog FOR SELECT
  USING (status IN ('listed', 'approved') OR submitted_by = private.current_user_id());
GRANT SELECT ON app_catalog TO kritvia_app;

-- Writes: the registry sync and Kritvia's team (the API checks STAFF_EMAILS), and submissions.
CREATE FUNCTION private.catalog_upsert(p jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO app_catalog (id, source, kind, title, description, url, auth_modes, header_name, docs_url, repo_url,
                           package, egress_hosts, status, submitted_by)
  VALUES (p->>'id', p->>'source', p->>'kind', left(p->>'title', 120), left(p->>'description', 1000), p->>'url',
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'auth_modes', '[]'))), p->>'header_name',
          p->>'docs_url', p->>'repo_url', p->'package',
          ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'egress_hosts', '[]'))),
          coalesce(p->>'status', 'listed'), (p->>'submitted_by')::uuid)
  ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, url = EXCLUDED.url,
         auth_modes = EXCLUDED.auth_modes, header_name = EXCLUDED.header_name, docs_url = EXCLUDED.docs_url,
         repo_url = EXCLUDED.repo_url, updated_at = now(),
         -- an approved app keeps the exact package version Kritvia's team reviewed
         package = CASE WHEN app_catalog.status = 'approved' THEN app_catalog.package ELSE EXCLUDED.package END,
         -- a reviewed or waiting entry keeps its state; a registry refresh never re-opens one
         status = CASE WHEN app_catalog.status IN ('approved', 'rejected', 'pending') THEN app_catalog.status
                       ELSE EXCLUDED.status END
   WHERE app_catalog.source = EXCLUDED.source
$$;
GRANT EXECUTE ON FUNCTION private.catalog_upsert(jsonb) TO kritvia_app;

CREATE FUNCTION private.catalog_review(p_id text, p_status text, p_hosts text[], p_note text, p_by uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE app_catalog SET status = p_status, egress_hosts = coalesce(p_hosts, egress_hosts), review_note = p_note,
         reviewed_by = p_by, reviewed_at = now(), updated_at = now()
   WHERE id = p_id AND kind = 'hosted' AND source IN ('github', 'registry')
     AND p_status IN ('approved', 'rejected', 'pending')
  RETURNING true
$$;
GRANT EXECUTE ON FUNCTION private.catalog_review(text, text, text[], text, uuid) TO kritvia_app;

-- A business asks Kritvia's team to review an app from the registry that runs as a package.
CREATE FUNCTION private.catalog_request(p_id text, p_by uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE app_catalog SET status = CASE WHEN status = 'listed' THEN 'pending' ELSE status END,
         submitted_by = coalesce(submitted_by, p_by), updated_at = now()
   WHERE id = p_id AND kind = 'hosted'
  RETURNING status
$$;
GRANT EXECUTE ON FUNCTION private.catalog_request(text, uuid) TO kritvia_app;

-- The registry sync drops what the registry deleted (never an entry Kritvia's team reviewed).
CREATE FUNCTION private.catalog_drop(p_ids text[]) RETURNS int
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (DELETE FROM app_catalog WHERE id = ANY (p_ids) AND source = 'registry' AND status = 'listed' RETURNING 1)
  SELECT count(*)::int FROM d
$$;
GRANT EXECUTE ON FUNCTION private.catalog_drop(text[]) TO kritvia_app;

-- Kritvia's team: everything sent in or asked for, waiting first.
CREATE FUNCTION private.catalog_all() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(c) || jsonb_build_object('submitter', (SELECT u.email FROM users u WHERE u.id = c.submitted_by))
    FROM app_catalog c WHERE c.source = 'github' OR c.status IN ('pending', 'approved', 'rejected')
   ORDER BY (c.status = 'pending') DESC, c.updated_at DESC LIMIT 500
$$;
GRANT EXECUTE ON FUNCTION private.catalog_all() TO kritvia_app;

-- -------------------------------------------------------------------------------- OAuth sign-ins --
CREATE TABLE app_oauth_pending (
  state        text PRIMARY KEY CHECK (char_length(state) BETWEEN 32 AND 100),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_enc     bytea NOT NULL,          -- venture DEK, purpose 'mcp.oauth': verifier, endpoints, client, app
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('app_oauth_pending');
GRANT SELECT, INSERT, UPDATE, DELETE ON app_oauth_pending TO kritvia_app;

-- ----------------------------------------------------------------------------------- app events --
-- An installed app tells Kritvia something happened (POST /hooks/apps/{id} with its secret): one event
-- 'app.event' on the business's stream, so skills can start right after it and alerts can fire.
-- At most 500 an hour per app; returns false when over.
CREATE FUNCTION private.app_event(p_id uuid, p_summary text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record;
BEGIN
  SELECT org_id, venture_id, name INTO s FROM mcp_servers WHERE id = p_id AND hook_secret_hash IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  IF (SELECT count(*) FROM business_events WHERE subject_table = 'mcp_servers' AND subject_id = p_id
        AND occurred_at > now() - interval '1 hour') >= 500 THEN
    RETURN false;
  END IF;
  PERFORM private.emit_event(s.org_id, s.venture_id, 'app.event', 'mcp_servers', p_id,
                             s.name || ': ' || left(coalesce(nullif(btrim(p_summary), ''), 'something happened'), 280));
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION private.app_event(uuid, text) TO kritvia_app;
