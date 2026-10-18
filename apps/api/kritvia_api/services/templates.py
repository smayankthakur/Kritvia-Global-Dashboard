"""Business templates: one-click starter kits by industry (roadmap item: agent team and templates).

Applying a kit switches on the right agents, adds automations (reports on a schedule), skills (jobs that
act, on events or on a schedule) and the team leads' goals, through the same rows as doing it by hand.
It never removes or overwrites anything: what already exists (same name, or an agent already set up) is
left as it is, and what the plan doesn't include is skipped with a reason. Everything added can be
changed or switched off afterwards. Each kit uses only things Kritvia does today.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text

from kritvia_api.services import automations as au
from kritvia_api.services import skills as sk
from kritvia_api.services import team as tm


KIND_TITLES = {"general": "General", "software": "Software", "finance": "Finance", "kitchen": "Kitchen",
               "trade": "Trade"}


@dataclass(frozen=True)
class Kit:
    key: str
    name: str
    description: str
    kind: str                                   # the business kind it suits (general fits any)
    agents: tuple[str, ...]
    automations: tuple[dict[str, Any], ...] = ()
    skills: tuple[dict[str, Any], ...] = ()
    leads: dict[str, str] = field(default_factory=dict)   # role -> goal; these leads are switched on


def _auto(name: str, said: str, task: str, period: str, freq: str, at: str, *, weekdays=(), day=None) -> dict[str, Any]:
    return {"name": name, "said": said, "task": task, "period": period, "freq": freq, "at_time": at,
            "weekdays": list(weekdays), "day_of_month": day}


KITS: dict[str, Kit] = {k.key: k for k in (
    Kit("restaurant", "Restaurant or cloud kitchen",
        "Answers customers and bulk-order enquiries, plans tomorrow's stock and purchase orders every night, "
        "and asks happy customers for reviews.",
        "kitchen", ("inbox_assistant", "kitchen_daily", "reviews"),
        automations=(_auto("Tonight's money", "Every night at 10:30 tell me today's money", "Money received today",
                           "today", "daily", "22:30"),),
        skills=({"name": "Bulk order enquiries", "trigger": "event", "event": "lead_new", "wait_days": 0, "at_time": "11:00",
                 "instructions": "1. Read the enquiry: how many people, which dishes, date and place.\n"
                                 "2. Price it only from our menu and rate card in memory; if something isn't there, ask.\n"
                                 "3. Draft a warm reply with the price, what's included and how to confirm."},),
        leads={"ops": "Tomorrow's stock and purchase orders are ready every night, with nothing wasted.",
               "front_desk": "Every customer message and review gets a kind reply the same day."}),
    Kit("clinic", "Clinic, salon or studio (appointments)",
        "Books appointments from chats, reminds customers the day before, follows up after the visit and asks "
        "for reviews.",
        "general", ("inbox_assistant", "booking_reminders", "reviews"),
        automations=(_auto("Tomorrow's appointments", "Every evening at 7 send me tomorrow's appointments",
                           "The list of tomorrow's bookings", "tomorrow", "daily", "19:00"),),
        skills=({"name": "After-visit follow-up", "trigger": "event", "event": "booking_done", "wait_days": 1, "at_time": "11:00",
                 "instructions": "1. Thank the customer for visiting.\n2. Ask if everything was fine and if they need anything.\n"
                                 "3. Offer to book their next visit. Keep it short and friendly."},),
        leads={"front_desk": "Every enquiry is answered within the hour, every slot is confirmed and reminded."}),
    Kit("coaching", "Coaching institute",
        "Replies to admission enquiries with course details and a demo-class invite, follows up quiet parents, "
        "and sends polite fee reminders.",
        "general", ("inbox_assistant", "lead_triage", "whatsapp_followup", "collections"),
        automations=(_auto("Weekly admissions", "Every Monday at 9 send me last week's new leads and fees",
                           "New leads and money received", "last_week", "weekly", "09:00", weekdays=(0,)),),
        skills=({"name": "Demo class invite", "trigger": "event", "event": "lead_new", "wait_days": 0, "at_time": "10:30",
                 "instructions": "1. Send the course details from our documents (batches, timings, fees).\n"
                                 "2. Invite them to a free demo class and offer two times this week."},
                {"name": "Fee reminder", "trigger": "event", "event": "invoice_overdue", "wait_days": 3, "at_time": "11:00",
                 "instructions": "1. Remind the parent politely about the pending fee, with the amount and due date.\n"
                                 "2. Include how to pay. Never sound harsh."}),
        leads={"sales": "Every admission enquiry gets details the same day and a demo-class invite.",
               "accounts": "Fees come in on time, with polite reminders."}),
    Kit("ca_firm", "CA or accounting firm",
        "Collects clients' documents every month, digests client meetings, and follows up unpaid fees.",
        "general", ("inbox_assistant", "meeting_digest", "collections"),
        automations=(_auto("Last month's fees", "On the 1st of every month tell me last month's fees",
                           "Money received and invoices issued last month", "last_month", "monthly", "09:00", day=1),),
        skills=({"name": "Monthly documents request", "trigger": "schedule", "freq": "monthly", "day_of_month": 2,
                 "at_time": "10:00",
                 "instructions": "1. Find our active clients in leads.\n2. Draft each one a short email asking for this "
                                 "month's bank statements and sales and purchase invoices, with the date we need them by.\n"
                                 "3. Add a task to check who has sent them by the 10th."},
                {"name": "Fee follow-up", "trigger": "event", "event": "invoice_overdue", "wait_days": 7, "at_time": "11:00",
                 "instructions": "1. Remind the client politely about the pending fee, with the invoice number and amount."}),
        leads={"accounts": "Fees are billed and collected on time.",
               "ops": "Every client's documents for the month are in by the 10th."}),
    Kit("real_estate", "Real estate broker",
        "Qualifies buyer enquiries, offers site visits, and keeps quiet buyers warm with matching properties.",
        "general", ("inbox_assistant", "lead_triage", "whatsapp_followup"),
        automations=(_auto("Weekly pipeline", "Every Monday at 9 send me last week's leads",
                           "New and won leads, and drafts waiting", "last_7_days", "weekly", "09:00", weekdays=(0,)),),
        skills=({"name": "Qualify a buyer", "trigger": "event", "event": "lead_new", "wait_days": 0, "at_time": "10:00",
                 "instructions": "1. Ask their budget, preferred area, size and when they want to move.\n"
                                 "2. Offer a site visit this week."},
                {"name": "Warm up quiet buyers", "trigger": "event", "event": "lead_quiet", "wait_days": 4, "at_time": "11:30",
                 "instructions": "1. Look up what the buyer wanted.\n2. Find 2-3 matching properties in our documents.\n"
                                 "3. Draft a short message sharing them and offering a visit."}),
        leads={"sales": "Every buyer enquiry is qualified the same day and quiet buyers hear from us every few days."}),
    Kit("d2c", "Online shop (D2C)",
        "Answers customer chats, thanks buyers after payment, follows up, and asks happy customers for reviews.",
        "general", ("inbox_assistant", "whatsapp_followup", "reviews", "collections"),
        automations=(_auto("Today's sales", "Every night at 9 tell me today's money", "Money received today",
                           "today", "daily", "21:00"),),
        skills=({"name": "Thank-you after payment", "trigger": "event", "event": "invoice_paid", "wait_days": 2, "at_time": "12:00",
                 "instructions": "1. Thank the customer for the order.\n2. Share one useful care or usage tip from our "
                                 "documents.\n3. Ask them to reply if anything is wrong."},),
        leads={"front_desk": "Every customer chat gets a helpful reply within the hour.",
               "sales": "Happy customers come back: thank-yous, follow-ups and offers go out on time."}),
    Kit("agency", "Agency or software studio",
        "Turns enquiries into priced proposals, follows up quiet leads, digests client meetings and chases invoices.",
        "software", ("inbox_assistant", "lead_triage", "meeting_digest", "collections"),
        automations=(_auto("Friday wrap-up", "Every Friday at 6 pm send me this week's pipeline and money",
                           "New and won leads, money received and overdue invoices", "last_7_days", "weekly", "18:00",
                           weekdays=(4,)),),
        skills=({"name": "Proposal follow-up", "trigger": "event", "event": "lead_quiet", "wait_days": 5, "at_time": "11:00",
                 "instructions": "1. Look up the lead and the proposal we sent.\n2. Draft a short, friendly follow-up that "
                                 "answers a likely question and offers a 15-minute call."},
                {"name": "Invoice reminder", "trigger": "event", "event": "invoice_overdue", "wait_days": 7, "at_time": "10:30",
                 "instructions": "1. Remind the client politely, with the invoice number, amount and how to pay."}),
        leads={"sales": "Every enquiry gets a priced proposal within a day and nobody goes quiet without a follow-up.",
               "accounts": "Invoices are paid within their terms."}),
    Kit("lender", "Loan agent or DSA",
        "Sends document checklists to new applicants, checks documents on the private model, and follows up "
        "what's missing.",
        "finance", ("inbox_assistant", "lead_triage", "loan_verification"),
        automations=(_auto("Today's files", "Every evening at 6:30 tell me today's leads and drafts",
                           "New leads and drafts waiting", "today", "daily", "18:30"),),
        skills=({"name": "Document checklist", "trigger": "event", "event": "lead_new", "wait_days": 0, "at_time": "10:00",
                 "instructions": "1. Find out which loan they want.\n2. Send the document checklist for it from our "
                                 "documents, and how to send the documents."},),
        leads={"sales": "Every applicant gets the checklist the same day.",
               "ops": "Every file is complete and checked within two days."}),
)}


def summary(k: Kit) -> dict[str, Any]:
    from kritvia_api.engine.core import registry
    return {"key": k.key, "name": k.name, "description": k.description, "kind": k.kind,
            "agents": [registry.get(a).title for a in k.agents if a in registry],
            "automations": [a["name"] for a in k.automations], "skills": [s["name"] for s in k.skills],
            "leads": [tm.TITLES[r] for r in k.leads]}


async def apply(db, keys, venture_id: uuid.UUID, org_id: uuid.UUID, user_id: uuid.UUID, k: Kit) -> dict[str, list[str]]:
    """Adds the kit to a business (as an admin, in the request's transaction). Returns what was added and
    what was skipped (and why)."""
    from kritvia_api.engine.core import registry
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.quota import PlanRestricted, require_agent
    from kritvia_api.routers.board import DEFAULT_ROLE
    added: dict[str, list[str]] = {"agents": [], "automations": [], "skills": [], "leads": [], "skipped": [],
                                   "notes": []}
    crypto = EnvelopeCrypto(db, keys)
    kind = (await db.execute(text("SELECT coalesce(kind, 'general') FROM venture_settings WHERE venture_id = :v"),
                             {"v": venture_id})).scalar() or "general"
    if kind == "general" and k.kind != "general":
        await db.execute(text("INSERT INTO venture_settings (venture_id, org_id, kind) VALUES (:v, :o, :k)"
                              " ON CONFLICT (venture_id) DO UPDATE SET kind = EXCLUDED.kind"),
                         {"v": venture_id, "o": org_id, "k": k.kind})
        kind = k.kind
        added["notes"].append(f"Business type set to {KIND_TITLES.get(k.kind, k.kind)} (it was General)")
    tz = await sk.tz_of(db, venture_id)
    now = datetime.now(UTC)

    for wf in k.agents:
        if wf not in registry:
            continue
        title = registry.get(wf).title
        try:
            await require_agent(db, venture_id, wf, kind)
        except PlanRestricted as exc:
            added["skipped"].append(f"{title}: {exc}")
            continue
        done = (await db.execute(text(
            "INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled, settings, instructions, role, updated_by)"
            " VALUES (:o, :v, :w, true, '{}'::jsonb, '', :role, :u) ON CONFLICT (venture_id, workflow) DO UPDATE SET enabled = true,"
            " updated_by = EXCLUDED.updated_by, updated_at = now() WHERE NOT workflow_configs.enabled RETURNING workflow"),
            {"o": org_id, "v": venture_id, "w": wf, "u": user_id,
                         "role": DEFAULT_ROLE.get(wf, "ops")})).first()
        if done:
            added["agents"].append(title)

    names = {n.lower() for n in (await db.execute(text("SELECT name FROM automations WHERE venture_id = :v"),
                                                  {"v": venture_id})).scalars().all()}
    for a in k.automations:
        if a["name"].lower() in names:
            continue
        if len(names) >= 25:
            added["skipped"].append(f"{a['name']}: a business can have up to 25 automations")
            continue
        nxt = au.next_run(a["freq"], a["weekdays"], a["day_of_month"], a["at_time"], tz, now)
        await db.execute(text(
            "INSERT INTO automations (org_id, venture_id, created_by, name, said, task, period, freq, weekdays,"
            " day_of_month, at_time, channel, recipients, next_run_at)"
            " VALUES (:o, :v, :u, :n, :s, :t, :p, :f, :w, :d, :at, 'email', '{}', :nx)"),
            {"o": org_id, "v": venture_id, "u": user_id, "n": a["name"], "s": a["said"], "t": a["task"], "p": a["period"],
             "f": a["freq"], "w": a["weekdays"], "d": a["day_of_month"], "at": a["at_time"], "nx": nxt})
        names.add(a["name"].lower())
        added["automations"].append(a["name"])

    names = {n.lower() for n in (await db.execute(text("SELECT name FROM skills WHERE venture_id = :v"),
                                                  {"v": venture_id})).scalars().all()}
    for s in k.skills:
        if s["name"].lower() in names:
            continue
        if len(names) >= sk.MAX_SKILLS:
            added["skipped"].append(f"{s['name']}: a business can have up to {sk.MAX_SKILLS} skills")
            continue
        d = sk.clean(sk.Draft(**s))
        await db.execute(text(
            "INSERT INTO skills (org_id, venture_id, created_by, name, instructions_enc, trigger, freq, weekdays,"
            " day_of_month, at_time, event, wait_days, next_run_at)"
            " VALUES (:o, :v, :u, :n, :i, :t, :f, :w, :dm, :at, :ev, :wd, :nx)"),
            {"o": org_id, "v": venture_id, "u": user_id, "n": d.name,
             "i": await crypto.encrypt(venture_id, sk.INSTRUCTIONS, d.instructions), "t": d.trigger, "f": d.freq,
             "w": d.weekdays, "dm": d.day_of_month, "at": d.at_time, "ev": d.event, "wd": d.wait_days,
             "nx": sk.next_time(d.model_dump(), tz, now)})
        names.add(d.name.lower())
        added["skills"].append(d.name)

    have = set((await db.execute(text("SELECT role FROM team_roles WHERE venture_id = :v"), {"v": venture_id})).scalars().all())
    for role, goal in k.leads.items():
        if role in have:
            continue
        t = {"weekdays": [0, 1, 2, 3, 4, 5], "at_time": "09:30"}
        await db.execute(text(
            "INSERT INTO team_roles (org_id, venture_id, role, goal_enc, enabled, next_run_at, created_by)"
            " VALUES (:o, :v, :r, :g, true, :nx, :u)"),
            {"o": org_id, "v": venture_id, "r": role, "g": await crypto.encrypt(venture_id, tm.GOAL, goal),
             "nx": tm.next_time(t, tz, now), "u": user_id})
        added["leads"].append(tm.TITLES[role])
    return added
