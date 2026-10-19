"""The cash position ahead: thirteen weeks of money coming in and going out, from what Kritvia already knows.

  coming in    every open invoice's balance, on the day it is likely to be paid: its due date plus how late
               that customer usually pays (the business's usual lateness when the customer is new to it).
               Overdue invoices are expected within the week; ones more than 90 days overdue are counted as
               doubtful and left out of the totals (they are listed, so nobody forgets them)
  going out    every open supplier bill on its due date (overdue ones this week), the team's salaries
               (People → Attendance) on the 1st, and the other fixed monthly costs the owner typed, on the 1st
  starting     the bank balance: the latest closing balance on an uploaded statement, or the one the owner
               typed, whichever is newer. Without one the view shows the net flow only.

All of this is arithmetic in code, never a model, so the same numbers always give the same answer. It is a
forecast, not a promise: it says so wherever it is shown.

  cash_week   the worker's Monday-morning note to owners and admins (09:05 IST): the next 30/60/90 days, and a
              warning when a week dips below the level the owner set (or below zero).
"""
from __future__ import annotations

import logging
import statistics
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import text

from kritvia_api.workflows.common import IST

log = logging.getLogger(__name__)

WEEKS = 13
DOUBTFUL_DAYS = 90
MAX_LATE = 60


@dataclass
class Week:
    start: date
    end: date
    in_paise: int = 0
    out_paise: int = 0
    closing_paise: int = 0


@dataclass
class Horizon:
    days: int
    in_paise: int
    out_paise: int
    closing_paise: int


@dataclass
class Forecast:
    today: date
    opening_paise: int | None
    opening_on: date | None
    opening_from: str | None             # 'statement' | 'typed'
    weeks: list[Week]
    horizons: list[Horizon]
    lowest_paise: int
    lowest_week: date
    below_alert: bool
    alert_below_paise: int | None
    usual_late_days: int
    doubtful_paise: int
    doubtful_invoices: int
    salaries_paise: int
    fixed_paise: int
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def _first_days(start: date, end: date) -> list[date]:
    """Every 1st of a month from start to end, inclusive."""
    d = date(start.year, start.month, 1)
    if d < start:
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    out = []
    while d <= end:
        out.append(d)
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return out


