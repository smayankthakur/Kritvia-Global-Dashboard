"""Skills: jobs Kritvia learns, repeats and gets better at (migration 0055).

A skill is a job in plain words, done by the Kritvia assistant (all its tools, the same approvals). It
runs on demand, on a schedule, or once per record when something happens (an invoice N days overdue,
an invoice paid, a booking done, a new lead, a quiet lead). When a person edits one of its drafts or
sends it back with a note, the model turns that into one short lesson every later run is told.

  understand(words)        plain words -> a draft skill (name, steps, when it runs) for the person to check
  from_request(request)    a request that worked -> a draft skill ("Save as a skill")
  compose(...)             the request the assistant gets: the steps, the lessons, the record
  start(...)               one assistant run for a skill
  fire_due(services)       worker, every minute: scheduled skills, and event skills' daily check
  learn(...)               an edit or a note -> a lesson on the skill
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.services import automations as au
from kritvia_api.services import custom_workflows as cw

log = logging.getLogger(__name__)
INSTRUCTIONS = "skills.instructions"
LESSONS = "skills.lessons"
MAX_LESSONS = 8
MAX_SKILLS = 25
PER_EVENT_CHECK = 25
EVENTS = tuple(cw.TRIGGERS)


class Draft(BaseModel):
    """What the model makes of the person's words (they check and change it before saving)."""
    name: str = Field(max_length=80, description="a short name, 2-6 words, e.g. 'Overdue invoice reminders'")
    instructions: str = Field(max_length=2000, description="the job as numbered steps in plain words, in the "
                                                           "person's language; general (no one-off names or dates "
                                                           "unless the job is always about them)")
    trigger: Literal["manual", "schedule", "event", "on_event"] = "manual"
    freq: Literal["daily", "weekly", "monthly"] | None = None
    weekdays: list[int] = Field(default_factory=list, description="0 = Monday … 6 = Sunday (weekly only)")
    day_of_month: int | None = Field(default=None, description="1-28 (monthly only)")
    at_time: str | None = Field(default=None, description="HH:MM, 24-hour, in the business's time zone")
    event: Literal["invoice_overdue", "invoice_paid", "booking_done", "lead_new", "lead_quiet"] | None = None
    wait_days: int = Field(default=0, ge=0, le=60)
    on_event: str | None = Field(default=None, description="for trigger on_event: what it starts right after, e.g. "
                                                           "invoice.paid, lead.new, booking.done, review.new")


def describe(s: dict[str, Any]) -> str:
    """When a skill runs, in words."""
    if s["trigger"] == "schedule":
        if s["freq"] == "weekly":
            days = ", ".join(au.WEEKDAYS[d] for d in sorted(s.get("weekdays") or []))
            return f"Every {days} at {s['at_time']}"
        if s["freq"] == "monthly":
            return f"On day {s['day_of_month']} of every month at {s['at_time']}"
        return f"Every day at {s['at_time']}"
    if s["trigger"] == "event":
        return f"{cw.describe(s['event'], int(s.get('wait_days') or 0))} (checked daily at {s['at_time']})"
    if s["trigger"] == "on_event":
        from kritvia_api.services.events import describe as words
        return f"Right after: {words(str(s.get('on_event') or '')).lower()}"
    return "When you run it"


