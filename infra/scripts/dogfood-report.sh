#!/usr/bin/env bash
# Stage 2 gate: has every dogfood workflow run on real data for 10 consecutive days?
#
#   sudo /opt/kritvia/infra/scripts/dogfood-report.sh [days-required]   (default 10)
#
# A day counts for a workflow when at least one run started that day (IST) and either
# completed or is waiting on a human approval (the agent did its part). Failed and
# cancelled runs never count. Prints one row per enabled workflow and venture, then the gate.
set -euo pipefail
cd "$(dirname "$0")/.."
NEED="${1:-10}"
[[ "$NEED" =~ ^[0-9]+$ ]] || { echo "usage: $0 [days-required]"; exit 1; }

docker compose exec -T postgres psql -U postgres -d kritvia -v need="$NEED" -X -q -P pager=off <<'SQL'
\pset border 2
\pset null '-'
WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
expected AS (
  SELECT v.slug AS venture, c.workflow, v.id AS venture_id
  FROM workflow_configs c JOIN ventures v ON v.id = c.venture_id
  WHERE c.enabled
),
days AS (
  SELECT r.venture_id, r.workflow, (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
         bool_or(r.status IN ('completed', 'waiting')) AS ok,
         count(*) AS runs,
         count(*) FILTER (WHERE r.status = 'failed') AS failed
  FROM workflow_runs r
  WHERE r.created_at > now() - interval '60 days'
  GROUP BY 1, 2, 3
),
good AS (
  SELECT venture_id, workflow, day,
         day - (row_number() OVER (PARTITION BY venture_id, workflow ORDER BY day))::int AS island
  FROM days WHERE ok
),
streaks AS (
  SELECT venture_id, workflow, count(*) AS len, max(day) AS last_day
  FROM good GROUP BY venture_id, workflow, island
),
per AS (
  SELECT e.venture, e.workflow,
         coalesce(max(s.len) FILTER (WHERE s.last_day >= (SELECT d FROM today) - 1), 0) AS streak,
         coalesce(max(s.len), 0) AS best,
         (SELECT max(day) FROM days d WHERE d.venture_id = e.venture_id AND d.workflow = e.workflow AND d.ok) AS last_good_day,
         (SELECT coalesce(sum(runs), 0) FROM days d WHERE d.venture_id = e.venture_id AND d.workflow = e.workflow
            AND d.day > (SELECT d FROM today) - 14) AS runs_14d,
         (SELECT coalesce(sum(failed), 0) FROM days d WHERE d.venture_id = e.venture_id AND d.workflow = e.workflow
            AND d.day > (SELECT d FROM today) - 14) AS failed_14d
  FROM expected e LEFT JOIN streaks s ON s.venture_id = e.venture_id AND s.workflow = e.workflow
  GROUP BY e.venture, e.workflow, e.venture_id
)
SELECT venture, workflow, streak AS "streak (days)", best AS "best", last_good_day AS "last good day",
       runs_14d AS "runs 14d", failed_14d AS "failed 14d",
       CASE WHEN streak >= :need THEN 'met' ELSE (:need - streak) || ' to go' END AS "10-day gate"
FROM per ORDER BY venture, workflow;

-- The gate is per workflow: the best venture's streak counts (meeting_digest runs in two ventures).
WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d),
wf AS (SELECT DISTINCT c.workflow FROM workflow_configs c WHERE c.enabled),
good AS (
  SELECT r.venture_id, r.workflow, (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS day
  FROM workflow_runs r WHERE r.status IN ('completed', 'waiting') AND r.created_at > now() - interval '60 days'
  GROUP BY 1, 2, 3
),
isl AS (
  SELECT venture_id, workflow, day, day - (row_number() OVER (PARTITION BY venture_id, workflow ORDER BY day))::int AS island
  FROM good
),
cur AS (
  SELECT workflow, max(n) AS streak FROM (
    SELECT workflow, count(*) AS n, max(day) AS last_day FROM isl GROUP BY venture_id, workflow, island
  ) x WHERE last_day >= (SELECT d FROM today) - 1 GROUP BY workflow
)
SELECT CASE WHEN count(*) = 0 THEN 'STAGE 2 GATE: no workflows are enabled'
            WHEN count(*) FILTER (WHERE coalesce(cur.streak, 0) >= :need) = count(*)
            THEN 'STAGE 2 GATE: MET (' || count(*) || ' of ' || count(*) || ' workflows)'
            ELSE 'STAGE 2 GATE: not yet (' || count(*) FILTER (WHERE coalesce(cur.streak, 0) >= :need)
                 || ' of ' || count(*) || ' workflows have ' || :need || ' consecutive days)'
       END AS result
FROM wf LEFT JOIN cur USING (workflow);
SQL
