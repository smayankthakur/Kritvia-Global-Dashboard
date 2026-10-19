"""People: hiring (jobs and the CVs that come in) and attendance (staff checking in on WhatsApp).

Hiring: a CV is added from an upload on the People page or from an email forwarded to the business's Kritvia
address with the role's code (JOB-XXXX) in the subject, or "application", "resume" or "CV" while only one role is
open. The text is encrypted; the Hiring agent (workflows/hiring.py) screens it.

Attendance: a staff member sends IN (or "aa gaya", "check in") and OUT ("ja raha", "check out") to the business's
WhatsApp number. Kritvia notes the time and answers. Anything else they write is an ordinary message.
"""
from __future__ import annotations

import calendar
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import text

from kritvia_api.workflows.common import IST

log = logging.getLogger(__name__)
JOB_CODE = re.compile(r"\bJOB-([0-9A-Z]{4})\b", re.I)
APPLICATION = re.compile(r"\b(application|applying|apply|resume|résumé|cv|biodata|job)\b", re.I)
CV_FILES = (".pdf", ".docx")
CHECK_IN = re.compile(r"^\s*(in|check\s*-?\s*in|checkin|aa\s*gaya|aagaya|aa\s*gayi|pahunch\s*gaya|pahunch\s*gayi|"
                      r"reached|present|आ\s*गया|आ\s*गई|पहुंच\s*गया)\s*[.!]*\s*$", re.I)
CHECK_OUT = re.compile(r"^\s*(out|check\s*-?\s*out|checkout|ja\s*raha|ja\s*rahi|nikal\s*raha|leaving|bye|"
                       r"जा\s*रहा|जा\s*रही)\s*[.!]*\s*$", re.I)
LATE_AFTER = timedelta(minutes=15)


def new_code() -> str:
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    return "JOB-" + "".join(secrets.choice(alphabet) for _ in range(4))


async def add_candidate(services, conn, *, org_id: uuid.UUID, venture_id: uuid.UUID, job_id: uuid.UUID, name: str,
                        email: str | None, phone: str | None, source: str, cv_text: str, file_name: str | None
                        ) -> uuid.UUID | None:
    """A candidate with an encrypted CV, or None when the same person already applied for this role."""
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.workflows.hiring import CV_PURPOSE
    enc = await EnvelopeCrypto(conn, services.keys).encrypt(venture_id, CV_PURPOSE, cv_text[:60000])
    return (await conn.execute(text(
        "INSERT INTO candidates (org_id, venture_id, job_id, name, email, phone, source, cv_enc, file_name)"
        " VALUES (:o, :v, :j, :n, :e, :p, :s, :cv, :f) ON CONFLICT DO NOTHING RETURNING id"),
        {"o": org_id, "v": venture_id, "j": job_id, "n": (name or "Applicant").strip()[:160] or "Applicant",
         "e": (email or "").strip().lower()[:254] or None, "p": (phone or "")[:24] or None, "s": source,
         "cv": enc, "f": (file_name or "")[:200] or None})).scalar()


async def screen(services, *, actor_user_id: uuid.UUID, actor_type: str, venture_id: uuid.UUID,
                 candidate_id: uuid.UUID, name: str) -> uuid.UUID | None:
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    from kritvia_api.services.quota import PlanRestricted
    try:
        return await start_run(services, actor_user_id=actor_user_id, actor_type=actor_type, venture_id=venture_id,
                               workflow="hiring", input={"candidate_id": str(candidate_id)},
                               trigger_kind="upload" if actor_type == "user" else "email",
                               dedupe=("candidate", str(candidate_id)), title=f"CV: {name}"[:120])
    except (DuplicateTrigger, PlanRestricted, ValueError):
        return None


