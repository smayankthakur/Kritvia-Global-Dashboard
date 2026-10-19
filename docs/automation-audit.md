# Automation audit

How much of a small business Kritvia runs by itself, checked against the code, plus what each business's agents
actually did.

## The ladder

| Level | Name | Meaning |
|---|---|---|
| 0 | Not in Kritvia | done by hand or in another tool |
| 1 | Kept in Kritvia | Kritvia records it; a person does the work |
| 2 | AI when asked | the AI does it when a person starts it |
| 3 | Autopilot, with a yes | starts by itself (clock, message, call); a person approves what goes out |
| 4 | Runs by itself | starts and finishes by itself inside guardrails (internal output, or earned trust) |

Each job also has a **ceiling** (calls, loan papers, web forms and money keep a person in the loop) and a
**target** (where an AI-run operating system should take it next, with the step that gets it there).

## Where it lives

- `apps/api/kritvia_api/automation_audit/catalogue.py`: the business jobs, their level, ceiling, target, evidence
  pointers into the code, and the platform capabilities.
- `audit.py`: resolves every pointer (workflows, tools, API routes, worker cron jobs, code), checks each level is
  earned (level 3+ must start by itself), finds agents or tools nobody classified, and scores it.
- `live.py` and `GET /ventures/{id}/automation-health?days=30` (admins): per agent, whether it can run
  (`ready`, `off`, `not_on_plan`, `on_no_time`, `on_no_source`), runs, outcomes, drafts approved / edited /
  rejected / sent by itself / expired, and plain-words findings. Read-only.
- `GET /automation/scorecard`: the catalogue report from the running API.
- `tests/test_automation_audit.py`: fails when a pointer stops resolving, a level isn't earned, a new agent or
  tool isn't classified, a job drops below `baseline.json`, or an agent can look on and never run.

## Every morning, and before drafts expire

- `self_check` (worker, 08:40 IST): the health check of the last 7 days for every business with an agent on.
  What needs a person (an agent on but unable to run, runs with nothing to work with, drafts waiting or expired,
  failures) goes to the owners and admins: a push, Telegram for those who linked it, email for the others. It is
  sent again only when something new turns up, or once a week while it lasts (`automation_checks`). Ideas such
  as "this agent can send by itself now" ride along.
- `nudge_expiring` (worker, every 30 minutes): drafts that expire within 6 hours and nobody was told about. One
  message per business; Telegram approvers get the cards again with their buttons (`approvals.nudged_at`).
- The Agents page shows the same check ("Automation check, last 7 days") to admins.

## Earned trust and invoices drafted by themselves (0061)

- An agent asks for trust the moment it earns it. Each yes without a change adds to its clean streak for that
  kind of action (an edit or a rejection resets it). When the streak reaches the business's threshold (30 by
  default) the owners and admins are asked once, by push, Telegram or email: "Proposals asks: may it send
  emails by itself?" (`services/trust_ask.py`, audit event `autonomy.asked`). The Trust page shows the same ask
  with a one-tap "Let it". Sensitive drafts, prices it isn't sure of and plans without autonomy still wait.
- A booking marked done (for a service with a price) and a lead marked won (with a sent proposal, which becomes
  accepted) draft an invoice by themselves (database triggers `bookings_done_invoice`, `leads_won_invoice`,
  `proposals_accepted_invoice`; one draft per booking and per proposal). A draft is not owed: it isn't in the
  totals, isn't reminded and has no payment page until a person presses Issue on the Invoices page, which dates
  it today (and, for an old draft, makes it due a week later). Discarding a draft cancels it.
- The morning check lists drafts waiting to be issued.

## Run it

```
cd apps/api
python -m kritvia_api.automation_audit                 # scorecard (markdown), problems on stderr, exit 1 if any
python -m kritvia_api.automation_audit --json out.json
python -m kritvia_api.automation_audit --write-baseline   # after raising a level on purpose
```

## Rules it enforces

- Agents that run on a clock declare `default_schedule`; switching one on without a time gives it that time
  (Agents page, starter kits). Only clock agents may have a time: the API refuses a time for an agent that starts
  on messages, uploads or requests, and the worker skips old rows that have one.
- Drafts that went out by themselves (`auto_approved`) count as approved in analytics and automation reports.

## Adding an agent or tool

Add it to a job's `evidence` in `catalogue.py` (or a new job), then run the tests. If a job's level went up,
run `--write-baseline`.
