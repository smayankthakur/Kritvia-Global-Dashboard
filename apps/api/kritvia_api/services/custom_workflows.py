"""Custom workflows (Scale, Enterprise): a business's own agent, set up in the app.

  when    invoice_overdue  an open invoice `wait_days` days past its due date
          invoice_paid     an invoice paid `wait_days` days ago (a thank-you, a review request…)
          booking_done     a booking marked done `wait_days` days ago
          lead_new         a new lead, `wait_days` days after it came in
          lead_quiet       an open lead with no change for `wait_days` days
  do      the owner's instructions, in plain words (English, Hindi or Hinglish)
  then    email   a draft to the customer, sent only after a yes
          notify  a note to the person who made it (Telegram if linked, else email; always kept in the run)

Checked once a day at the chosen time; each record is handled once per workflow (start_run dedupe),
at most MAX_PER_DAY records a day.
"""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text

IST = ZoneInfo("Asia/Kolkata")
MAX_PER_DAY = 25
TRIGGERS: dict[str, str] = {
    "invoice_overdue": "An invoice is {n} day(s) overdue",
    "invoice_paid": "An invoice was paid {n} day(s) ago",
    "booking_done": "A booking was done {n} day(s) ago",
    "lead_new": "A new lead came in {n} day(s) ago",
    "lead_quiet": "A lead has had no change for {n} day(s)",
}
RECORD = {"invoice_overdue": "invoice", "invoice_paid": "invoice", "booking_done": "booking",
          "lead_new": "lead", "lead_quiet": "lead"}


def describe(trigger: str, wait_days: int) -> str:
    s = TRIGGERS[trigger].format(n=wait_days)
    return s.replace("0 day(s) overdue", "due today or overdue").replace("0 day(s) ago", "today").replace(
        "came in 0 day(s) ago", "comes in")


def next_run(at_time: str, now: datetime | None = None) -> datetime:
    now = (now or datetime.now(UTC)).astimezone(IST)
    hh, mm = (int(x) for x in at_time.split(":"))
    t = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


async def candidates(conn, venture_id: uuid.UUID, trigger: str, wait_days: int, email_only: bool) -> list[uuid.UUID]:
    today: date = datetime.now(UTC).astimezone(IST).date()
    now = datetime.now(UTC)
    n = wait_days
    p: dict[str, Any] = {"v": venture_id, "n": n, "today": today, "now": now}
    email = " AND customer_email IS NOT NULL" if email_only else ""
    if trigger == "invoice_overdue":
        sql = ("SELECT id FROM invoices WHERE venture_id = :v AND status = 'open' AND paid_paise < amount_paise"
               " AND due_on <= CAST(:today AS date) - CAST(:n AS int) AND due_on > CAST(:today AS date) - CAST(:n AS int) - 30" + email + " ORDER BY due_on")
    elif trigger == "invoice_paid":
        sql = ("SELECT id FROM invoices WHERE venture_id = :v AND status = 'paid' AND paid_on IS NOT NULL"
               " AND paid_on <= CAST(:today AS date) - CAST(:n AS int) AND paid_on > CAST(:today AS date) - CAST(:n AS int) - 7" + email + " ORDER BY paid_on")
    elif trigger == "booking_done":
        em = " AND channel = 'email' AND address LIKE '%@%'" if email_only else ""
        sql = ("SELECT id FROM bookings WHERE venture_id = :v AND status = 'done'"
               " AND ends_at <= CAST(:now AS timestamptz) - make_interval(days => CAST(:n AS int))"
               " AND ends_at > CAST(:now AS timestamptz) - make_interval(days => CAST(:n AS int) + 7)" + em + " ORDER BY ends_at")
    elif trigger == "lead_new":
        em = " AND email IS NOT NULL" if email_only else ""
        sql = ("SELECT id FROM leads WHERE venture_id = :v AND opted_out_at IS NULL"
               " AND created_at <= CAST(:now AS timestamptz) - make_interval(days => CAST(:n AS int))"
               " AND created_at > CAST(:now AS timestamptz) - make_interval(days => CAST(:n AS int) + 7)" + em + " ORDER BY created_at")
    elif trigger == "lead_quiet":
        em = " AND email IS NOT NULL" if email_only else ""
        sql = ("SELECT id FROM leads WHERE venture_id = :v AND opted_out_at IS NULL"
               " AND status IN ('new', 'qualified', 'proposal')"
               " AND updated_at <= CAST(:now AS timestamptz) - make_interval(days => greatest(CAST(:n AS int), 1))"
               " AND updated_at > CAST(:now AS timestamptz) - make_interval(days => greatest(CAST(:n AS int), 1) + 60)" + em + " ORDER BY updated_at")
    else:
        return []
    return [r.id for r in (await conn.execute(text(sql + " LIMIT 200"), p)).all()]


