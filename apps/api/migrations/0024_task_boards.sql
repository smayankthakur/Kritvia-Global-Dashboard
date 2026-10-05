-- =============================================================================
-- Kritvia 0024 — Task boards (Trello-style): boards → lists → cards, per business.
--
--   task_boards   several per business; one is the default ("Tasks"), where tasks the
--                 agents extract from meetings, emails and documents land.
--   task_lists    columns on a board, ordered by position; one may be the "done" list.
--   task_cards    ordered by position within a list. Title, description and checklist are
--                 encrypted with the business's key (purpose task_cards.*); labels, assignee
--                 and due date are plain. A card made from an extracted task (fact_id) shows
--                 the fact's statement as its title until someone renames it, and inherits the
--                 fact's role restriction (access_roles).
--
-- Moving a card into or out of a done list marks its extracted task done / open, and a
-- task marked done elsewhere moves its card to the done list.
-- =============================================================================
CREATE TABLE task_boards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  position    double precision NOT NULL DEFAULT 0,
  is_default  boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE,
  UNIQUE (venture_id, id)
);
CREATE UNIQUE INDEX task_boards_one_default ON task_boards (venture_id) WHERE is_default;

CREATE TABLE task_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  venture_id  uuid NOT NULL,
  board_id    uuid NOT NULL,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  position    double precision NOT NULL DEFAULT 0,
  is_done     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (venture_id, board_id) REFERENCES task_boards(venture_id, id) ON DELETE CASCADE,
  UNIQUE (board_id, id)
);
CREATE INDEX task_lists_board_idx ON task_lists (board_id, position);

CREATE TABLE task_cards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  board_id         uuid NOT NULL,
  list_id          uuid NOT NULL,
  title_enc        bytea,
  description_enc  bytea,
  checklist_enc    bytea,
  position         double precision NOT NULL DEFAULT 0,
  assignee_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date         date,
  labels           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(labels) = 'array' AND jsonb_array_length(labels) <= 10),
  fact_id          uuid REFERENCES facts(id) ON DELETE CASCADE,
  access_roles     text[],
  done_at          timestamptz,
  archived_at      timestamptz,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (venture_id, board_id) REFERENCES task_boards(venture_id, id) ON DELETE CASCADE,
  FOREIGN KEY (board_id, list_id) REFERENCES task_lists(board_id, id) ON DELETE CASCADE,
  CHECK (title_enc IS NOT NULL OR fact_id IS NOT NULL)
);
CREATE INDEX task_cards_list_idx ON task_cards (list_id, position) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX task_cards_fact_idx ON task_cards (fact_id) WHERE fact_id IS NOT NULL;

SELECT private.protect_tenant_table(t) FROM unnest(ARRAY['task_boards', 'task_lists', 'task_cards']) t;
-- A card made from a role-restricted task is visible only to those roles (like the task itself).
CREATE POLICY task_cards_roles ON task_cards AS RESTRICTIVE FOR ALL
  USING (private.role_visible(venture_id, access_roles))
  WITH CHECK (private.role_visible(venture_id, access_roles));
GRANT SELECT, INSERT, UPDATE, DELETE ON task_boards, task_lists, task_cards TO kritvia_app;