async def cv_forwarded(ctx, services, msg) -> bool:
    """A CV emailed to the business's Kritvia address: filed under the role and screened."""
    import asyncio

    from kritvia_api.services.textextract import ExtractionError, extract_text
    files = [a for a in msg.attachments if str(a.get("filename", "")).lower().endswith(CV_FILES)
             and 0 < int(a.get("size") or 0) <= 10 * 1024 * 1024]
    if not files:
        return False
    code = JOB_CODE.search(msg.subject or "")
    async with ctx.tx() as conn:
        if code:
            job = (await conn.execute(text("SELECT id, title FROM jobs WHERE venture_id = :v AND code = :c"
                                           " AND status = 'open'"),
                                      {"v": ctx.venture_id, "c": "JOB-" + code.group(1).upper()})).first()
        elif APPLICATION.search(msg.subject or ""):
            open_jobs = (await conn.execute(text("SELECT id, title FROM jobs WHERE venture_id = :v AND status = 'open'"
                                                 " LIMIT 2"), {"v": ctx.venture_id})).all()
            job = open_jobs[0] if len(open_jobs) == 1 else None
        else:
            job = None
    if job is None:
        return False
    f = files[0]
    try:
        ex = await asyncio.to_thread(extract_text, f["data"], f["filename"], f.get("mime"))
    except ExtractionError:
        return False
    if len((ex.text or "").strip()) < 50:
        return False
    async with ctx.tx() as conn:
        cid = await add_candidate(services, conn, org_id=ctx.org_id, venture_id=ctx.venture_id, job_id=job.id,
                                  name=msg.sender or "Applicant", email=msg.sender_email, phone=None, source="email",
                                  cv_text=ex.text, file_name=f["filename"])
    if cid is not None:
        await screen(services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                     candidate_id=cid, name=msg.sender or "Applicant")
    return True


# ----------------------------------------------------------------------------------- attendance --
def checkin_word(body: str) -> str | None:
    if CHECK_IN.match(body or ""):
        return "in"
    if CHECK_OUT.match(body or ""):
        return "out"
    return None


