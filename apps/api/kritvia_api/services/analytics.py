"""Business analytics (the Analytics page). Everything is read as the business's members (RLS), so
nobody sees another business's numbers.

  basic     every plan: the headline numbers for the last 30 or 90 days, compared with the period
            before, and a trend chart
  advanced  Growth and above: up to 12 months, plus the lead funnel and sources, money still owed by
            age, each agent's drafts and how fast they were answered, drafts by channel, AI usage and
            the best-paying customers
"""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text

IST = ZoneInfo("Asia/Kolkata")
APPROVED = ("approved", "edited", "executed")


def bucket_for(days: int) -> str:
    return "day" if days <= 31 else "week" if days <= 120 else "month"


def period(days: int, now: datetime | None = None) -> tuple[datetime, datetime]:
    """[start, end): the last `days` whole days up to the end of today, India time."""
    today = (now or datetime.now(UTC)).astimezone(IST).date()
    end = datetime.combine(today + timedelta(days=1), datetime.min.time(), IST)
    return end - timedelta(days=days), end


async def headline(conn, v: uuid.UUID, start: datetime, end: datetime) -> dict[str, int]:
    p = {"v": v, "s": start, "e": end}
    money = (await conn.execute(text(
        "SELECT coalesce(sum(amount_paise), 0) AS received, count(*) AS payments FROM invoice_payments"
        " WHERE venture_id = :v AND paid_on >= CAST(:s AS date) AND paid_on < CAST(:e AS date)"), p)).first()
    inv = (await conn.execute(text(
        "SELECT count(*) AS n, coalesce(sum(amount_paise), 0) AS total FROM invoices"
        " WHERE venture_id = :v AND status <> 'cancelled'"
        "   AND coalesce(issued_on, created_at::date) >= CAST(:s AS date) AND coalesce(issued_on, created_at::date) < CAST(:e AS date)"),
        p)).first()
    owed = (await conn.execute(text(
        "SELECT coalesce(sum(amount_paise - paid_paise), 0) AS outstanding,"
        " coalesce(sum(amount_paise - paid_paise) FILTER (WHERE due_on < CAST(:e AS date)), 0) AS overdue"
        " FROM invoices WHERE venture_id = :v AND status = 'open'"), p)).first()
    leads = (await conn.execute(text(
        "SELECT count(*) AS new, count(*) FILTER (WHERE status = 'won') AS won FROM leads"
        " WHERE venture_id = :v AND created_at >= :s AND created_at < :e"), p)).first()
    bk = (await conn.execute(text(
        "SELECT count(*) FILTER (WHERE status <> 'cancelled') AS booked, count(*) FILTER (WHERE status = 'done') AS done,"
        " count(*) FILTER (WHERE status = 'no_show') AS no_show FROM bookings"
        " WHERE venture_id = :v AND starts_at >= :s AND starts_at < :e"), p)).first()
    dr = (await conn.execute(text(
        "SELECT count(*) AS made, count(*) FILTER (WHERE status IN ('approved', 'edited', 'auto_approved')) AS approved,"
        " count(*) FILTER (WHERE status = 'rejected') AS rejected FROM approvals"
        " WHERE venture_id = :v AND created_at >= :s AND created_at < :e"), p)).first()
    return {"received_paise": int(money.received), "payments": int(money.payments), "invoices_issued": int(inv.n),
            "issued_paise": int(inv.total), "outstanding_paise": int(owed.outstanding), "overdue_paise": int(owed.overdue),
            "new_leads": int(leads.new), "won_leads": int(leads.won), "bookings": int(bk.booked),
            "bookings_done": int(bk.done), "no_shows": int(bk.no_show), "drafts": int(dr.made),
            "drafts_approved": int(dr.approved), "drafts_rejected": int(dr.rejected)}


async def trend(conn, v: uuid.UUID, start: datetime, end: datetime, unit: str) -> list[dict[str, Any]]:
    """One row per day, week (from Monday) or month: money received and invoiced, leads, drafts."""
    rows = (await conn.execute(text(f"""
        WITH b AS (
          SELECT generate_series(date_trunc('{unit}', CAST(:s AS timestamp)), CAST(:e AS timestamp) - interval '1 second',
                                 interval '1 {unit}')::date AS d)
        SELECT b.d,
          coalesce((SELECT sum(amount_paise) FROM invoice_payments x WHERE x.venture_id = :v
                     AND date_trunc('{unit}', x.paid_on) = b.d AND x.paid_on >= CAST(:s AS date) AND x.paid_on < CAST(:e AS date)), 0) AS received,
          coalesce((SELECT sum(amount_paise) FROM invoices x WHERE x.venture_id = :v AND x.status <> 'cancelled'
                     AND date_trunc('{unit}', coalesce(x.issued_on, x.created_at::date)) = b.d
                     AND coalesce(x.issued_on, x.created_at::date) >= CAST(:s AS date)
                     AND coalesce(x.issued_on, x.created_at::date) < CAST(:e AS date)), 0) AS issued,
          (SELECT count(*) FROM leads x WHERE x.venture_id = :v AND date_trunc('{unit}', x.created_at AT TIME ZONE 'Asia/Kolkata') = b.d
                     AND x.created_at >= :s AND x.created_at < :e) AS leads,
          (SELECT count(*) FROM approvals x WHERE x.venture_id = :v AND date_trunc('{unit}', x.created_at AT TIME ZONE 'Asia/Kolkata') = b.d
                     AND x.created_at >= :s AND x.created_at < :e) AS drafts,
          (SELECT count(*) FROM approvals x WHERE x.venture_id = :v AND x.status IN ('approved', 'edited', 'auto_approved')
                     AND date_trunc('{unit}', x.created_at AT TIME ZONE 'Asia/Kolkata') = b.d
                     AND x.created_at >= :s AND x.created_at < :e) AS approved
        FROM b ORDER BY b.d"""), {"v": v, "s": start.replace(tzinfo=None), "e": end.replace(tzinfo=None)})).all()
    return [{"start": r.d.isoformat(), "received_paise": int(r.received), "issued_paise": int(r.issued),
             "leads": int(r.leads), "drafts": int(r.drafts), "approved": int(r.approved)} for r in rows]


