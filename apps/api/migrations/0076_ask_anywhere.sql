-- =============================================================================
-- 0076 Ask Kritvia from anywhere (owner side of the answering machine).
--
-- Email: each person gets a private "ask address" per business (ask-<128 random bits>@<inbound domain>).
-- Only a hash is stored; the full address is shown once. Mail to it is answered only when Cloudflare
-- verified the From domain AND From is that person's own account email; the answer goes to the account
-- email, never to an address taken from the message.
-- Slack: a direct message to Kritvia's Slack app (or a mention of it) from a linked Slack member.
-- Both start the assistant as that person, like the Telegram and WhatsApp front door (0054).
-- =============================================================================
CREATE TABLE ask_addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  venture_id    uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_hash    text NOT NULL UNIQUE CHECK (char_length(local_hash) = 64),   -- sha256 of the local part
  hint          text NOT NULL CHECK (char_length(hint) BETWEEN 1 AND 12),     -- last characters, to recognise it
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  UNIQUE (venture_id, user_id),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
SELECT private.protect_tenant_table('ask_addresses');
-- A person sees and removes only their own address; it is made through ask_address_set.
DROP POLICY tenant_select ON ask_addresses;
DROP POLICY tenant_insert ON ask_addresses;
DROP POLICY tenant_update ON ask_addresses;
DROP POLICY tenant_delete ON ask_addresses;
CREATE POLICY own_select ON ask_addresses FOR SELECT USING (user_id = private.current_user_id());
CREATE POLICY own_delete ON ask_addresses FOR DELETE USING (user_id = private.current_user_id());
GRANT SELECT, DELETE ON ask_addresses TO kritvia_app;

-- Makes (or replaces: the old address stops working) the caller's ask address for a business they can
-- ask (write access, the same rule as the Assistant page).
CREATE FUNCTION public.ask_address_set(p_venture uuid, p_hash text, p_hint text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid := private.current_user_id(); org uuid; out_id uuid;
BEGIN
  IF uid IS NULL OR private.is_service_user() THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT p_venture = ANY (private.writable_ventures()) THEN
    RAISE EXCEPTION 'asking this business needs an operator or admin role' USING ERRCODE = '42501';
  END IF;
  SELECT org_id INTO org FROM ventures WHERE id = p_venture;
  INSERT INTO ask_addresses (org_id, venture_id, user_id, local_hash, hint)
       VALUES (org, p_venture, uid, p_hash, p_hint)
  ON CONFLICT (venture_id, user_id) DO UPDATE
       SET local_hash = EXCLUDED.local_hash, hint = EXCLUDED.hint, created_at = now(), last_used_at = NULL
  RETURNING id INTO out_id;
  RETURN out_id;
END $$;
REVOKE ALL ON FUNCTION public.ask_address_set(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ask_address_set(uuid, text, text) TO kritvia_app;

-- Inbound mail: whose address is this (the server itself, after the email worker's signature checked out).
CREATE FUNCTION private.ask_address_principal(p_hash text)
RETURNS TABLE (address_id uuid, org_id uuid, venture_id uuid, user_id uuid, email text, business text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.org_id, a.venture_id, a.user_id, lower(u.email), v.name
    FROM ask_addresses a JOIN users u ON u.id = a.user_id JOIN ventures v ON v.id = a.venture_id
   WHERE a.local_hash = p_hash AND u.is_active AND NOT u.is_service
$$;
REVOKE ALL ON FUNCTION private.ask_address_principal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.ask_address_principal(text) TO kritvia_app;

CREATE FUNCTION private.ask_address_used(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE ask_addresses SET last_used_at = now() WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION private.ask_address_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.ask_address_used(uuid) TO kritvia_app;

-- Is this ask address (by id) still this person's? An answer goes out only while it is.
CREATE FUNCTION private.ask_address_owner(p_id uuid) RETURNS TABLE (user_id uuid, email text, venture_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.user_id, lower(u.email), a.venture_id FROM ask_addresses a JOIN users u ON u.id = a.user_id
   WHERE a.id = p_id AND u.is_active
$$;
REVOKE ALL ON FUNCTION private.ask_address_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.ask_address_owner(uuid) TO kritvia_app;

-- Slack: the businesses where this Slack member (in this workspace) is linked and Kritvia's app is added.
CREATE FUNCTION private.slack_ask_targets(p_team text, p_user text)
RETURNS TABLE (venture_id uuid, user_id uuid, business text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.venture_id, l.user_id, v.name
    FROM approver_links l JOIN ventures v ON v.id = l.venture_id
   WHERE l.channel = 'slack' AND l.external_id = p_user AND l.external_team = p_team
     AND EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = l.venture_id AND c.provider = 'slack'
                    AND c.status = 'active' AND c.external_id = p_team AND c.meta ->> 'mode' = 'app')
   ORDER BY v.name
$$;
REVOKE ALL ON FUNCTION private.slack_ask_targets(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.slack_ask_targets(text, text) TO kritvia_app;

-- Slack retries an event it thinks wasn't delivered, and a mail can arrive twice: take each one once.
CREATE TABLE private.front_door_seen (
  channel  text NOT NULL,
  ref      text NOT NULL CHECK (char_length(ref) <= 300),
  seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, ref)
);
REVOKE ALL ON private.front_door_seen FROM PUBLIC;

CREATE FUNCTION private.front_door_first(p_channel text, p_ref text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  DELETE FROM private.front_door_seen WHERE seen_at < now() - interval '3 days'
    AND ctid IN (SELECT ctid FROM private.front_door_seen WHERE seen_at < now() - interval '3 days' LIMIT 100);
  INSERT INTO private.front_door_seen (channel, ref) VALUES (p_channel, left(p_ref, 300)) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION private.front_door_first(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.front_door_first(text, text) TO kritvia_app;

-- A business in this Slack workspace with Kritvia's app, so a member who isn't linked yet can be told how.
CREATE FUNCTION private.slack_team_venture(p_team text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.venture_id FROM connectors c
   WHERE c.provider = 'slack' AND c.status = 'active' AND c.external_id = p_team AND c.meta ->> 'mode' = 'app'
   ORDER BY c.created_at LIMIT 1
$$;
REVOKE ALL ON FUNCTION private.slack_team_venture(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.slack_team_venture(text) TO kritvia_app;

-- A request asked from Slack is a run started from Slack. NOT VALID then VALIDATE: no long lock on
-- workflow_runs (existing rows already satisfy the wider list).
ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_trigger_kind_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_trigger_kind_check
  CHECK (trigger_kind IN ('manual', 'email', 'webhook', 'schedule', 'upload', 'api', 'whatsapp', 'telegram',
                          'indiamart', 'event', 'slack')) NOT VALID;
ALTER TABLE workflow_runs VALIDATE CONSTRAINT workflow_runs_trigger_kind_check;