def build(today: date, *, open_invoices: list[tuple[str, int, date]], paid_history: list[tuple[str, int]],
          open_bills: list[tuple[int, date]], salaries_paise: int, fixed_paise: int,
          opening: tuple[int, date, str] | None, alert_below_paise: int | None) -> Forecast:
    """open_invoices: (customer, balance, due_on); paid_history: (customer, days paid after the due date);
    open_bills: (balance, due_on); opening: (balance, as of, 'statement' | 'typed')."""
    late_by: dict[str, list[int]] = {}
    for who, late in paid_history:
        late_by.setdefault(who.strip().lower(), []).append(late)
    everyone = [x for v in late_by.values() for x in v]
    usual = int(max(0, min(MAX_LATE, statistics.median(everyone)))) if everyone else 0
    end = today + timedelta(days=WEEKS * 7 - 1)
    flows: list[tuple[date, int]] = []
    doubtful = doubtful_n = 0
    for who, bal, due in open_invoices:
        if bal <= 0:
            continue
        if (today - due).days > DOUBTFUL_DAYS:
            doubtful += bal
            doubtful_n += 1
            continue
        mine = late_by.get(who.strip().lower())
        late = int(max(0, min(MAX_LATE, statistics.median(mine)))) if mine else usual
        on = due + timedelta(days=late)
        if on < today:
            on = today + timedelta(days=min(6, max(0, late)))
        flows.append((on, bal))
    for bal, due in open_bills:
        if bal > 0:
            flows.append((max(due, today), -bal))
    for d in _first_days(today, end):
        if salaries_paise:
            flows.append((d, -salaries_paise))
        if fixed_paise:
            flows.append((d, -fixed_paise))
    weeks = [Week(start=today + timedelta(days=7 * i), end=today + timedelta(days=7 * i + 6)) for i in range(WEEKS)]
    beyond_in = beyond_out = 0
    for on, amt in flows:
        i = (on - today).days // 7
        if i >= WEEKS:
            beyond_in += max(amt, 0)
            beyond_out += max(-amt, 0)
            continue
        if amt >= 0:
            weeks[i].in_paise += amt
        else:
            weeks[i].out_paise += -amt
    bal = opening[0] if opening else 0
    for w in weeks:
        bal += w.in_paise - w.out_paise
        w.closing_paise = bal
    horizons = []
    for days in (30, 60, 90):
        cut = today + timedelta(days=days - 1)
        i_ = sum(a for on, a in flows if a > 0 and on <= cut)
        o_ = sum(-a for on, a in flows if a < 0 and on <= cut)
        horizons.append(Horizon(days, i_, o_, (opening[0] if opening else 0) + i_ - o_))
    low = min(weeks, key=lambda w: w.closing_paise)
    floor = alert_below_paise if alert_below_paise is not None else (0 if opening else None)
    notes = []
    if not opening:
        notes.append("No bank balance yet: these are the net flows only. Upload a statement or type the balance.")
    if doubtful:
        notes.append(f"{doubtful_n} invoice{'s' if doubtful_n != 1 else ''} more than {DOUBTFUL_DAYS} days overdue "
                     "are left out as doubtful.")
    if not paid_history:
        notes.append("No paid invoices yet, so invoices are expected on their due dates.")
    return Forecast(today=today, opening_paise=opening[0] if opening else None,
                    opening_on=opening[1] if opening else None, opening_from=opening[2] if opening else None,
                    weeks=weeks, horizons=horizons, lowest_paise=low.closing_paise, lowest_week=low.start,
                    below_alert=floor is not None and low.closing_paise < floor, alert_below_paise=alert_below_paise,
                    usual_late_days=usual, doubtful_paise=doubtful, doubtful_invoices=doubtful_n,
                    salaries_paise=salaries_paise, fixed_paise=fixed_paise, notes=notes)


async def forecast(conn, venture_id: uuid.UUID, today: date | None = None) -> Forecast:
    today = today or datetime.now(IST).date()
    inv = (await conn.execute(text(
        "SELECT customer_name, amount_paise - paid_paise AS bal, due_on FROM invoices"
        " WHERE venture_id = :v AND status = 'open' AND amount_paise > paid_paise"), {"v": venture_id})).all()
    paid = (await conn.execute(text(
        "SELECT customer_name, (paid_on - due_on) AS late FROM invoices WHERE venture_id = :v AND status = 'paid'"
        " AND paid_on IS NOT NULL AND paid_on > CAST(:t AS date) - 365 ORDER BY paid_on DESC LIMIT 500"),
        {"v": venture_id, "t": today})).all()
    bills = (await conn.execute(text(
        "SELECT amount_paise - paid_paise AS bal, due_on FROM bills WHERE venture_id = :v AND status = 'open'"
        " AND amount_paise > paid_paise AND due_on IS NOT NULL"), {"v": venture_id})).all()
    salaries = (await conn.execute(text(
        "SELECT coalesce(sum(CASE WHEN pay_kind = 'monthly' THEN pay_paise ELSE pay_paise * 26 END), 0)"
        " FROM staff WHERE venture_id = :v AND active"), {"v": venture_id})).scalar() or 0
    s = (await conn.execute(text("SELECT * FROM cash_settings WHERE venture_id = :v"), {"v": venture_id})).first()
    line = (await conn.execute(text(
        "SELECT balance_paise, line_date FROM bank_lines WHERE venture_id = :v AND balance_paise IS NOT NULL"
        " ORDER BY line_date DESC, created_at DESC LIMIT 1"), {"v": venture_id})).first()
    opening = None
    if s is not None and s.balance_paise is not None:
        opening = (int(s.balance_paise), s.balance_on, "typed")
    if line is not None and (opening is None or line.line_date > opening[1]):
        opening = (int(line.balance_paise), line.line_date, "statement")
    return build(today, open_invoices=[(r.customer_name, int(r.bal), r.due_on) for r in inv],
                 paid_history=[(r.customer_name, int(r.late)) for r in paid],
                 open_bills=[(int(r.bal), r.due_on) for r in bills], salaries_paise=int(salaries),
                 fixed_paise=int(s.monthly_fixed_paise) if s else 0, opening=opening,
                 alert_below_paise=int(s.alert_below_paise) if s and s.alert_below_paise is not None else None)


