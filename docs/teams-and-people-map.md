# Teams, and who works with whom

Patch 0069. Owners group the organisation's people into **teams**; a **project board** (Tasks) can
belong to a team; and the **Mind map** has a second view, **People & projects**, that shows who works
with whom, on which projects and in which teams, and why each link is there.

## Teams (`/teams`, owner menu)

- A team has a name, an optional description, a colour (one of 8 from the validated chart palette,
  stepped for light and dark) and members; any member can be marked **lead**.
- Teams belong to the organisation, so they span its businesses. Everyone in the organisation can
  see them (`GET /orgs/{org}/teams`); only owners create, change or delete them.
- Only people in the organisation can join (database trigger); someone who leaves the organisation
  leaves its teams. Deleting a team keeps its boards, without a team.
- A board's team is set in **Tasks → Board settings → Team** (not on the main "Tasks" board).

## People & projects (`/v/<id>/map?view=people`)

Built by `GET /ventures/{id}/collab` (`kritvia_api/services/collab.py`) from what the viewer can
already see (row-level security does the hiding):

| Evidence | Counts as |
| --- | --- |
| Shared project tasks | Both have cards on the same project board in the period (the main Tasks board doesn't count: everyone's work lands there). Per board, the smaller of the two counts. |
| Handoffs | One person made a card and assigned it to the other (any board). |
| Meetings & emails | Both are named in the same meeting, email or document: people the knowledge graph's facts and links are about, and task owners. Names are matched to the organisation's people by full name, email, or a first name only one person has; anyone else is an **outside contact**. A document naming more than 15 people makes no pairs. Projects named in documents are matched to boards by name. |
| Same team | Both are in one of the organisation's teams. |

Strength of a pair = shared tasks + 2 × handoffs + 2 × meetings/emails/documents + 1 for a shared team.
It only sets line thickness and order; the panel always lists the reasons. There is no score for a
person.

Filters: **project** (its people, its team, and only evidence about it), **team** (its members, its
boards' people, and people outside it who work with members, drawn with a dashed ring), **period**
(30 days to 12 months), and which **evidence** counts. **Show as a list** gives the same pairs as a
table. Click a person (who they work with and why, their projects and teams), a project or team (its
people, the closest pairs, outside collaborators, "Show only this…"), or a line (the shared projects,
tasks, handoffs and the latest meetings/emails naming both, with links).

Shapes: person = filled circle in their first team's colour, with initials (a ring for team leads);
outside contact = dashed hollow circle; project = rounded square; team = hexagon. Lines: solid =
work together (thicker = more), dashed = on a project, dotted = in a team.

Code: `migrations/0052_teams.sql`, `kritvia_api/routers/teams.py`, `kritvia_api/services/collab.py`,
`task_boards.py` (`team_id`); web `app/(app)/teams`, `components/knowledge/team-map.tsx`,
`lib/collab.ts`, `app/(app)/v/[ventureId]/map/page.tsx`, board settings in
`components/tasks/task-board.tsx`. Tests: `apps/api/tests/test_teams.py`,
`apps/web/tests/collab.test.ts`, `apps/web/e2e/team-map.spec.ts`.
