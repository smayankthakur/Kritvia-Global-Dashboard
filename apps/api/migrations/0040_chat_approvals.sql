-- =============================================================================
-- 0040 Approve from your phone: drafts waiting for a yes reach team members in Telegram (through the
-- business's own bot) and Slack (through Kritvia's Slack app), with Approve / Reject / Ask for changes.
--
--   approver_links   a team member's Telegram chat or Slack user, linked to their Kritvia account for one
--                    business. A decision made there is made AS that person: the same role checks as in
--                    the app (decide_approval), so linking never gives anyone more rights.
--   approval_notes   the chat messages that carried each approval, so they can be updated once decided.
--   private.approver_link_codes  one-time link codes (stored hashed, 15 minutes).
-- =============================================================================
CREATE TABLE approver_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('telegram', 'slack')),
  external_id      text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 64),   -- Telegram chat id / Slack user id
  external_team    text CHECK (char_length(external_team) <= 64),                     -- Slack workspace id
  label            text CHECK (char_length(label) <= 120),
  pending_changes  uuid REFERENCES approvals(id) ON DELETE SET NULL,   -- Telegram: waiting for "what to change"
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venture_id, channel, external_id),
  UNIQUE (venture_id, channel, user_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('approver_links');
-- A person sees and removes their own links; the business's admins see and remove everyone's.
DROP POLICY tenant_select ON approver_links;
DROP POLICY tenant_insert ON approver_links;
DROP POLICY tenant_update ON approver_links;
DROP POLICY tenant_delete ON approver_links;
CREATE POLICY own_select ON approver_links FOR SELECT
  USING (user_id = private.current_user_id() OR private.can_admin_venture(venture_id)
         OR (private.is_service_user() AND venture_id = ANY ((SELECT private.readable_ventures())::uuid[])));
CREATE POLICY own_delete ON approver_links FOR DELETE
  USING (user_id = private.current_user_id() OR private.can_admin_venture(venture_id));
CREATE POLICY runtime_update ON approver_links FOR UPDATE
  USING (private.is_service_user() AND venture_id = ANY ((SELECT private.writable_ventures())::uuid[]))
  WITH CHECK (private.is_service_user() AND venture_id = ANY ((SELECT private.writable_ventures())::uuid[]));
GRANT SELECT, UPDATE, DELETE ON approver_links TO kritvia_app;

CREATE TABLE approval_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL,
  venture_id   uuid NOT NULL,
  approval_id  uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('telegram', 'slack')),
  chat         text NOT NULL CHECK (char_length(chat) <= 64),
  message_id   text NOT NULL CHECK (char_length(message_id) <= 64),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX approval_notes_approval_idx ON approval_notes (approval_id);
SELECT private.protect_tenant_table('approval_notes');
DROP POLICY tenant_update ON approval_notes;
GRANT SELECT, INSERT, DELETE ON approval_notes TO kritvia_app;

CREATE TABLE private.approver_link_codes (
  code_hash   text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('telegram', 'slack')),
  expires_at  timestamptz NOT NULL
);

