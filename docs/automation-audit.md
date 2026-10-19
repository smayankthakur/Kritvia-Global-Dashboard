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
