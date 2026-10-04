-- =============================================================================
-- Kritvia 0019 — A DPDP privacy notice each business can give its own customers.
--
-- Under the DPDP Act the business (our customer) is the Data Fiduciary for its leads,
-- WhatsApp contacts and loan applicants, and must give them a notice: who it is, what it
-- collects and why, who processes it, their rights, and whom to contact. Kritvia publishes
-- that notice at /n/<venture id> once the business names a privacy contact, and can link it
-- at the foot of the email replies its agents draft.
-- =============================================================================
ALTER TABLE venture_settings
  ADD COLUMN privacy_contact_name text CHECK (char_length(privacy_contact_name) <= 120),
  ADD COLUMN privacy_contact_email text CHECK (char_length(privacy_contact_email) <= 200),
  ADD COLUMN notice_in_replies boolean NOT NULL DEFAULT false;

-- What the public notice page shows. Nothing unless the business has named a privacy contact.
CREATE FUNCTION private.public_notice(p_venture uuid)
RETURNS TABLE (business_name text, city text, contact_name text, contact_email text, kind text,
               workflows text[], updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(s.business_name, v.name), coalesce(s.city, ''), coalesce(s.privacy_contact_name, ''),
         s.privacy_contact_email, coalesce(s.kind, 'general'),
         coalesce((SELECT array_agg(c.workflow ORDER BY c.workflow) FROM workflow_configs c
                    WHERE c.venture_id = v.id AND c.enabled), '{}'),
         s.updated_at
    FROM ventures v JOIN venture_settings s ON s.venture_id = v.id
    JOIN organisations o ON o.id = v.org_id
   WHERE v.id = p_venture AND s.privacy_contact_email IS NOT NULL AND o.closed_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION private.public_notice(uuid) TO kritvia_app;
