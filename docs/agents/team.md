# The agent team and starter kits

**Board → Team leads.** The board already puts every agent in a role (Front desk, Sales, Accounts,
Operations) with a monthly budget. Each role can now have a **lead** with a goal, e.g. "Every enquiry is
answered the same day and quiet leads hear from us every few days."

## What a lead does

On its check-in days (chosen weekdays at HH:MM, business time zone), or when someone presses **Check in**:

1. It runs the Kritvia assistant as the business's agent, with a brief: who it is, its goal, the agents
   switched on in its role, and what to do.
2. It looks over its area with the assistant's tools (business.numbers, leads, invoices, tasks, approvals
   waiting).
3. It does at most three useful things towards the goal. Every send, booking or change is a draft that
   waits for a yes, as always.
4. Work that belongs to another role goes to that role's lead with `team.handoff`.
5. It ends with a report of at most five lines: numbers first, then what it did, what waits for a yes and
   what it needs from the owner.

The report is kept (Team leads card, `GET /ventures/{v}/team/reports`), sent as a push, and, for a
check-in, sent to the linked Telegram or WhatsApp chat of the person who set the lead up.

## Guards

| Guard | Rule |
|---|---|
| Approvals | the lead uses the assistant's tools; write/send tools are drafts for a yes |
| Hand-offs | only to a lead that is switched on and within budget; at most 2 deep (`team:<role>:handoff:<n>`); at most 20 a day per business |
| Budget | a role's monthly token budget covers its agents and its lead (`role_usage`); a lead over budget doesn't check in and the card shows why |
| Cost on the board | each lead run is a ticket under its role ("Sales lead: check-in") |
| Roles | everyone who can see the business sees the team; admins set leads up; operators can ask for a check-in |

Per-role budgets come with the Starter plan, like per-agent budgets.

## API

```
GET   /ventures/{v}/team                    the four leads (goal, check-ins, budget, area, latest report)
PUT   /ventures/{v}/team/{role}             goal, enabled, weekdays, at_time, monthly_tokens (admins)
POST  /ventures/{v}/team/{role}/check-in    check in now, as you
GET   /ventures/{v}/team/reports?role=      recent reports
GET   /templates                            starter kits
POST  /ventures/{v}/templates/{key}/apply   add a kit (admins)
```

Migration 0056: `team_roles` (goal encrypted), `team_reports` (body encrypted), `claim_due_team`,
`set_team_next`, `role_usage`, `team_handoffs_today`. The worker's `fire_automations` job (every minute)
also starts due check-ins.

## Starter kits

**Board → Team leads → Starter kits.** One click adds the agents, automations, skills and leads' goals
that suit a kind of business, using only what Kritvia does today:

| Kit | Agents | Adds |
|---|---|---|
| Restaurant or cloud kitchen | Inbox, Kitchen daily, Reviews | nightly money report; bulk-order enquiry skill; Operations and Front desk leads |
| Clinic, salon or studio | Inbox, Booking reminders, Reviews | tomorrow's appointments each evening; after-visit follow-up; Front desk lead |
| Coaching institute | Inbox, Lead triage, WhatsApp follow-up, Collections | weekly admissions; demo-class invite; fee reminder; Sales and Accounts leads |
| CA or accounting firm | Inbox, Meeting digest, Collections | last month's fees; monthly documents request; fee follow-up; Accounts and Operations leads |
| Real estate broker | Inbox, Lead triage, WhatsApp follow-up | weekly pipeline; qualify a buyer; warm up quiet buyers; Sales lead |
| Online shop (D2C) | Inbox, WhatsApp follow-up, Reviews, Collections | today's sales; thank-you after payment; Front desk and Sales leads |
| Agency or software studio | Inbox, Lead triage, Meeting digest, Collections | Friday wrap-up; proposal follow-up; invoice reminder; Sales and Accounts leads |
| Loan agent or DSA | Inbox, Lead triage, Loan verification | today's files; document checklist; Sales and Operations leads |

Applying a kit never removes or overwrites anything: an automation or skill with the same name, an agent
already switched on, or a lead already set up is left alone, and applying twice adds nothing. Agents the
plan doesn't include are listed as left out, with the upgrade that includes them. A kit for a kind of
business (kitchen, software, finance) sets the business type when it was General, and says so.
Everything a kit adds can be changed or switched off afterwards.