def clean(d: Draft) -> Draft:
    """Make a model's (or a form's) draft consistent; raises ValueError for what can't be fixed."""
    d.name = " ".join(d.name.split())[:80]
    d.instructions = d.instructions.strip()[:2000]
    if not d.name or len(d.instructions) < 5:
        raise ValueError("a skill needs a name and its steps")
    if d.trigger == "manual":
        d.freq, d.weekdays, d.day_of_month, d.at_time, d.event, d.wait_days = None, [], None, None, None, 0
        d.on_event = None
        return d
    if d.trigger == "on_event":
        from kritvia_api.services.events import KINDS
        if d.on_event not in KINDS:
            raise ValueError("say what it should start right after: " + ", ".join(sorted(KINDS)))
        d.freq, d.weekdays, d.day_of_month, d.at_time, d.event, d.wait_days = None, [], None, None, None, 0
        return d
    d.on_event = None
    hh_mm = (d.at_time or "").strip()
    try:
        hh, mm = (int(x) for x in hh_mm.split(":"))
        assert 0 <= hh < 24 and 0 <= mm < 60
        d.at_time = f"{hh:02d}:{mm:02d}"
    except (ValueError, AssertionError):
        d.at_time = "09:00"
    if d.trigger == "schedule":
        d.event, d.wait_days = None, 0
        d.freq = d.freq or "daily"
        d.weekdays = sorted({w for w in d.weekdays if 0 <= w <= 6})
        if d.freq == "weekly" and not d.weekdays:
            d.weekdays = [0]
        if d.freq != "weekly":
            d.weekdays = []
        if d.freq == "monthly":
            d.day_of_month = min(max(int(d.day_of_month or 1), 1), 28)
        else:
            d.day_of_month = None
        return d
    if d.event not in EVENTS:
        raise ValueError("say what should start it: an overdue or paid invoice, a booking done, or a new or quiet lead")
    d.freq, d.weekdays, d.day_of_month = None, [], None
    return d


def next_time(s: dict[str, Any], tz: ZoneInfo, after: datetime) -> datetime | None:
    if s["trigger"] == "schedule":
        return au.next_run(s["freq"], s.get("weekdays") or [], s.get("day_of_month"), s["at_time"], tz, after)
    if s["trigger"] == "event":
        return au.next_run("daily", [], None, s["at_time"], tz, after)
    return None


SYSTEM = ("You turn a person's words into a repeatable job for a small business's assistant. The assistant can look "
          "things up (numbers, invoices, leads, tasks, bookings, documents, connected apps) and draft emails, WhatsApp "
          "messages, meetings, tasks and new leads, which a person approves. Write the job as short numbered steps in "
          "the person's language. Keep it general: it will run many times. Say when it runs only if the person said "
          "so: a schedule (daily / weekly on weekdays / monthly, at a time), an event checked daily (invoice_overdue, "
          "invoice_paid, booking_done, lead_new, lead_quiet, with wait_days), or right after something happens "
          "(trigger on_event, with on_event one of: invoice.paid, invoice.issued, payment.received, lead.new, lead.won, "
          "booking.new, booking.done, booking.cancelled, bill.new, review.new, candidate.new). Otherwise trigger is "
          "manual.")


async def understand(router, call_ctx, words: str) -> Draft:
    from kritvia_api.services.llm import complete_json
    d = await complete_json(router, call_ctx, tier="extract", schema=Draft, system=SYSTEM,
                       prompt=f"The person said:\n{words.strip()[:1500]}\n\nMake the job.")
    return clean(d)


async def from_request(router, call_ctx, request: str, steps: list[dict[str, Any]]) -> Draft:
    from kritvia_api.services.llm import complete_json
    used = ", ".join(sorted({str(s.get("tool")) for s in steps if s.get("tool")})) or "none"
    d = await complete_json(router, call_ctx, tier="extract", schema=Draft, system=SYSTEM,
                       prompt=(f"The person asked the assistant once:\n{request.strip()[:1500]}\n\nIt used these tools: {used}.\n"
                               "Turn it into a job that can be done again, the same way, any time. Trigger: manual unless "
                               "the request itself says when."))
    return clean(d)


def compose(name: str, instructions: str, lessons: list[str], record: dict[str, Any] | None = None) -> str:
    """The assistant's request for one run of a skill (kept under the assistant's 4,000 characters)."""
    parts = [f"Do the job \"{name}\":\n{instructions.strip()[:2000]}"]
    if lessons:
        parts.append("Lessons from earlier runs (follow them):\n" + "\n".join(f"- {x[:200]}" for x in lessons[-MAX_LESSONS:]))
    if record:
        facts = "\n".join(f"- {k}: {v}" for k, v in record.items() if v not in (None, ""))
        parts.append("This run is about:\n" + facts[:600])
    return "\n\n".join(parts)[:3990]