-- The default board with its four lists, created on first use.
CREATE FUNCTION private.ensure_default_board(p_org uuid, p_venture uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b uuid;
BEGIN
  SELECT id INTO b FROM task_boards WHERE venture_id = p_venture AND is_default;
  IF b IS NOT NULL THEN RETURN b; END IF;
  INSERT INTO task_boards (org_id, venture_id, name, is_default) VALUES (p_org, p_venture, 'Tasks', true)
  ON CONFLICT (venture_id) WHERE is_default DO NOTHING RETURNING id INTO b;
  IF b IS NULL THEN   -- created concurrently
    SELECT id INTO b FROM task_boards WHERE venture_id = p_venture AND is_default;
    RETURN b;
  END IF;
  INSERT INTO task_lists (org_id, venture_id, board_id, name, position, is_done) VALUES
    (p_org, p_venture, b, 'To do', 1024, false), (p_org, p_venture, b, 'In progress', 2048, false),
    (p_org, p_venture, b, 'Review', 3072, false), (p_org, p_venture, b, 'Done', 4096, true);
  RETURN b;
END $$;

-- Callable by anyone who can see the business (the board is created empty).
CREATE FUNCTION public.default_task_board(p_venture uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o uuid;
BEGIN
  IF NOT (p_venture = ANY (private.readable_ventures())) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = '42501';
  END IF;
  SELECT org_id INTO o FROM ventures WHERE id = p_venture;
  RETURN private.ensure_default_board(o, p_venture);
END $$;
GRANT EXECUTE ON FUNCTION public.default_task_board(uuid) TO kritvia_app;

-- An extracted task or commitment becomes a card on the default board.
CREATE FUNCTION private.card_for_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b uuid; l uuid; pos double precision;
BEGIN
  b := private.ensure_default_board(NEW.org_id, NEW.venture_id);
  SELECT id INTO l FROM task_lists WHERE board_id = b AND is_done = (coalesce(NEW.status, 'open') = 'done')
   ORDER BY position LIMIT 1;
  IF l IS NULL THEN
    SELECT id INTO l FROM task_lists WHERE board_id = b ORDER BY position LIMIT 1;
  END IF;
  IF l IS NULL THEN RETURN NEW; END IF;   -- someone deleted every list: nothing to file it in
  SELECT coalesce(max(position), 0) + 1024 INTO pos FROM task_cards WHERE list_id = l;
  INSERT INTO task_cards (org_id, venture_id, board_id, list_id, position, due_date, fact_id, access_roles,
                          done_at, archived_at)
  VALUES (NEW.org_id, NEW.venture_id, b, l, pos, NEW.due_date, NEW.id, NEW.access_roles,
          CASE WHEN NEW.status = 'done' THEN now() END, CASE WHEN NEW.status = 'dropped' THEN now() END)
  ON CONFLICT (fact_id) WHERE fact_id IS NOT NULL DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER facts_card AFTER INSERT ON facts FOR EACH ROW
  WHEN (NEW.kind IN ('task', 'commitment')) EXECUTE FUNCTION private.card_for_fact();

-- Task status changed elsewhere (e.g. the API's facts endpoint): keep the card in step.
CREATE FUNCTION private.card_follows_fact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c task_cards; target uuid; in_done boolean;
BEGIN
  SELECT * INTO c FROM task_cards WHERE fact_id = NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT is_done INTO in_done FROM task_lists WHERE id = c.list_id;
  IF NEW.status = 'dropped' THEN
    UPDATE task_cards SET archived_at = coalesce(archived_at, now()), updated_at = now() WHERE id = c.id;
  ELSIF (NEW.status = 'done') IS DISTINCT FROM in_done THEN
    SELECT id INTO target FROM task_lists WHERE board_id = c.board_id AND is_done = (NEW.status = 'done')
     ORDER BY position LIMIT 1;
    IF target IS NOT NULL THEN
      UPDATE task_cards SET list_id = target, archived_at = NULL, updated_at = now(),
             done_at = CASE WHEN NEW.status = 'done' THEN now() END,
             position = (SELECT coalesce(max(position), 0) + 1024 FROM task_cards WHERE list_id = target)
       WHERE id = c.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facts_card_status AFTER UPDATE OF status ON facts FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.kind IN ('task', 'commitment'))
  EXECUTE FUNCTION private.card_follows_fact();

-- A card moved into / out of a done list (or archived) updates its extracted task.
CREATE FUNCTION private.fact_follows_card() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE in_done boolean; want text;
BEGIN
  IF NEW.fact_id IS NULL THEN RETURN NEW; END IF;
  SELECT is_done INTO in_done FROM task_lists WHERE id = NEW.list_id;
  want := CASE WHEN NEW.archived_at IS NOT NULL AND NOT in_done THEN 'dropped'
               WHEN in_done THEN 'done' ELSE 'open' END;
  UPDATE facts SET status = want WHERE id = NEW.fact_id AND status IS DISTINCT FROM want;
  RETURN NEW;
END $$;
CREATE TRIGGER task_cards_fact_status AFTER UPDATE OF list_id, archived_at ON task_cards FOR EACH ROW
  WHEN (NEW.fact_id IS NOT NULL) EXECUTE FUNCTION private.fact_follows_card();

-- People who can be assigned cards on a business: its members and the organisation's
-- org-wide members (owners), not service accounts.
CREATE FUNCTION public.venture_people(p_venture uuid)
RETURNS TABLE (user_id uuid, full_name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.id, u.full_name, u.email
    FROM ventures v
    JOIN memberships m ON m.org_id = v.org_id AND (m.venture_id = v.id OR m.venture_id IS NULL)
    JOIN users u ON u.id = m.user_id AND NOT u.is_service
   WHERE v.id = p_venture AND p_venture = ANY (private.readable_ventures())
   ORDER BY u.full_name
$$;
GRANT EXECUTE ON FUNCTION public.venture_people(uuid) TO kritvia_app;

-- Deleting a board or a list never loses cards, including ones the caller can't see
-- (role-restricted tasks): open cards block the delete; archived ones are re-filed.
CREATE FUNCTION public.delete_task_board(p_venture uuid, p_board uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b task_boards; n int; main_board uuid; main_list uuid;
BEGIN
  IF NOT (p_venture = ANY (private.writable_ventures())) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO b FROM task_boards WHERE venture_id = p_venture AND id = p_board FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'board not found' USING ERRCODE = '42501'; END IF;
  IF b.is_default THEN
    RAISE EXCEPTION 'the main Tasks board can''t be deleted; extracted tasks land there' USING ERRCODE = 'KV409';
  END IF;
  SELECT count(*) INTO n FROM task_cards WHERE board_id = p_board AND archived_at IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'move or archive its % card(s) first', n USING ERRCODE = 'KV409'; END IF;
  main_board := private.ensure_default_board(b.org_id, p_venture);
  SELECT id INTO main_list FROM task_lists WHERE board_id = main_board ORDER BY position LIMIT 1;
  IF main_list IS NULL AND EXISTS (SELECT 1 FROM task_cards WHERE board_id = p_board) THEN
    RAISE EXCEPTION 'add a list to the main board first; it keeps archived cards' USING ERRCODE = 'KV409';
  END IF;
  UPDATE task_cards SET board_id = main_board, list_id = main_list, updated_at = now() WHERE board_id = p_board;
  DELETE FROM task_boards WHERE id = p_board;
END $$;

CREATE FUNCTION public.delete_task_list(p_venture uuid, p_list uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l task_lists; n int; other uuid;
BEGIN
  IF NOT (p_venture = ANY (private.writable_ventures())) THEN
    RAISE EXCEPTION 'venture not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO l FROM task_lists WHERE venture_id = p_venture AND id = p_list FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'list not found' USING ERRCODE = '42501'; END IF;
  SELECT count(*) INTO n FROM task_cards WHERE list_id = p_list AND archived_at IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'move or archive its % card(s) first', n USING ERRCODE = 'KV409'; END IF;
  IF EXISTS (SELECT 1 FROM task_cards WHERE list_id = p_list) THEN
    SELECT id INTO other FROM task_lists WHERE board_id = l.board_id AND id <> p_list ORDER BY position LIMIT 1;
    IF other IS NULL THEN
      RAISE EXCEPTION 'this last list keeps the board''s archived cards; restore or move them first' USING ERRCODE = 'KV409';
    END IF;
    UPDATE task_cards SET list_id = other, updated_at = now() WHERE list_id = p_list;
  END IF;
  DELETE FROM task_lists WHERE id = p_list;
END $$;
GRANT EXECUTE ON FUNCTION public.delete_task_board(uuid, uuid), public.delete_task_list(uuid, uuid) TO kritvia_app;

-- Backfill: every existing extracted task gets a card.
INSERT INTO task_cards (org_id, venture_id, board_id, list_id, position, due_date, fact_id, access_roles, done_at, archived_at)
SELECT f.org_id, f.venture_id, b.id,
       (SELECT l.id FROM task_lists l WHERE l.board_id = b.id AND l.is_done = (coalesce(f.status, 'open') = 'done') ORDER BY l.position LIMIT 1),
       1024 * row_number() OVER (PARTITION BY f.venture_id ORDER BY f.created_at), f.due_date, f.id, f.access_roles,
       CASE WHEN f.status = 'done' THEN now() END, CASE WHEN f.status = 'dropped' THEN now() END
  FROM facts f
  CROSS JOIN LATERAL (SELECT private.ensure_default_board(f.org_id, f.venture_id) AS id) b
 WHERE f.kind IN ('task', 'commitment')
ON CONFLICT (fact_id) WHERE fact_id IS NOT NULL DO NOTHING;
