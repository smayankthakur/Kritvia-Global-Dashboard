"""IndiaMART enquiries, by themselves: the Lead Manager "Pull API".

The owner generates a key in IndiaMART (Lead Manager → ⋮ → Import/Export Leads → Pull API, or
seller.indiamart.com/leadmanager/crmapi → Generate Key) and pastes it into Settings → Connectors. It is
checked once with IndiaMART, then stored encrypted with the business's key.

Every 10 minutes the worker asks IndiaMART for the enquiries since the last window, starting 5 minutes
before it ended (IndiaMART's own advice; the overlap is harmless because each enquiry's UNIQUE_QUERY_ID
is the run's dedupe key). Each new enquiry starts Lead triage, which scores it, files the lead and
drafts the reply for approval, exactly like a website form.

IndiaMART's rules, as documented (help.indiamart.com/knowledge-base/lms-crm-integration-v2):
  - GET https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=…&start_time=…&end_time=…
  - times in IST, "DD-Mon-YYYYHH:MM:SS"; at most 7 days per call; only the last 365 days
  - at most one call per 5 minutes; more than 5 in a minute blocks the key for 15 minutes
  - CODE 200 with RESPONSE[], 204 "no leads", 401 wrong or expired key (unused for 7 days, or a newer
    key was generated), 429 too soon, 400 bad dates, 500 their side
  - QUERY_TYPE: W direct enquiry, B buy-lead, P call (PNS), BIZ catalog view, WA WhatsApp
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import text

from kritvia_api.db.session import tenant_tx

log = logging.getLogger("kritvia.indiamart")
URL = "https://mapi.indiamart.com/wservce/crm/crmListing/v2/"
SECRET = "connector.secret"
IST = ZoneInfo("Asia/Kolkata")
OVERLAP = timedelta(minutes=5)
MAX_WINDOW = timedelta(days=7) - timedelta(minutes=1)
FIRST_WINDOW = timedelta(hours=24)
PER_RUN = 50                       # enquiries started per business per poll; the rest wait for the next one
KINDS = {"W": "Direct enquiry", "B": "Buy-lead", "P": "Phone call", "BIZ": "Catalog view", "WA": "WhatsApp"}


class IndiaMartError(Exception):
    """Something the owner can act on (wrong or expired key)."""


class TryLater(Exception):
    """IndiaMART asked us to slow down or had a problem; the next poll tries again."""


def fmt(t: datetime) -> str:
    """IST, as IndiaMART wants it: 05-Oct-202614:30:00."""
    return t.astimezone(IST).strftime("%d-%b-%Y%H:%M:%S")


def window(cursor: datetime | None, now: datetime) -> tuple[datetime, datetime]:
    """From 5 minutes before the last window ended (or the last 24 hours the first time), never more
    than IndiaMART's 7 days."""
    start = (cursor - OVERLAP) if cursor else now - FIRST_WINDOW
    return max(start, now - MAX_WINDOW), now


@dataclass
class Enquiry:
    id: str
    kind: str
    name: str | None
    mobile: str | None
    email: str | None
    company: str | None
    city: str | None
    product: str | None
    subject: str | None
    message: str
    at: str | None

    def lead_input(self) -> dict[str, Any]:
        """Lead triage's input (the same shape as a website form)."""
        lines = [self.message.strip()] if self.message.strip() else []
        for label, v in (("Product", self.product), ("Phone", self.mobile), ("City", self.city),
                         ("IndiaMART", KINDS.get(self.kind, self.kind or "enquiry"))):
            if v:
                lines.append(f"{label}: {v}")
        return {"source": "indiamart", "from_name": self.name, "from_email": self.email, "company": self.company,
                "subject": (self.subject or (f"IndiaMART enquiry: {self.product}" if self.product
                                             else "IndiaMART enquiry"))[:300],
                "body": "\n".join(lines)[:5000]}


def _s(row: dict, *keys: str) -> str | None:
    for k in keys:
        v = row.get(k)
        if isinstance(v, (str, int)) and str(v).strip():
            return str(v).strip()[:500]
    return None


def parse(data: Any) -> list[Enquiry]:
    """IndiaMART's answer -> enquiries. Raises IndiaMartError / TryLater for the documented failures."""
    if not isinstance(data, dict):
        raise TryLater("IndiaMART sent something unexpected")
    code = str(data.get("CODE") or "")
    msg = str(data.get("MESSAGE") or "")[:200]
    if code == "204":
        return []
    if code == "401":
        if "expired" in msg.lower():
            raise IndiaMartError("IndiaMART says this key has expired (keys stop working after 7 days unused, "
                                 "or when a new one is generated). Generate a new key and paste it here.")
        raise IndiaMartError("IndiaMART says this key is wrong. Copy it again from Lead Manager → Pull API.")
    if code == "429":
        raise TryLater("IndiaMART asked us to wait a few minutes")
    if code not in ("200", ""):
        raise TryLater(f"IndiaMART answered {code}: {msg}")
    out = []
    for row in data.get("RESPONSE") or []:
        if not isinstance(row, dict):
            continue
        qid = _s(row, "UNIQUE_QUERY_ID")
        if not qid:
            continue
        email = _s(row, "SENDER_EMAIL")
        out.append(Enquiry(
            id=qid, kind=_s(row, "QUERY_TYPE") or "", name=_s(row, "SENDER_NAME"),
            mobile=_s(row, "SENDER_MOBILE"), email=email if email and "@" in email else None,
            company=_s(row, "SENDER_COMPANY"), city=_s(row, "SENDER_CITY"),
            product=_s(row, "QUERY_PRODUCT_NAME"), subject=_s(row, "SUBJECT"),
            message=str(row.get("QUERY_MESSAGE") or "")[:5000], at=_s(row, "QUERY_TIME")))
    return out


class IndiaMartClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._http = httpx.AsyncClient(transport=transport, timeout=20, follow_redirects=False)

    async def enquiries(self, key: str, start: datetime, end: datetime) -> list[Enquiry]:
        try:
            r = await self._http.get(URL, params={"glusr_crm_key": key, "start_time": fmt(start),
                                                  "end_time": fmt(end)})
            data = r.json()
        except (httpx.HTTPError, ValueError):
            raise TryLater("couldn't reach IndiaMART") from None
        return parse(data)


# ------------------------------------------------------------------ polling --
async def _key(conn, keys, venture_id: uuid.UUID, connector_id: uuid.UUID) -> str | None:
    from kritvia_api.services.crypto import EnvelopeCrypto
    enc = (await conn.execute(text("SELECT secret_enc FROM connector_tokens WHERE connector_id = :c"),
                              {"c": connector_id})).scalar()
    return await EnvelopeCrypto(conn, keys).decrypt_str(venture_id, SECRET, enc) if enc else None


async def pull_venture(services, connector_id: uuid.UUID, venture_id: uuid.UUID, run_as: uuid.UUID,
                       now: datetime | None = None) -> int:
    """New enquiries for one business -> Lead triage runs. Returns how many runs started."""
    now = now or datetime.now(IST)
    async with tenant_tx(run_as, "agent", "indiamart") as conn:
        row = (await conn.execute(text("SELECT cursor FROM connectors WHERE id = :c"), {"c": connector_id})).first()
        key = await _key(conn, services.keys, venture_id, connector_id)
    if row is None or not key:
        return 0
    try:
        cur = datetime.fromisoformat(row.cursor) if row.cursor else None
    except ValueError:
        cur = None
    start, end = window(cur, now)
    try:
        found = await services.indiamart.enquiries(key, start, end)
    except IndiaMartError as exc:
        async with tenant_tx(run_as, "agent", "indiamart") as conn:
            await conn.execute(text("UPDATE connectors SET status = 'error', last_error = :e, updated_at = now()"
                                    " WHERE id = :c"), {"e": str(exc)[:300], "c": connector_id})
        return 0
    except TryLater as exc:
        log.info("indiamart: try later for %s: %s", venture_id, exc)
        return 0
    return await hand_over(services, connector_id, venture_id, run_as, found, end)


async def hand_over(services, connector_id: uuid.UUID | None, venture_id: uuid.UUID, run_as: uuid.UUID,
                    found: list[Enquiry], end: datetime, actor_type: str = "agent") -> int:
    """Start Lead triage for each enquiry (once each) and move the window on when all were handed over.
    connector_id None: the caller records the window itself (connecting, inside its own transaction)."""
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    started, last_error, waiting = 0, None, False
    for e in found:
        if started >= PER_RUN:   # the rest start on the next poll (already-started ones are skipped then)
            waiting = True
            break
        try:
            await start_run(services, actor_user_id=run_as, actor_type=actor_type, venture_id=venture_id,
                            workflow="lead_triage", input=e.lead_input(), trigger_kind="indiamart",
                            dedupe=("indiamart", e.id),
                            title=f"IndiaMART: {e.company or e.name or 'enquiry'}"[:140])
            started += 1
        except DuplicateTrigger:
            continue
        except ValueError as exc:   # Lead triage switched off, or the plan doesn't include it
            last_error = f"IndiaMART enquiries need Lead triage switched on ({str(exc)[:120]})"
            break
    done = last_error is None and not waiting
    if connector_id is None:
        return started
    async with tenant_tx(run_as, "agent", "indiamart") as conn:
        await conn.execute(text(
            "UPDATE connectors SET cursor = coalesce(CAST(:cur AS text), cursor), last_error = :e, updated_at = now()"
            " WHERE id = :c"),
            {"cur": end.isoformat() if done else None, "e": last_error, "c": connector_id})
    return started


async def pull_all(services) -> int:
    from kritvia_api.services.quota import read_only
    async with tenant_tx(None, "system") as conn:
        conns = (await conn.execute(text("SELECT * FROM private.active_connectors('indiamart')"))).all()
    total = 0
    for c in conns:
        async with tenant_tx(None, "system") as conn:
            if await read_only(conn, venture_id=c.venture_id):
                continue
        try:
            total += await pull_venture(services, c.connector_id, c.venture_id, c.run_as)
        except Exception:   # one business's problem never stops the others
            log.exception("indiamart poll failed for venture %s", c.venture_id)
    return total