def _rs(paise: int | None) -> str:
    from kritvia_api.workflows.collections import rupees
    return rupees(int(paise or 0))


async def record_facts(conn, venture_id: uuid.UUID, kind: str, record_id: uuid.UUID) -> tuple[dict[str, Any], str | None, str]:
    """(facts for the writer, the customer's email if any, the customer's name) for one record."""
    p = {"v": venture_id, "id": record_id}
    if kind == "invoice":
        r = (await conn.execute(text(
            "SELECT number, customer_name, customer_email, amount_paise, paid_paise, issued_on, due_on, paid_on, status"
            " FROM invoices WHERE id = :id AND venture_id = :v"), p)).first()
        if r is None:
            return {}, None, ""
        return ({"customer": r.customer_name, "invoice": r.number or "the invoice", "amount": _rs(r.amount_paise),
                 "still_owed": _rs(r.amount_paise - r.paid_paise), "issued_on": str(r.issued_on or ""),
                 "due_on": str(r.due_on or ""), "paid_on": str(r.paid_on or ""), "status": r.status},
                r.customer_email, r.customer_name)
    if kind == "booking":
        r = (await conn.execute(text(
            "SELECT customer_name, service_name, starts_at, status, channel, address FROM bookings"
            " WHERE id = :id AND venture_id = :v"), p)).first()
        if r is None:
            return {}, None, ""
        email = r.address if r.channel == "email" and r.address and "@" in r.address else None
        return ({"customer": r.customer_name, "service": r.service_name,
                 "when": f"{r.starts_at.astimezone(IST):%a %d %b %Y, %I:%M %p}", "status": r.status},
                email, r.customer_name)
    r = (await conn.execute(text(
        "SELECT name, email, company, source, status, created_at, updated_at FROM leads WHERE id = :id AND venture_id = :v"),
        p)).first()
    if r is None:
        return {}, None, ""
    return ({"lead": r.name, "company": r.company or "", "source": r.source, "status": r.status,
             "came_in": f"{r.created_at.astimezone(IST):%d %b %Y}",
             "last_change": f"{r.updated_at.astimezone(IST):%d %b %Y}"}, r.email, r.name)


async def fire_due(services, now: datetime | None = None) -> int:
    """Worker, every minute: start the daily check of each custom workflow whose time has come."""
    import logging

    from kritvia_api.db.session import tenant_tx
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    from kritvia_api.services.quota import PlanRestricted
    log = logging.getLogger(__name__)
    now = now or datetime.now(UTC)
    async with tenant_tx(None, "system") as conn:
        due = (await conn.execute(text("SELECT * FROM private.claim_due_custom(:n)"), {"n": now})).all()
    started = 0
    for d in due:
        # All of it inside the try, and the next time always set (the claim is a 15-minute lease).
        error, nxt = None, None
        try:
            async with tenant_tx(d.run_as, "agent", "custom") as conn:
                c = (await conn.execute(text("SELECT id, name, at_time, enabled FROM custom_workflows WHERE id = :c"),
                                        {"c": d.custom_id})).first()
            if c is None:
                continue
            nxt = next_run(c.at_time, now)
            try:
                await start_run(services, actor_user_id=d.run_as, actor_type="agent", venture_id=d.venture_id,
                                workflow="custom", input={"custom_id": str(c.id), "mode": "scan"}, trigger_kind="schedule",
                                dedupe=("custom-scan", f"{c.id}:{d.due_at:%Y%m%d%H%M}"), title=f"Custom workflow: {c.name}"[:120])
                started += 1
            except DuplicateTrigger:
                pass
            except PlanRestricted as exc:
                error = str(exc)[:300]
        except Exception as exc:  # noqa: BLE001
            log.exception("custom workflow %s didn't start", d.custom_id)
            error = f"didn't start ({type(exc).__name__})"
        finally:
            async with tenant_tx(None, "system") as conn:
                await conn.execute(text("SELECT private.set_custom_next(:c, :n, :e)"),
                                   {"c": d.custom_id, "n": nxt or now + timedelta(minutes=15), "e": error})
    return started
