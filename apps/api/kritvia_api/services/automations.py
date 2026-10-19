"""Automations from plain words: when they run next, the period they cover, and the business's numbers
for that period (the only facts an automation's report may use)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text

PERIODS = ("today", "yesterday", "last_7_days", "last_week", "this_month", "last_month", "last_30_days",
           "tomorrow", "next_7_days")
PERIOD_WORDS = {"today": "today", "yesterday": "yesterday", "last_7_days": "the last 7 days",
                "tomorrow": "tomorrow", "next_7_days": "the next 7 days",
                "last_week": "last week (Monday to Sunday)", "this_month": "this month so far",
                "last_month": "last month", "last_30_days": "the last 30 days"}
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def next_run(freq: str, weekdays: list[int], day_of_month: int | None, at_time: str, tz: ZoneInfo,
             after: datetime) -> datetime:
    """The first matching time strictly after `after`."""
    hh, mm = (int(x) for x in at_time.split(":"))
    local = after.astimezone(tz)
    for d in range(0, 400):
        day = local.date() + timedelta(days=d)
        if freq == "weekly" and day.weekday() not in weekdays:
            continue
        if freq == "monthly" and day.day != day_of_month:
            continue
        t = datetime.combine(day, time(hh, mm), tz)
        if t > after:
            return t
    raise ValueError("no next time")


def period_range(period: str, tz: ZoneInfo, now: datetime) -> tuple[datetime, datetime]:
    today = now.astimezone(tz).date()

    def at(d: date) -> datetime:
        return datetime.combine(d, time(0, 0), tz)
    if period == "today":
        return at(today), at(today + timedelta(days=1))
    if period == "tomorrow":
        return at(today + timedelta(days=1)), at(today + timedelta(days=2))
    if period == "next_7_days":
        return at(today), at(today + timedelta(days=7))
    if period == "yesterday":
        return at(today - timedelta(days=1)), at(today)
    if period == "last_7_days":
        return at(today - timedelta(days=7)), at(today)
    if period == "last_30_days":
        return at(today - timedelta(days=30)), at(today)
    if period == "last_week":
        monday = today - timedelta(days=today.weekday())
        return at(monday - timedelta(days=7)), at(monday)
    if period == "this_month":
        return at(today.replace(day=1)), at(today + timedelta(days=1))
    if period == "last_month":
        first = today.replace(day=1)
        return at((first - timedelta(days=1)).replace(day=1)), at(first)
    raise ValueError(period)


def describe(freq: str, weekdays: list[int], day_of_month: int | None, at_time: str) -> str:
    hh, mm = (int(x) for x in at_time.split(":"))
    clock = time(hh, mm).strftime("%I:%M %p").lstrip("0")
    if freq == "daily":
        return f"Every day at {clock}"
    if freq == "weekly":
        days = [WEEKDAYS[d] for d in sorted(weekdays)]
        return ("Every " + (", ".join(days[:-1]) + " and " + days[-1] if len(days) > 1 else days[0])) + f" at {clock}"
    return f"On day {day_of_month} of every month at {clock}"


def _rs(paise: int | None) -> str:
    from kritvia_api.workflows.collections import rupees
    return rupees(int(paise or 0))


async def facts(conn, venture_id: uuid.UUID, start: datetime, end: datetime) -> str:
    """The business's numbers for the period, as plain lines (read as the business's runtime)."""
    p = {"v": venture_id, "s": start, "e": end}
    inv = (await conn.execute(text(
        "SELECT count(*) FILTER (WHERE coalesce(issued_on, created_at::date) >= CAST(:s AS date)"
        "                          AND coalesce(issued_on, created_at::date) < CAST(:e AS date)) AS issued_n,"
        " coalesce(sum(amount_paise) FILTER (WHERE coalesce(issued_on, created_at::date) >= CAST(:s AS date)"
        "                          AND coalesce(issued_on, created_at::date) < CAST(:e AS date)), 0) AS issued_total,"
        " coalesce(sum(amount_paise - paid_paise) FILTER (WHERE status = 'open'), 0) AS outstanding,"
        " count(*) FILTER (WHERE status = 'open' AND due_on < CAST(:e AS date)) AS overdue_n,"
        " coalesce(sum(amount_paise - paid_paise) FILTER (WHERE status = 'open' AND due_on < CAST(:e AS date)), 0) AS overdue"
        " FROM invoices WHERE venture_id = :v AND status <> 'cancelled'"), p)).first()
    paid = (await conn.execute(text(
        "SELECT count(*) AS n, coalesce(sum(amount_paise), 0) AS total FROM invoice_payments"
        " WHERE venture_id = :v AND paid_on >= CAST(:s AS date) AND paid_on < CAST(:e AS date)"), p)).first()
    top = (await conn.execute(text(
        "SELECT customer_name, number, amount_paise - paid_paise AS owed, due_on FROM invoices"
        " WHERE venture_id = :v AND status = 'open' AND due_on < CAST(:e AS date) ORDER BY owed DESC LIMIT 5"), p)).all()
    bk = (await conn.execute(text(
        "SELECT count(*) FILTER (WHERE status IN ('confirmed', 'done')) AS booked,"
        " count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'no_show') AS no_show,"
        " count(*) FILTER (WHERE status = 'cancelled') AS cancelled"
        " FROM bookings WHERE venture_id = :v AND starts_at >= :s AND starts_at < :e"), p)).first()
    leads = (await conn.execute(text(
        "SELECT count(*) AS new, count(*) FILTER (WHERE status = 'won') AS won FROM leads"
        " WHERE venture_id = :v AND created_at >= :s AND created_at < :e"), p)).first()
    drafts = (await conn.execute(text(
        "SELECT count(*) AS made, count(*) FILTER (WHERE status IN ('approved', 'edited', 'auto_approved')) AS approved"
        " FROM approvals WHERE venture_id = :v AND created_at >= :s AND created_at < :e"), p)).first()
    due = (await conn.execute(text(
        "SELECT count(*) AS n, coalesce(sum(amount_paise - paid_paise), 0) AS owed FROM invoices"
        " WHERE venture_id = :v AND status = 'open' AND due_on >= CAST(:s AS date) AND due_on < CAST(:e AS date)"), p)).first()
    blist = (await conn.execute(text(
        "SELECT starts_at, customer_name, service_name, status FROM bookings"
        " WHERE venture_id = :v AND starts_at >= :s AND starts_at < :e AND status <> 'cancelled'"
        " ORDER BY starts_at LIMIT 16"), p)).all()
    waiting = (await conn.execute(text(
        "SELECT count(*) FROM approvals WHERE venture_id = :v AND status = 'pending'"), p)).scalar()
    lines = [
        f"Period: {start.date().isoformat()} to {(end - timedelta(seconds=1)).date().isoformat()}",
        f"Money received (payments recorded): {_rs(paid.total)} in {paid.n} payment(s)",
        f"Invoices issued: {inv.issued_n}, worth {_rs(inv.issued_total)}",
        f"Still to collect now: {_rs(inv.outstanding)}; overdue: {inv.overdue_n} invoice(s), {_rs(inv.overdue)}",
    ]
    if top:
        lines.append("Largest overdue: " + "; ".join(
            f"{r.customer_name}{' (' + r.number + ')' if r.number else ''} {_rs(r.owed)} due {r.due_on.isoformat()}"
            for r in top))
    lines += [
        f"Bookings in the period: {bk.booked} (done {bk.done}, no-shows {bk.no_show}, cancelled {bk.cancelled})",
        f"New leads: {leads.new} (won {leads.won})",
        f"Drafts by the agents: {drafts.made} (approved {drafts.approved})",
        f"Drafts waiting for a yes right now: {waiting}",
        f"Open invoices falling due in the period: {due.n}, {_rs(due.owed)}",
    ]
    if blist:
        tz = start.tzinfo
        shown = blist[:15]
        lines.append("Bookings (time, customer, service): " + "; ".join(
            f"{b.starts_at.astimezone(tz):%a %d %b %I:%M %p} {b.customer_name} - {b.service_name}"
            + (f" ({b.status.replace('_', '-')})" if b.status != "confirmed" else "") for b in shown)
            + ("; and more" if len(blist) > 15 else ""))
    return "\n".join(lines)


def to_dict(r: Any) -> dict[str, Any]:
    return {k: getattr(r, k) for k in ("freq", "weekdays", "day_of_month", "at_time")}


async def fire_due(services, now: datetime | None = None) -> int:
    """Called by the worker every minute: start every automation whose time has come, then set its next time.
    A failed start is recorded on the automation and tried again at its next time."""
    import logging
    from datetime import UTC

    from kritvia_api.db.session import tenant_tx
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    from kritvia_api.services.quota import PlanRestricted
    log = logging.getLogger(__name__)
    now = now or datetime.now(UTC)
    async with tenant_tx(None, "system") as conn:
        due = (await conn.execute(text("SELECT * FROM private.claim_due_automations(:n)"), {"n": now})).all()
    started = 0
    for d in due:
        error = None
        async with tenant_tx(d.run_as, "agent", "automation") as conn:
            a = (await conn.execute(text(
                "SELECT a.*, coalesce(s.timezone, 'Asia/Kolkata') AS tz FROM automations a"
                " LEFT JOIN venture_settings s ON s.venture_id = a.venture_id WHERE a.id = :a"), {"a": d.automation_id})).first()
        if a is None:
            continue
        try:
            await start_run(services, actor_user_id=d.run_as, actor_type="agent", venture_id=d.venture_id,
                            workflow="automation", input={"automation_id": str(a.id)}, trigger_kind="schedule",
                            dedupe=("automation", f"{a.id}:{now:%Y%m%d%H%M}"), title=f"Automation: {a.name}"[:120])
            started += 1
        except DuplicateTrigger:
            pass
        except PlanRestricted as exc:
            error = str(exc)[:300]
        except Exception as exc:  # noqa: BLE001
            log.exception("automation %s didn't start", a.id)
            error = f"didn't start ({type(exc).__name__})"
        try:
            tz = ZoneInfo(a.tz)
        except Exception:  # noqa: BLE001
            tz = ZoneInfo("Asia/Kolkata")
        nxt = next_run(a.freq, list(a.weekdays), a.day_of_month, a.at_time, tz, now)
        async with tenant_tx(None, "system") as conn:
            await conn.execute(text("SELECT private.set_automation_next(:a, :n, :e)"), {"a": a.id, "n": nxt, "e": error})
    return started
