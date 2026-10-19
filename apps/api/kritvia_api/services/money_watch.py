"""Money reminders the worker sends the owners and admins (push, Telegram or email; services/owner_news.py):

  bills_due     every morning: supplier bills due within 3 days or overdue, once a day per business
  gstr1_ready   on the 3rd of the month: last month's GSTR-1 is ready to download (due on the 11th)

Nothing is paid or filed by Kritvia; these only say what needs doing and link to it.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from sqlalchemy import text

from kritvia_api.workflows.common import IST

log = logging.getLogger(__name__)


def _rupees(paise: int) -> str:
    r = paise / 100
    return f"₹{r:,.0f}" if paise % 100 == 0 else f"₹{r:,.2f}"


async def bills_due(services, today: date | None = None) -> int:
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.owner_news import tell_admins
    today = today or datetime.now(IST).date()
    async with tenant_tx(None, "system") as conn:
        rows = (await conn.execute(text("SELECT * FROM private.bills_to_remind(:t)"), {"t": today})).all()
    told = 0
    for r in rows:
        if r.run_as is None:
            continue
        n = r.due_soon + r.overdue
        parts = []
        if r.overdue:
            parts.append(f"{r.overdue} overdue")
        if r.due_soon:
            parts.append(f"{r.due_soon} due in the next 3 days")
        subject = f"{n} supplier bill{'s' if n != 1 else ''} to pay: {_rupees(r.total_paise)}"
        body = (f"{', '.join(parts).capitalize()}, {_rupees(r.total_paise)} in all; the first is {r.first_vendor}, "
                f"due {r.first_due.strftime('%d %b')}. Kritvia never pays bills itself: pay them as you usually do, "
                "and they are marked paid when your bank statement shows it (or press Paid).")
        try:
            async with tenant_tx(r.run_as) as conn:
                await tell_admins(services, conn, r.venture_id, subject=subject, body=body,
                                  path=f"/v/{r.venture_id}/money?tab=bills", tag=f"bills-{r.venture_id}")
                await conn.execute(text("UPDATE bills SET reminded_on = :t WHERE venture_id = :v AND status = 'open'"
                                        " AND due_on <= CAST(:t AS date) + 3"), {"t": today, "v": r.venture_id})
            told += 1
        except Exception:  # noqa: BLE001 - one business's problem never stops the others
            log.exception("bill reminder failed for %s", r.venture_id)
    return told


async def gstr1_ready(services, today: date | None = None) -> int:
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.owner_news import tell_admins
    today = today or datetime.now(IST).date()
    if today.day != 3:
        return 0
    last = today.replace(day=1) - timedelta(days=1)
    first = last.replace(day=1)
    async with tenant_tx(None, "system") as conn:
        rows = (await conn.execute(text("SELECT * FROM private.gstr1_targets(:a, :b)"), {"a": first, "b": last})).all()
    told = 0
    month = first.strftime("%B %Y")
    for r in rows:
        if r.run_as is None:
            continue
        try:
            async with tenant_tx(r.run_as) as conn:
                await tell_admins(
                    services, conn, r.venture_id, subject=f"GSTR-1 for {month} is ready",
                    body=(f"{r.invoices} tax invoice{'s' if r.invoices != 1 else ''} from {month} are in the GSTR-1 "
                          f"sheet. Download it (Excel or JSON) for your accountant or the GST offline tool; it is due "
                          f"by 11 {today.strftime('%B')}. Kritvia doesn't file it."),
                    path=f"/v/{r.venture_id}/money?tab=gst&month={first.strftime('%Y-%m')}", tag=f"gstr1-{r.venture_id}")
            told += 1
        except Exception:  # noqa: BLE001
            log.exception("GSTR-1 note failed for %s", r.venture_id)
    return told