-- Anyone who can see the business may ask for a code for themselves (approvers included: they are the
-- people who decide). Earlier codes of the same person and channel stop working.
CREATE FUNCTION private.new_approver_link_code(p_venture uuid, p_channel text, p_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid;
BEGIN
  IF private.current_user_id() IS NULL OR private.is_service_user()
     OR NOT (p_venture = ANY ((SELECT private.readable_ventures())::uuid[])
             OR EXISTS (SELECT 1 FROM ventures v WHERE v.id = p_venture AND v.org_id = ANY (private.owned_orgs()))) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT org_id INTO v_org FROM ventures WHERE id = p_venture;
  DELETE FROM private.approver_link_codes
   WHERE (user_id = private.current_user_id() AND venture_id = p_venture AND channel = p_channel)
      OR expires_at < now();
  INSERT INTO private.approver_link_codes (code_hash, user_id, org_id, venture_id, channel, expires_at)
  VALUES (p_hash, private.current_user_id(), v_org, p_venture, p_channel, now() + interval '15 minutes');
END $$;
GRANT EXECUTE ON FUNCTION private.new_approver_link_code(uuid, text, text) TO kritvia_app;

-- Called by the business's runtime when a code arrives in its bot (or Slack app): links the sender to
-- the person who asked for the code, for that business only. Returns the person's name, or nothing.
CREATE FUNCTION private.redeem_approver_link_code(p_venture uuid, p_channel text, p_hash text,
                                                  p_external text, p_team text, p_label text)
RETURNS TABLE (user_id uuid, full_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE c record;
BEGIN
  DELETE FROM private.approver_link_codes k
   WHERE k.code_hash = p_hash AND k.venture_id = p_venture AND k.channel = p_channel AND k.expires_at > now()
  RETURNING k.* INTO c;
  IF c IS NULL THEN RETURN; END IF;
  -- The chat proved itself by sending the code: it now belongs to the person who asked for it.
  DELETE FROM approver_links l
   WHERE l.venture_id = c.venture_id AND l.channel = p_channel AND l.external_id = p_external AND l.user_id <> c.user_id;
  INSERT INTO approver_links (org_id, venture_id, user_id, channel, external_id, external_team, label)
  VALUES (c.org_id, c.venture_id, c.user_id, p_channel, p_external, p_team, left(p_label, 120))
  ON CONFLICT (venture_id, channel, user_id) DO UPDATE
     SET external_id = EXCLUDED.external_id, external_team = EXCLUDED.external_team, label = EXCLUDED.label,
         pending_changes = NULL, created_at = now();
  RETURN QUERY SELECT u.id, u.full_name FROM users u WHERE u.id = c.user_id;
END $$;
GRANT EXECUTE ON FUNCTION private.redeem_approver_link_code(uuid, text, text, text, text, text) TO kritvia_app;

-- Who gets an approval in chat: linked people who could decide it in the app.
CREATE FUNCTION private.approval_chat_targets(p_approval uuid, p_channel text)
RETURNS TABLE (user_id uuid, external_id text, external_team text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT l.user_id, l.external_id, l.external_team
    FROM approvals a
    JOIN approver_links l ON l.venture_id = a.venture_id AND l.channel = p_channel
    JOIN memberships m ON m.user_id = l.user_id AND m.org_id = a.org_id
         AND (m.venture_id IS NULL OR m.venture_id = a.venture_id)
         AND (m.role = ANY (a.required_roles) OR m.role = 'org_owner'
              OR (NOT a.sensitive AND m.role = 'venture_admin' AND 'venture_admin' = ANY (a.required_roles)))
   WHERE a.id = p_approval AND a.status = 'pending'
$$;
GRANT EXECUTE ON FUNCTION private.approval_chat_targets(uuid, text) TO kritvia_app;

-- The person behind a Telegram chat or Slack user, for one business (decisions are made as them).
CREATE FUNCTION private.approver_for(p_venture uuid, p_channel text, p_external text)
RETURNS TABLE (link_id uuid, user_id uuid, pending_changes uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.user_id, l.pending_changes FROM approver_links l
   WHERE l.venture_id = p_venture AND l.channel = p_channel AND l.external_id = p_external
$$;
GRANT EXECUTE ON FUNCTION private.approver_for(uuid, text, text) TO kritvia_app;

-- The business's bot, read as its agent runtime, for approval cards and button presses (the caller is
-- the server itself, after a run asked for a decision or a signed Slack request arrived).
CREATE FUNCTION private.telegram_bot_for(p_venture uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c WHERE c.venture_id = p_venture AND c.provider = 'telegram' AND c.status = 'active'
$$;
GRANT EXECUTE ON FUNCTION private.telegram_bot_for(uuid) TO kritvia_app;

-- Kritvia's Slack app installed for one business in one Slack workspace (connectors.external_id = team).
CREATE FUNCTION private.slack_app_principal(p_team text, p_venture uuid)
RETURNS TABLE (connector_id uuid, org_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.org_id, c.venture_id, private.provision_service_account(c.org_id, c.venture_id)
    FROM connectors c
   WHERE c.venture_id = p_venture AND c.provider = 'slack' AND c.status = 'active'
     AND c.external_id = p_team AND c.meta ->> 'mode' = 'app'
$$;
GRANT EXECUTE ON FUNCTION private.slack_app_principal(text, uuid) TO kritvia_app;