# ------------------------------------------------------------------- storage --
async def create(conn, crypto, *, org_id: uuid.UUID, venture_id: uuid.UUID, created_by: uuid.UUID, d: Draft,
                 enabled: bool = True, source_run_id: uuid.UUID | None = None) -> uuid.UUID:
    """Saves a checked draft as a skill (the Skills page, and routines the assistant sets up after a yes)."""
    tz = await tz_of(conn, venture_id)
    nxt = next_time(d.model_dump(), tz, datetime.now(UTC)) if enabled else None
    enc = await crypto.encrypt(venture_id, INSTRUCTIONS, d.instructions)
    return (await conn.execute(text(
        "INSERT INTO skills (org_id, venture_id, created_by, name, instructions_enc, trigger, freq, weekdays,"
        " day_of_month, at_time, event, wait_days, on_event, enabled, next_run_at, source_run_id)"
        " VALUES (:o, :v, :u, :n, :i, :t, :f, :w, :dm, :at, :ev, :wd, :oe, :en, :nx, :src) RETURNING id"),
        {"o": org_id, "v": venture_id, "u": created_by, "n": d.name, "i": enc, "t": d.trigger, "f": d.freq,
         "w": d.weekdays, "dm": d.day_of_month, "at": d.at_time, "ev": d.event, "wd": d.wait_days, "oe": d.on_event,
         "en": enabled, "nx": nxt, "src": source_run_id})).scalar_one()


async def load(conn, crypto, venture_id: uuid.UUID, skill_id: uuid.UUID) -> dict[str, Any] | None:
    r = (await conn.execute(text("SELECT * FROM skills WHERE id = :s AND venture_id = :v"),
                            {"s": skill_id, "v": venture_id})).first()
    if r is None:
        return None
    s = dict(r._mapping)
    s["instructions"] = await crypto.decrypt_str(venture_id, INSTRUCTIONS, r.instructions_enc) or ""
    raw = await crypto.decrypt_str(venture_id, LESSONS, r.lessons_enc) if r.lessons_enc else None
    try:
        s["lesson_list"] = [str(x) for x in json.loads(raw or "[]")][-MAX_LESSONS:]
    except ValueError:
        s["lesson_list"] = []
    return s


async def tz_of(conn, venture_id: uuid.UUID) -> ZoneInfo:
    name = (await conn.execute(text("SELECT timezone FROM venture_settings WHERE venture_id = :v"),
                               {"v": venture_id})).scalar()
    try:
        return ZoneInfo(name or "Asia/Kolkata")
    except Exception:
        return ZoneInfo("Asia/Kolkata")


async def start(services, s: dict[str, Any], *, actor_user_id: uuid.UUID, actor_type: str, trigger_kind: str,
                record: tuple[str, uuid.UUID, dict[str, Any]] | None = None, dedupe: tuple[str, str] | None = None,
                reply_to: dict[str, Any] | None = None) -> uuid.UUID:
    """One assistant run doing the skill. `record` = (kind, id, facts) for event skills."""
    from kritvia_api.engine.runner import start_run
    inp: dict[str, Any] = {"request": compose(s["name"], s["instructions"], s.get("lesson_list") or [],
                                              record[2] if record else None),
                           "skill_id": str(s["id"])}
    if record:
        inp["record"] = {"kind": record[0], "id": str(record[1])}
    if reply_to:
        inp["reply_to"] = reply_to
    run_id = await start_run(services, actor_user_id=actor_user_id, actor_type=actor_type, venture_id=s["venture_id"],
                             workflow="assistant", input=inp, trigger_kind=trigger_kind, dedupe=dedupe,
                             trigger_ref=f"skill:{s['id']}", title=f"Skill: {s['name']}"[:140])
    from kritvia_api.db.session import tenant_tx
    async with tenant_tx(actor_user_id, actor_type, "skill" if actor_type != "user" else None) as conn:  # type: ignore[arg-type]
        await conn.execute(text("UPDATE skills SET runs = runs + 1 WHERE id = :s"), {"s": s["id"]})
    return run_id


