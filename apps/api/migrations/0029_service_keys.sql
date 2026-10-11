-- =============================================================================
-- 0029 An organisation's own keys for paid outside services (first: Google Maps Places).
--
-- The Prospector's Google Maps lookups are billed by Google per call. Each customer's lookups now
-- run on that customer's own Google Cloud key, so they are billed to the customer, mostly inside
-- Google's free monthly calls. Kritvia's server key is used only for internal organisations.
--
-- Same storage rules as org_ai_keys (0021): wrapped by the master key with the organisation and
-- service as associated data; the app role cannot read key_wrapped; owners save through a function.
-- =============================================================================
CREATE TABLE org_service_keys (
  org_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  service     text NOT NULL CHECK (service IN ('google_places')),
  key_wrapped bytea NOT NULL,
  key_hint    text NOT NULL CHECK (char_length(key_hint) <= 12),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  last_error  text CHECK (char_length(last_error) <= 300),
  PRIMARY KEY (org_id, service)
);
ALTER TABLE org_service_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_service_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY service_keys_read ON org_service_keys FOR SELECT USING (org_id = ANY (private.member_orgs()));
CREATE POLICY service_keys_write ON org_service_keys FOR ALL
  USING (org_id = ANY (private.owned_orgs())) WITH CHECK (org_id = ANY (private.owned_orgs()));
GRANT SELECT (org_id, service, key_hint, created_by, created_at, updated_at, last_ok_at, last_error)
  ON org_service_keys TO kritvia_app;
GRANT DELETE ON org_service_keys TO kritvia_app;

CREATE FUNCTION private.service_key_save(p_org uuid, p_service text, p_wrapped bytea, p_hint text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (p_org = ANY (private.owned_orgs())) OR private.is_service_user() THEN
    RAISE EXCEPTION 'only an owner can change service keys' USING ERRCODE = '42501';
  END IF;
  INSERT INTO org_service_keys (org_id, service, key_wrapped, key_hint, created_by, last_ok_at)
  VALUES (p_org, p_service, p_wrapped, p_hint, private.current_user_id(), now())
  ON CONFLICT (org_id, service) DO UPDATE SET key_wrapped = EXCLUDED.key_wrapped, key_hint = EXCLUDED.key_hint,
         created_by = EXCLUDED.created_by, last_error = NULL, last_ok_at = now(), updated_at = now();
END $$;
GRANT EXECUTE ON FUNCTION private.service_key_save(uuid, text, bytea, text) TO kritvia_app;

-- What a venture's caller (a person or that venture's agent runtime) needs to make a call:
-- the organisation and its own key for the service, if there is one.
CREATE FUNCTION private.service_key_for(p_venture uuid, p_service text)
RETURNS TABLE (org_id uuid, key_wrapped bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT v.org_id, k.key_wrapped
    FROM ventures v
    LEFT JOIN org_service_keys k ON k.org_id = v.org_id AND k.service = p_service
   WHERE v.id = p_venture AND p_venture = ANY (private.readable_ventures())
$$;
GRANT EXECUTE ON FUNCTION private.service_key_for(uuid, text) TO kritvia_app;

-- A key Google rejected is marked so the owner sees why lookups stopped; a key that works clears it.
CREATE FUNCTION private.service_key_result(p_org uuid, p_service text, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE org_service_keys SET last_error = left(p_error, 300),
         last_ok_at = CASE WHEN p_error IS NULL THEN now() ELSE last_ok_at END
   WHERE org_id = p_org AND service = p_service
     AND EXISTS (SELECT 1 FROM ventures v WHERE v.org_id = p_org AND v.id = ANY (private.readable_ventures()))
$$;
GRANT EXECUTE ON FUNCTION private.service_key_result(uuid, text, text) TO kritvia_app;
