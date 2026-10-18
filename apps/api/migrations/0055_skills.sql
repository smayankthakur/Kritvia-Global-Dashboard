-- =============================================================================
-- 0055 Skills: jobs Kritvia learns, repeats and gets better at.
--
-- A skill is a job in plain words ("Send everyone whose invoice is a week overdue a polite WhatsApp
-- reminder and add a task for Ravi to call them"), done by the Kritvia assistant with all its tools and
-- the same approvals as everything else. It runs:
--   manual     when someone presses Run (or says /run <name> in their linked chat)
--   schedule   daily, on weekdays, or monthly at HH:MM in the business's time zone
--   event      once per record, checked daily at HH:MM: an invoice N days overdue, an invoice paid N days
--              ago, a booking done N days ago, a lead that came in N days ago, a lead quiet for N days
--
-- Skills learn: when a person edits one of a skill's drafts, or sends it back with a note, the change is
-- turned into a short lesson ("Address customers as Sir/Madam", "Never offer a discount") that every
-- later run is told. A skill keeps its last 8 lessons; people can read and remove them.
--
--   skills          instructions and lessons are encrypted with the business's key (they can name
--                   customers); name, trigger and counts are not.
--   claim_due_skills / set_skill_next   the worker's every-minute claim, like automations.
-- =============================================================================
CREATE TABLE skills (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  venture_id       uuid NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  instructions_enc bytea NOT NULL,
  lessons_enc      bytea,
  trigger          text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule', 'event')),
  freq             text CHECK (freq IN ('daily', 'weekly', 'monthly')),
  weekdays         int[] NOT NULL DEFAULT '{}' CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]),   -- 0 = Monday
  day_of_month     int CHECK (day_of_month BETWEEN 1 AND 28),
  at_time          text CHECK (at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  event            text CHECK (event IN ('invoice_overdue', 'invoice_paid', 'booking_done', 'lead_new', 'lead_quiet')),
  wait_days        int NOT NULL DEFAULT 0 CHECK (wait_days BETWEEN 0 AND 60),
  enabled          boolean NOT NULL DEFAULT true,
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  last_error       text CHECK (char_length(last_error) <= 300),
  runs             int NOT NULL DEFAULT 0,
  lessons          int NOT NULL DEFAULT 0,          -- how many lessons it has learned (ever)
  source_run_id    uuid,                            -- the assistant request it was saved from
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (trigger <> 'schedule' OR (freq IS NOT NULL AND at_time IS NOT NULL)),
  CHECK (trigger <> 'event' OR (event IS NOT NULL AND at_time IS NOT NULL)),
  CHECK (freq IS DISTINCT FROM 'weekly' OR cardinality(weekdays) > 0),
  CHECK (freq IS DISTINCT FROM 'monthly' OR day_of_month IS NOT NULL),
  FOREIGN KEY (org_id, venture_id) REFERENCES ventures(org_id, id) ON DELETE CASCADE
);
CREATE INDEX skills_due_idx ON skills (next_run_at) WHERE enabled;
CREATE UNIQUE INDEX skills_name_idx ON skills (venture_id, lower(btrim(name)));
SELECT private.protect_tenant_table('skills');
GRANT SELECT, INSERT, UPDATE, DELETE ON skills TO kritvia_app;

CREATE FUNCTION private.claim_due_skills(p_now timestamptz)
RETURNS TABLE (skill_id uuid, venture_id uuid, run_as uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE skills s SET next_run_at = NULL
   WHERE s.id IN (SELECT id FROM skills WHERE enabled AND trigger <> 'manual' AND next_run_at <= p_now
                   ORDER BY next_run_at LIMIT 200 FOR UPDATE SKIP LOCKED)
  RETURNING s.id, s.venture_id, private.provision_service_account(s.org_id, s.venture_id)
$$;
GRANT EXECUTE ON FUNCTION private.claim_due_skills(timestamptz) TO kritvia_app;

CREATE FUNCTION private.set_skill_next(p_id uuid, p_next timestamptz, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE skills SET next_run_at = p_next, last_error = p_error,
                    last_run_at = CASE WHEN p_error IS NULL THEN now() ELSE last_run_at END
   WHERE id = p_id
$$;
GRANT EXECUTE ON FUNCTION private.set_skill_next(uuid, timestamptz, text) TO kritvia_app;