def rupees(paise: int) -> str:
    r = abs(paise) / 100
    s = f"₹{r:,.0f}"
    return f"-{s}" if paise < 0 else s


def note(f: Forecast) -> tuple[str, str]:
    """The Monday note: (subject, body)."""
    h = {x.days: x for x in f.horizons}
    start = (f"Starting from {rupees(f.opening_paise)} in the bank ({'statement' if f.opening_from == 'statement' else 'as typed'}"
             f" on {f.opening_on:%d %b}). " if f.opening_paise is not None else "No bank balance yet, so these are net flows. ")
    lines = [start]
    for d in (30, 60, 90):
        x = h[d]
        lines.append(f"Next {d} days: {rupees(x.in_paise)} likely in, {rupees(x.out_paise)} out"
                     + (f", ending near {rupees(x.closing_paise)}." if f.opening_paise is not None
                        else f", net {rupees(x.in_paise - x.out_paise)}."))
    if f.below_alert:
        floor = f.alert_below_paise if f.alert_below_paise is not None else 0
        lines.append(f"Watch the week of {f.lowest_week:%d %b}: it dips to {rupees(f.lowest_paise)}, below "
                     f"{rupees(floor)}. Chasing the biggest dues before then would help.")
    if f.doubtful_invoices:
        lines.append(f"Left out as doubtful: {rupees(f.doubtful_paise)} in {f.doubtful_invoices} invoice"
                     f"{'s' if f.doubtful_invoices != 1 else ''} over {DOUBTFUL_DAYS} days overdue.")
    lines.append("A forecast from your invoices, bills and salaries, not a promise.")
    subject = ("Cash: a tight week ahead" if f.below_alert
               else f"Cash for the next 30 days: {rupees(h[30].in_paise)} in, {rupees(h[30].out_paise)} out")
    return subject, " ".join(lines)


async def cash_week(services, today: date | None = None) -> int:
    """Mondays: the cash note to each business with money coming or going (once a day at most)."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.owner_news import tell_admins
    today = today or datetime.now(IST).date()
    if today.weekday() != 0:
        return 0
    async with tenant_tx(None, "system") as conn:
        rows = (await conn.execute(text("SELECT * FROM private.cash_targets()"))).all()
    told = 0
    for r in rows:
        if r.run_as is None:
            continue
        try:
            async with tenant_tx(r.run_as) as conn:
                last = (await conn.execute(text("SELECT last_note_on FROM cash_settings WHERE venture_id = :v"),
                                           {"v": r.venture_id})).scalar()
                if last == today:
                    continue
                f = await forecast(conn, r.venture_id, today)
                subject, body = note(f)
                await tell_admins(services, conn, r.venture_id, subject=subject, body=body,
                                  path=f"/v/{r.venture_id}/money?tab=cash", tag=f"cash-{r.venture_id}")
                await conn.execute(text(
                    "INSERT INTO cash_settings (venture_id, org_id, last_note_on) VALUES (:v, :o, :t)"
                    " ON CONFLICT (venture_id) DO UPDATE SET last_note_on = :t"),
                    {"v": r.venture_id, "o": r.org_id, "t": today})
            told += 1
        except Exception:  # noqa: BLE001 - one business's problem never stops the others
            log.exception("cash note failed for %s", r.venture_id)
    return told
