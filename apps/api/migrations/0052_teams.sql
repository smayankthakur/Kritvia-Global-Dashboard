-- =============================================================================
-- 0052 Teams, and who works with whom.
--
--   teams              named groups of an organisation's people (Sales, Design, Platform…), across
--                      its businesses. Everyone in the organisation can see them; owners change them.
--   team_members       who is in each team, and who leads it. Only people in the organisation.
--   task_boards.team_id  a project board can belong to a team.
--   org_people(org)    the organisation's people (not service accounts), for pickers.
--
-- The mind map's "People & projects" view (GET /ventures/{id}/collab) is built from these, the
-- project boards' cards (who is assigned, who handed work to whom) and the people named together in
-- meetings, emails and documents, all read with the viewer's own access: nothing new is revealed.
-- =============================================================================
CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description  text CHECK (description IS NULL OR char_length(description) <= 280),
  color        text NOT NULL DEFAULT 'blue'
               CHECK (color IN ('blue', 'orange', 'aqua', 'yellow', 'pink', 'green', 'violet', 'red')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX teams_name_uq ON teams (org_id, lower(btrim(name)));

CREATE TABLE team_members (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL,
  team_id   uuid NOT NULL,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_lead   boolean NOT NULL DEFAULT false,
  added_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id),
  FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id) ON DELETE CASCADE
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY teams_read ON teams FOR SELECT USING (org_id = ANY ((SELECT private.member_orgs())::uuid[]));
CREATE POLICY teams_write ON teams FOR ALL
  USING (org_id = ANY ((SELECT private.owned_orgs())::uuid[]))
  WITH CHECK (org_id = ANY ((SELECT private.owned_orgs())::uuid[]));
CREATE POLICY team_members_read ON team_members FOR SELECT USING (org_id = ANY ((SELECT private.member_orgs())::uuid[]));
CREATE POLICY team_members_write ON team_members FOR ALL
  USING (org_id = ANY ((SELECT private.owned_orgs())::uuid[]))
  WITH CHECK (org_id = ANY ((SELECT private.owned_orgs())::uuid[]));
GRANT SELECT, INSERT, UPDATE, DELETE ON teams, team_members TO kritvia_app;
SELECT private.attach_audit('teams'::regclass);
SELECT private.attach_audit('team_members'::regclass);

-- A team member must be a (human) member of the organisation.
CREATE FUNCTION private.check_team_member() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.org_id = NEW.org_id AND m.user_id = NEW.user_id AND NOT u.is_service) THEN
    RAISE EXCEPTION 'only people in the organisation can join its teams' USING ERRCODE = 'KV409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER team_members_check BEFORE INSERT OR UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION private.check_team_member();

-- Someone who leaves the organisation leaves its teams too.
CREATE FUNCTION private.leave_teams() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE org_id = OLD.org_id AND user_id = OLD.user_id) THEN
    DELETE FROM team_members WHERE org_id = OLD.org_id AND user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER memberships_leave_teams AFTER DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION private.leave_teams();

-- A project board can belong to one of the organisation's teams.
ALTER TABLE task_boards ADD COLUMN team_id uuid;
ALTER TABLE task_boards ADD CONSTRAINT task_boards_team_fk
  FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id) ON DELETE SET NULL (team_id);
CREATE INDEX task_boards_team_idx ON task_boards (team_id) WHERE team_id IS NOT NULL;

-- The organisation's people, for anyone in it (names and emails only).
CREATE FUNCTION public.org_people(p_org uuid)
RETURNS TABLE (user_id uuid, full_name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.id, u.full_name, u.email
    FROM memberships m JOIN users u ON u.id = m.user_id AND NOT u.is_service AND u.is_active
   WHERE m.org_id = p_org AND p_org = ANY (private.member_orgs())
   ORDER BY u.full_name
$$;
GRANT EXECUTE ON FUNCTION public.org_people(uuid) TO kritvia_app;
