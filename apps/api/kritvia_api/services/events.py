"""The business's event stream (migration 0063): one place where everything that happens is written, and every
agent can react to it.

Events are written by database triggers on the records themselves (leads, invoices, payments, bookings, bills,
reviews, opt-outs, campaigns, candidates), so nothing can change without its event. Every minute the worker takes
the events nobody has acted on yet (`dispatch`):

  - skills that start "right after" an event (trigger 'on_event') get one run per event, about that record;
  - "tell me when" alerts (event_alerts) tell the owners and admins, once per event.

Only a short summary is kept on an event; the record itself stays where it is.
"""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text

log = logging.getLogger(__name__)

# What can happen, in words (the Activity page, alerts, and skills that start right after one).
KINDS: dict[str, str] = {
    "lead.new": "A new lead comes in",
    "lead.qualified": "A lead is qualified",
    "lead.won": "A lead is won",
    "lead.lost": "A lead is lost",
    "invoice.drafted": "Kritvia drafts an invoice",
    "invoice.issued": "An invoice is issued",
    "invoice.paid": "An invoice is paid in full",
    "payment.received": "A payment is received",
    "booking.new": "A booking is made",
    "booking.done": "A booking is done",
    "booking.cancelled": "A booking is cancelled",
    "booking.no_show": "A customer doesn't turn up",
    "bill.new": "A supplier bill comes in",
    "bill.paid": "A supplier bill is paid",
    "review.new": "A new Google review",
    "customer.opted_out": "A customer opts out of messages",
    "campaign.sent": "A campaign is sent",
    "candidate.new": "Someone applies for a job",
    "candidate.shortlisted": "A candidate is shortlisted",
    "app.event": "An installed app sends news (App store)",
}
# Kinds whose record a skill can be told about (the same facts as event-started custom workflows).
RECORD_OF = {"leads": "lead", "invoices": "invoice", "bookings": "booking"}
MONEY_KINDS = {"invoice.issued", "invoice.paid", "payment.received", "bill.new", "bill.paid", "invoice.drafted"}
BATCH = 500


def describe(kind: str) -> str:
    return KINDS.get(kind, kind.replace(".", " ").replace("_", " "))


async def dispatch(services, now: datetime | None = None) -> dict[str, int]:
    """Worker, every minute: act on new events. Returns counts (events, skill runs, alerts)."""
    from kritvia_api.db.session import tenant_tx
    async with tenant_tx(None, "system") as conn:
        got = (await conn.execute(text("SELECT * FROM private.claim_events(:n)"), {"n": BATCH})).all()
    if not got:
        return {"events": 0, "skills": 0, "alerts": 0}
    by_venture: dict[uuid.UUID, list[Any]] = defaultdict(list)
    for e in got:
        by_venture[e.venture_id].append(e)
    skills = alerts = 0
    for venture_id, events in by_venture.items():
        try:
            s, a = await _venture(services, venture_id, events, now or datetime.now(UTC))
            skills += s
            alerts += a
        except Exception:  # noqa: BLE001 - one business's problem never holds up the others
            log.exception("events for %s were not acted on", venture_id)
    return {"events": len(got), "skills": skills, "alerts": alerts}


async def _venture(services, venture_id: uuid.UUID, events: list[Any], now: datetime) -> tuple[int, int]:
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.engine.runner import DuplicateTrigger
    from kritvia_api.services import custom_workflows as cw
    from kritvia_api.services import skills as sk
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.quota import PlanRestricted
    run_as = events[0].run_as
    kinds = {e.kind for e in events}
    async with tenant_tx(run_as, "agent", "events") as conn:
        rows = (await conn.execute(text(
            "SELECT id, on_event FROM skills WHERE venture_id = :v AND enabled AND trigger = 'on_event'"
            " AND on_event = ANY(:k)"), {"v": venture_id, "k": list(kinds)})).all()
        crypto = EnvelopeCrypto(conn, services.keys)
        listening = {}
        for r in rows:
            s = await sk.load(conn, crypto, venture_id, r.id)
            if s is not None:
                listening.setdefault(r.on_event, []).append(s)
        wanted = (await conn.execute(text(
            "SELECT id, kind, min_paise FROM event_alerts WHERE venture_id = :v AND kind = ANY(:k)"),
            {"v": venture_id, "k": list(kinds)})).all()
        facts: dict[int, dict[str, Any]] = {}
        for e in events:
            if e.kind in listening and e.subject_table in RECORD_OF and e.subject_id:
                f, _, _ = await cw.record_facts(conn, venture_id, RECORD_OF[e.subject_table], e.subject_id)
                facts[e.id] = f
    started = 0
    for e in events:
        for s in listening.get(e.kind, []):
            record = {"what_happened": e.summary, **facts.get(e.id, {})}
            try:
                await sk.start(services, s, actor_user_id=run_as, actor_type="agent", trigger_kind="event",
                               record=(RECORD_OF.get(e.subject_table, e.subject_table), e.subject_id or uuid.uuid4(),
                                       record),
                               dedupe=("skill_event", f"{s['id']}:{e.id}"))
                started += 1
            except (DuplicateTrigger, PlanRestricted):
                continue
            except Exception:  # noqa: BLE001
                log.exception("skill %s didn't start for event %s", s["id"], e.id)
    told = 0
    if wanted:
        from kritvia_api.services.owner_news import tell_admins
        for e in events:
            for a in wanted:
                if a.kind != e.kind or (a.min_paise and (e.amount_paise or 0) < a.min_paise):
                    continue
                async with tenant_tx(run_as, "agent", "events") as conn:
                    await tell_admins(services, conn, venture_id, subject=e.summary[:120],
                                      body=f"{e.summary}.\n\n({describe(e.kind)}: you asked to be told.)",
                                      path=f"/v/{venture_id}/activity", tag=f"event-{e.id}")
                    await conn.execute(text("UPDATE event_alerts SET last_sent_at = :n WHERE id = :a"),
                                       {"n": now, "a": a.id})
                told += 1
    return started, told


async def recent(conn, venture_id: uuid.UUID, *, limit: int = 50, kind: str | None = None,
                 since: datetime | None = None) -> list[dict[str, Any]]:
    rows = (await conn.execute(text(
        "SELECT id, kind, summary, amount_paise, subject_table, subject_id, occurred_at FROM business_events"
        " WHERE venture_id = :v AND (CAST(:k AS text) IS NULL OR kind = :k)"
        " AND (CAST(:s AS timestamptz) IS NULL OR occurred_at >= :s)"
        " ORDER BY occurred_at DESC, id DESC LIMIT :n"),
        {"v": venture_id, "k": kind, "s": since, "n": limit})).all()
    return [dict(r._mapping) for r in rows]