async def advanced(conn, v: uuid.UUID, start: datetime, end: datetime) -> dict[str, Any]:
    p = {"v": v, "s": start, "e": end}
    funnel = {r.status: int(r.n) for r in (await conn.execute(text(
        "SELECT status, count(*) AS n FROM leads WHERE venture_id = :v AND created_at >= :s AND created_at < :e"
        " GROUP BY status"), p)).all()}
    sources = [{"source": r.source, "leads": int(r.n), "won": int(r.won)} for r in (await conn.execute(text(
        "SELECT coalesce(nullif(source, ''), 'manual') AS source, count(*) AS n, count(*) FILTER (WHERE status = 'won') AS won"
        " FROM leads WHERE venture_id = :v AND created_at >= :s AND created_at < :e GROUP BY 1 ORDER BY n DESC LIMIT 10"),
        p)).all()]
    today = datetime.now(UTC).astimezone(IST).date()
    age = (await conn.execute(text(
        "SELECT coalesce(sum(amount_paise - paid_paise) FILTER (WHERE due_on >= :t), 0) AS not_due,"
        " coalesce(sum(amount_paise - paid_paise) FILTER (WHERE due_on < :t AND due_on >= :t - 30), 0) AS d30,"
        " coalesce(sum(amount_paise - paid_paise) FILTER (WHERE due_on < :t - 30 AND due_on >= :t - 60), 0) AS d60,"
        " coalesce(sum(amount_paise - paid_paise) FILTER (WHERE due_on < :t - 60 AND due_on >= :t - 90), 0) AS d90,"
        " coalesce(sum(amount_paise - paid_paise) FILTER (WHERE due_on < :t - 90), 0) AS older"
        " FROM invoices WHERE venture_id = :v AND status = 'open'"), {"v": v, "t": today})).first()
    agents = [{"agent": r.agent, "drafts": int(r.n), "approved": int(r.ok), "edited": int(r.edited),
               "rejected": int(r.rejected), "median_minutes": float(r.median) if r.median is not None else None}
              for r in (await conn.execute(text(
                  "SELECT coalesce(agent, 'agent') AS agent, count(*) AS n,"
                  " count(*) FILTER (WHERE status IN ('approved', 'auto_approved')) AS ok,"
                  " count(*) FILTER (WHERE status = 'edited') AS edited,"
                  " count(*) FILTER (WHERE status = 'rejected') AS rejected,"
                  " round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM decided_at - created_at) / 60)"
                  "   FILTER (WHERE decided_at IS NOT NULL))::numeric, 1) AS median"
                  " FROM approvals WHERE venture_id = :v AND created_at >= :s AND created_at < :e"
                  " GROUP BY 1 ORDER BY n DESC LIMIT 20"), p)).all()]
    channels = [{"channel": r.ch, "drafts": int(r.n), "approved": int(r.ok)} for r in (await conn.execute(text(
        "SELECT CASE WHEN action LIKE 'gmail.%' OR action LIKE 'email.%' THEN 'email'"
        "            WHEN action LIKE 'whatsapp.%' THEN 'whatsapp' WHEN action LIKE 'telegram.%' THEN 'telegram'"
        "            ELSE 'other' END AS ch, count(*) AS n,"
        " count(*) FILTER (WHERE status IN ('approved', 'edited', 'auto_approved')) AS ok"
        " FROM approvals WHERE venture_id = :v AND created_at >= :s AND created_at < :e GROUP BY 1 ORDER BY n DESC"),
        p)).all()]
    ai = [{"agent": r.wf, "tokens": int(r.tokens), "calls": int(r.calls)} for r in (await conn.execute(text(
        "SELECT coalesce(workflow, 'assistant') AS wf, count(*) AS calls,"
        " coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0) AS tokens"
        " FROM model_calls WHERE venture_id = :v AND status = 'ok' AND created_at >= :s AND created_at < :e"
        " GROUP BY 1 ORDER BY tokens DESC LIMIT 15"), p)).all()]
    customers = [{"customer": r.customer_name, "received_paise": int(r.total), "payments": int(r.n)}
                 for r in (await conn.execute(text(
                     "SELECT i.customer_name, sum(x.amount_paise) AS total, count(*) AS n FROM invoice_payments x"
                     " JOIN invoices i ON i.id = x.invoice_id WHERE x.venture_id = :v"
                     " AND x.paid_on >= CAST(:s AS date) AND x.paid_on < CAST(:e AS date)"
                     " GROUP BY i.customer_name ORDER BY total DESC LIMIT 5"), p)).all()]
    return {"funnel": {k: funnel.get(k, 0) for k in ("new", "qualified", "proposal", "won", "lost")},
            "sources": sources,
            "ageing": {"not_due": int(age.not_due), "d1_30": int(age.d30), "d31_60": int(age.d60),
                       "d61_90": int(age.d90), "d90_plus": int(age.older)},
            "agents": agents, "channels": channels, "ai": ai, "top_customers": customers}


def as_of() -> date:
    return datetime.now(UTC).astimezone(IST).date()
