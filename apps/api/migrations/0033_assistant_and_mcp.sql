-- =============================================================================
-- 0033 General assistant and connected apps (MCP).
--
-- The assistant (workflows/assistant.py) needs no new tables: each request is a workflow run whose
-- request, steps and answer stay in the encrypted run state.
--
-- Connected apps: a business adds an app's MCP server (an https address, optionally a token). The
-- assistant can then use that app's tools: read-only ones straight away, the rest only through an
-- approval a person always reviews (services/mcp.py). Several apps per business, each with a short
-- name the assistant uses (app.<name>.<tool>).
--
--   tools  the app's tool list as last fetched: [{name, description, read_only, fields, required}]
--          (descriptions only, never data from the app)
-- =============================================================================
CREATE TABLE mcp_servers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  name        text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,23}$'),
  url         text NOT NULL CHECK (url LIKE 'https://%' AND char_length(url) <= 500),
  token_enc   bytea,                                   -- venture DEK, purpose 'mcp.token'
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'paused')),
  tools       jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error  text CHECK (char_length(last_error) <= 300),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, name),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('mcp_servers');
-- Only the business's admins add, change or remove apps (the agent runtime only reads them).
CREATE POLICY mcp_servers_insert ON mcp_servers AS RESTRICTIVE FOR INSERT
  WITH CHECK (private.can_admin_venture(venture_id));
CREATE POLICY mcp_servers_update ON mcp_servers AS RESTRICTIVE FOR UPDATE
  USING (private.can_admin_venture(venture_id));
CREATE POLICY mcp_servers_delete ON mcp_servers AS RESTRICTIVE FOR DELETE
  USING (private.can_admin_venture(venture_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_servers TO kritvia_app;