async def fire_due(services, now: datetime | None = None) -> int:
    """Worker, every minute: run scheduled skills, and check event skills' records (each record once)."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.engine.runner import DuplicateTrigger
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.quota import PlanRestricted
    now = now or datetime.now(UTC)
    async with tenant_tx(None, "system") as conn:
        due = (await conn.execute(text("SELECT * FROM private.claim_due_skills(:n)"), {"n": now})).all()
    started = 0
    for d in due:
        error = None
        async with tenant_tx(d.run_as, "agent", "skill") as conn:
            s = await load(conn, EnvelopeCrypto(conn, services.keys), d.venture_id, d.skill_id)
            tz = await tz_of(conn, d.venture_id)
            records: list[uuid.UUID] = []
            if s is not None and s["trigger"] == "event":
                records = (await cw.candidates(conn, d.venture_id, s["event"], int(s["wait_days"]), False))[:PER_EVENT_CHECK]
                facts = [await cw.record_facts(conn, d.venture_id, cw.RECORD[s["event"]], rid) for rid in records]
        if s is None or not s["enabled"]:
            continue
        try:
            if s["trigger"] == "schedule":
                await start(services, s, actor_user_id=d.run_as, actor_type="agent", trigger_kind="schedule",
                            dedupe=("skill", f"{s['id']}:{now:%Y%m%d%H%M}"))
                started += 1
            else:
                for rid, (f, _, _) in zip(records, facts, strict=True):
                    try:
                        await start(services, s, actor_user_id=d.run_as, actor_type="agent", trigger_kind="schedule",
                                    record=(cw.RECORD[s["event"]], rid, f), dedupe=("skill", f"{s['id']}:{rid}"))
                        started += 1
                    except DuplicateTrigger:
                        continue
        except DuplicateTrigger:
            pass
        except PlanRestricted as exc:
            error = str(exc)[:300]
        except Exception as exc:  # noqa: BLE001
            log.exception("skill %s didn't start", d.skill_id)
            error = f"didn't start ({type(exc).__name__})"
        async with tenant_tx(None, "system") as conn:
            await conn.execute(text("SELECT private.set_skill_next(:s, :n, :e)"),
                               {"s": d.skill_id, "n": next_time(s, tz, now), "e": error})
    return started


# ------------------------------------------------------------------ learning --
class Lesson(BaseModel):
    lesson: str = Field(max_length=200, description="one short instruction for next time, in the person's language; "
                                                    "empty if the change was a one-off (a typo, a date)")


async def learn(ctx, skill_id: str, *, tool: str, draft: dict[str, Any] | None, final: dict[str, Any] | None,
                comment: str | None) -> str | None:
    """A person edited or sent back one of a skill's drafts: keep what it teaches as a lesson."""
    def short(p: dict[str, Any] | None) -> str:
        return json.dumps({k: v for k, v in (p or {}).items() if k in ("to", "subject", "body", "title", "params", "summary",
                                                                         "name", "status", "due", "person")},
                          ensure_ascii=False, default=str)[:1500]
    prompt = (f"A business's assistant drafted this ({tool}):\n{short(draft)}\n\n"
              + (f"The person changed it to:\n{short(final)}\n\n" if final else "")
              + (f"Their note: {comment.strip()[:500]}\n\n" if comment and comment.strip() else "")
              + "What should the assistant do differently every time from now on? One short instruction, or empty if "
                "this was a one-off correction.")
    try:
        out = await ctx.llm_json(tier="extract", schema=Lesson, system="You learn a small business's preferences from "
                                 "the corrections they make. Never include customers' private details in a lesson.",
                                 prompt=prompt)
        lesson = " ".join(out.lesson.split())[:200]
    except Exception:  # noqa: BLE001 - learning is a bonus; a note still teaches something
        lesson = " ".join((comment or "").split())[:200]
    if not lesson:
        return None
    async with ctx.tx() as conn:
        crypto = ctx.crypto(conn)
        s = await load(conn, crypto, ctx.venture_id, uuid.UUID(skill_id))
        if s is None:
            return None
        items = [x for x in s["lesson_list"] if x.lower() != lesson.lower()] + [lesson]
        enc = await crypto.encrypt(ctx.venture_id, LESSONS, json.dumps(items[-MAX_LESSONS:], ensure_ascii=False))
        await conn.execute(text("UPDATE skills SET lessons_enc = :l, lessons = lessons + 1, updated_at = now()"
                                " WHERE id = :s AND venture_id = :v"), {"l": enc, "s": s["id"], "v": ctx.venture_id})
    return lesson
