# Skills: jobs Kritvia learns, repeats and gets better at

**Automations → Skills.** A skill is a job in plain words, done by the Kritvia assistant with all its tools
and the same approvals as everything else. Examples:

- "When an invoice is 7 days overdue, WhatsApp the customer a polite reminder and add a task for Ravi to call them"
- "Every Friday at 6 pm, tell me which leads went quiet this week and draft a follow-up for each"
- "Har booking ke 2 din baad customer se Google review maango"

## Making one

- **From words:** type the job; the model (extract tier) drafts a name, numbered steps and when it runs. The
  person checks and changes everything in the form before saving. Nothing is saved until then.
- **From a request that worked:** on the Assistant page, a finished request that did something has **Save as a
  skill**. The model turns that request into a general job (only the person's own requests can be read).
- **By hand:** Write one.

A business can have up to 25 skills; names are unique (ignoring case).

## When a skill runs

| Trigger | Runs |
|---|---|
| manual | when someone presses Run now, or sends `/run <name>` in their linked Telegram or WhatsApp chat |
| schedule | daily, on chosen weekdays, or on day 1–28 of the month, at HH:MM in the business's time zone |
| event | checked daily at HH:MM: once per invoice N days overdue, invoice paid N days ago, booking done N days ago, lead that came in N days ago, or lead quiet for N days (the same queries as custom workflows, at most 25 records per check) |

Each run is an assistant request: the skill's steps, its lessons, and, for an event, the record's facts
(customer, amounts, dates). Runs carry `trigger_ref = skill:<id>`, so a skill's page lists its runs; an
event skill never starts twice for the same record (`dedupe = skill:<id>:<record>`). The worker's
`fire_automations` claims due skills every minute (`private.claim_due_skills`), like automations.

## Learning

When a person **edits** one of a skill's drafts before approving it, or **sends it back with a note**, the
model is shown the draft, the change and the note and writes one short instruction for next time (or nothing,
for a one-off fix such as a typo or a date). Without a model answer, the note itself is the lesson. A skill
keeps its last 8 lessons (encrypted with the business's key); every later run is told them. People who can
change the skill can read and forget lessons.

## Who can do what

Everyone in the business sees its skills. People who can change things there (operators, admins) make and run
skills; approvers can't. Only the person who made a skill, or an admin, changes, switches off or removes it,
or forgets its lessons.

Code: `services/skills.py`, `routers/skills.py`, `workflows/assistant.py` (`_learn`), worker
`fire_automations`. Migration `0055_skills.sql`. Tests: `tests/test_skills.py`, `tests/test_front_door.py`.