async def whatsapp_checkin(p, m, svc) -> bool:
    """IN / OUT from a staff member's own WhatsApp: noted, and answered. False for anything else."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services import front_door
    if m.kind != "text":
        return False
    word = checkin_word(m.text)
    if word is None:
        return False
    async with tenant_tx(None, "system") as conn:
        s = (await conn.execute(text("SELECT * FROM private.staff_by_phone(:v, :p)"),
                                {"v": p.venture_id, "p": m.sender})).first()
    if s is None:
        return False
    now = datetime.now(IST)
    today = now.date()
    async with tenant_tx(p.run_as, "agent", "attendance") as conn:
        row = (await conn.execute(text("SELECT starts_at FROM staff WHERE id = :s"), {"s": s.staff_id})).first()
        if word == "in":
            got = (await conn.execute(text(
                "INSERT INTO attendance (org_id, venture_id, staff_id, day, in_at, status, source)"
                " VALUES (:o, :v, :s, :d, :t, 'present', 'whatsapp')"
                " ON CONFLICT (staff_id, day) DO UPDATE SET in_at = coalesce(attendance.in_at, EXCLUDED.in_at),"
                " status = CASE WHEN attendance.status = 'absent' THEN 'present' ELSE attendance.status END"
                " RETURNING in_at"), {"o": s.org_id, "v": p.venture_id, "s": s.staff_id, "d": today, "t": now})).scalar()
            at = got.astimezone(IST)
            late = row and at.time() > (datetime.combine(today, row.starts_at) + LATE_AFTER).time()
            reply = f"Checked in at {at:%I:%M %p}" + (" (late today)" if late else "") + f". Have a good day, {s.name.split()[0]}!"
        else:
            got = (await conn.execute(text(
                "INSERT INTO attendance (org_id, venture_id, staff_id, day, out_at, status, source)"
                " VALUES (:o, :v, :s, :d, :t, 'present', 'whatsapp')"
                " ON CONFLICT (staff_id, day) DO UPDATE SET out_at = EXCLUDED.out_at RETURNING in_at, out_at"),
                {"o": s.org_id, "v": p.venture_id, "s": s.staff_id, "d": today, "t": now})).first()
            hours = ((got.out_at - got.in_at).total_seconds() / 3600) if got.in_at else None
            reply = f"Checked out at {now:%I:%M %p}" + (f" after {hours:.1f} hours" if hours is not None else "") + "."
    try:
        await front_door.whatsapp_say(p.venture_id, None, m.sender, reply, check_window=False)
    except Exception:  # noqa: BLE001 - the time is noted either way
        log.info("attendance reply failed", exc_info=True)
    return True


@dataclass
class Row:
    staff_id: uuid.UUID
    name: str
    role: str | None
    pay_kind: str
    pay_paise: int
    present: int
    half_days: int
    leave: int
    absent: int
    late: int
    working_days: int
    pay_estimate_paise: int


def working_days(year: int, month: int, upto: date | None = None) -> list[date]:
    last = calendar.monthrange(year, month)[1]
    days = [date(year, month, d) for d in range(1, last + 1)]
    if upto:
        days = [d for d in days if d <= upto]
    return [d for d in days if d.weekday() != 6]          # Monday to Saturday


async def month_sheet(conn, venture_id: uuid.UUID, year: int, month: int, today: date | None = None) -> list[Row]:
    """Each active staff member's month: present, half days, leave, absent (working days with no record) and a
    pay estimate (monthly pay pro rata to paid days; daily pay × days). An estimate for the accountant."""
    today = today or datetime.now(IST).date()
    all_days = working_days(year, month)
    counted = [d for d in all_days if d <= today]
    staff = (await conn.execute(text("SELECT id, name, role, pay_kind, pay_paise, starts_at FROM staff"
                                     " WHERE venture_id = :v AND active ORDER BY name"), {"v": venture_id})).all()
    recs = (await conn.execute(text(
        "SELECT staff_id, day, status, in_at FROM attendance WHERE venture_id = :v AND day BETWEEN :a AND :b"),
        {"v": venture_id, "a": date(year, month, 1), "b": all_days[-1] if all_days else date(year, month, 1)})).all()
    by: dict[uuid.UUID, dict[date, Any]] = {}
    for r in recs:
        by.setdefault(r.staff_id, {})[r.day] = r
    out = []
    for s in staff:
        mine = by.get(s.id, {})
        present = sum(1 for r in mine.values() if r.status == "present")
        half = sum(1 for r in mine.values() if r.status == "half_day")
        leave = sum(1 for r in mine.values() if r.status == "leave")
        absent = sum(1 for d in counted if d not in mine) + sum(1 for r in mine.values() if r.status == "absent")
        late = sum(1 for r in mine.values() if r.in_at and r.in_at.astimezone(IST).time()
                   > (datetime.combine(r.day, s.starts_at) + LATE_AFTER).time())
        paid_days = present + leave + half / 2
        if s.pay_kind == "daily":
            pay = round(s.pay_paise * (present + half / 2))
        else:
            pay = round(s.pay_paise * paid_days / len(all_days)) if all_days else 0
        out.append(Row(s.id, s.name, s.role, s.pay_kind, s.pay_paise, present, half, leave, absent, late,
                       len(all_days), int(pay)))
    return out


def _time(t: time) -> str:
    return t.strftime("%H:%M")


async def missing_today(services, now: datetime | None = None) -> int:
    """Worker, at 12:05 IST: tells the owners who hasn't checked in an hour after their start time (Mon-Sat)."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.owner_news import tell_admins
    now = (now or datetime.now(IST)).astimezone(IST)
    async with tenant_tx(None, "system") as conn:
        rows = (await conn.execute(text("SELECT * FROM private.attendance_missing(:d, :t)"),
                                   {"d": now.date(), "t": now.time()})).all()
    told = 0
    for r in rows:
        if r.run_as is None or not r.names:
            continue
        names = ", ".join(r.names[:10]) + (f" and {len(r.names) - 10} more" if len(r.names) > 10 else "")
        try:
            async with tenant_tx(r.run_as) as conn:
                await tell_admins(services, conn, r.venture_id,
                                  subject=f"Not checked in yet: {len(r.names)} of the team",
                                  body=f"{names} haven't sent IN on WhatsApp today. Mark leave or absent on the People "
                                       "page, or ask them to send IN.",
                                  path=f"/v/{r.venture_id}/people?tab=attendance", tag=f"attendance-{r.venture_id}")
            told += 1
        except Exception:  # noqa: BLE001
            log.exception("attendance note failed for %s", r.venture_id)
    return told
