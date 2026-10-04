"""Inbound connectors: turn new Gmail messages into workflow runs.

Runs as each venture's agent runtime (never as a human). What a venture polls
for depends on the workflows it has enabled:

  inbox_assistant   new inbox mail            -> one run per message; hands enquiries to lead_triage
  lead_triage       new inbox mail            -> one run per message (only when inbox_assistant is off)
  kitchen_daily     aggregator report emails  -> CSV attachments stored as 'report' documents,
                                                 parsed by the 23:30 run
  loan_verification mail whose subject carries an application reference (TRU-...)
                                              -> attachments added to that application + a run
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.engine.context import RunContext, Services
from kritvia_api.engine.runner import DuplicateTrigger, start_run
from kritvia_api.services import memory
from kritvia_api.services.messaging import load_google

log = logging.getLogger("kritvia.pollers")

DEFAULT_QUERIES = {
    "inbox_assistant": "in:inbox -category:promotions -category:social newer_than:2d",
    "lead_triage": "in:inbox -category:promotions -category:social -category:updates newer_than:2d",
    "kitchen_daily": "has:attachment (from:swiggy.in OR from:zomato.com OR subject:report) newer_than:3d",
    "loan_verification": "has:attachment subject:TRU- newer_than:7d",
}
REF = re.compile(r"\bTRU-\d{4}-\d{5}-[0-9A-F]{4}\b")
# Sales reports are trusted only from the delivery apps' own domains, or from senders the business lists
# (kitchen_daily setting "report_senders"), and only when Gmail confirms the sender really sent them.
AGGREGATOR_DOMAINS = ("swiggy.in", "zomato.com")


async def poll_gmail_all(services: Services) -> dict[str, int]:
    async with tenant_tx(None, "system") as conn:
        conns = (await conn.execute(text("SELECT * FROM private.active_connectors('google')"))).all()
    totals: dict[str, int] = {}
    for c in conns:
        try:
            got = await poll_gmail_venture(services, c.org_id, c.venture_id, c.run_as)
            for k, v in got.items():
                totals[k] = totals.get(k, 0) + v
        except Exception as exc:  # one venture's failure never blocks the others
            log.exception("gmail poll failed for venture %s", c.venture_id)
            async with tenant_tx(c.run_as, "agent", "gmail_poller") as conn:
                await conn.execute(text("UPDATE connectors SET last_error = :e, updated_at = now() WHERE id = :id"),
                                   {"e": f"{type(exc).__name__}: {exc}"[:300], "id": c.connector_id})
    return totals


async def poll_gmail_venture(services: Services, org_id: uuid.UUID, venture_id: uuid.UUID,
                             run_as: uuid.UUID) -> dict[str, int]:
    google = services.google
    if google is None or not google.configured:
        return {}
    ctx = RunContext(run_id=uuid.uuid4(), org_id=org_id, venture_id=venture_id, run_as=run_as, workflow="gmail_poller",
                     services=services, agent="gmail_poller")
    async with ctx.tx() as conn:
        g = await load_google(ctx, conn)
        configs = {r.workflow: dict(r.settings) for r in (await conn.execute(text(
            "SELECT workflow, settings FROM workflow_configs WHERE venture_id = :v AND enabled"),
            {"v": venture_id})).all()}
    if g is None:
        return {}
    token = await google.access_token(g.id, g.refresh_token)
    counts: dict[str, int] = {}
    for wf, settings in configs.items():
        if wf not in DEFAULT_QUERIES or not settings.get("poll_gmail", True):
            continue
        if wf == "lead_triage" and "inbox_assistant" in configs:
            continue   # the inbox assistant reads the inbox and hands enquiries over
        query = settings.get("gmail_query") or DEFAULT_QUERIES[wf]
        ids = await google.list_message_ids(token, query, max_results=int(settings.get("poll_max", 20)))
        for mid in ids:
            if await _seen(ctx, f"gmail:{wf}", mid):
                continue
            msg = await google.get_message(token, mid)
            if g.email and msg.sender_email == g.email.lower():
                await _mark(ctx, f"gmail:{wf}", mid)   # our own sent mail
                continue
            n = await HANDLERS[wf](ctx, services, token, msg)
            counts[wf] = counts.get(wf, 0) + n
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE connectors SET cursor = now()::text, last_error = NULL, updated_at = now()"
                                " WHERE id = :id"), {"id": g.id})
    return counts


async def _seen(ctx: RunContext, source: str, external_id: str) -> bool:
    async with ctx.tx() as conn:
        return (await conn.execute(text("SELECT 1 FROM trigger_events WHERE venture_id = :v AND source = :s"
                                        " AND external_id = :x"),
                                   {"v": ctx.venture_id, "s": source, "x": external_id})).first() is not None


async def _mark(ctx: RunContext, source: str, external_id: str) -> None:
    async with ctx.tx() as conn:
        await conn.execute(text("INSERT INTO trigger_events (org_id, venture_id, source, external_id)"
                                " VALUES (:o, :v, :s, :x) ON CONFLICT DO NOTHING"),
                           {"o": ctx.org_id, "v": ctx.venture_id, "s": source, "x": external_id})


async def _lead(ctx: RunContext, services: Services, token: str, msg) -> int:
    try:
        await start_run(services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                        workflow="lead_triage", trigger_kind="email", trigger_ref=msg.id,
                        dedupe=("gmail:lead_triage", msg.id), title=f"Email: {msg.subject[:120]}",
                        input={"source": "email", "from_name": msg.sender, "from_email": msg.sender_email,
                               "subject": msg.subject, "body": msg.body[:20000], "thread_id": msg.thread_id,
                               "message_id": msg.id})
        return 1
    except DuplicateTrigger:
        return 0


async def _report_sender_ok(ctx: RunContext, msg) -> bool:
    if not msg.authenticated:
        return False
    domain = msg.sender_email.rsplit("@", 1)[-1]
    if any(domain == d or domain.endswith("." + d) for d in AGGREGATOR_DOMAINS):
        return True
    async with ctx.tx() as conn:
        listed = (await conn.execute(text(
            "SELECT settings->'report_senders' FROM workflow_configs WHERE venture_id = :v AND workflow = 'kitchen_daily'"),
            {"v": ctx.venture_id})).scalar()
    return isinstance(listed, list) and msg.sender_email in {str(x).lower() for x in listed}


async def _kitchen_report(ctx: RunContext, services: Services, token: str, msg) -> int:
    if not await _report_sender_ok(ctx, msg):
        log.warning("ignoring a sales report from an unverified or unlisted sender")
        await _mark(ctx, "gmail:kitchen_daily", msg.id)
        return 0
    stored = 0
    for att in msg.attachments:
        if not att["filename"].lower().endswith(".csv") or att.get("size", 0) > 10_000_000:
            continue
        data = await services.google.get_attachment(token, msg.id, att["attachment_id"])
        res = await memory.ingest(ctx, title=att["filename"], kind="report", data=data, filename=att["filename"],
                                  mime="text/csv", external_id=msg.id, extract_knowledge=False,
                                  meta={"parsed": False, "from": msg.sender_email})
        stored += 0 if res.duplicate else 1
    if not msg.attachments and msg.body:
        res = await memory.ingest(ctx, title=msg.subject or "Sales report", kind="report", data=msg.body.encode(),
                                  filename="report.txt", mime="text/plain", external_id=msg.id,
                                  extract_knowledge=False, meta={"parsed": False, "from": msg.sender_email})
        stored += 0 if res.duplicate else 1
    await _mark(ctx, "gmail:kitchen_daily", msg.id)
    return stored


async def _loan_docs(ctx: RunContext, services: Services, token: str, msg) -> int:
    from kritvia_api.routers.truhome import attach_documents

    m = REF.search(msg.subject or "")
    await _mark(ctx, "gmail:loan_verification", msg.id)
    if not m:
        return 0
    async with ctx.tx() as conn:
        app = (await conn.execute(text("SELECT id, data_principal, applicant_enc FROM loan_applications"
                                       " WHERE venture_id = :v AND reference = :r"),
                                  {"v": ctx.venture_id, "r": m.group(0)})).first()
        applicant = (json.loads(await ctx.crypto(conn).decrypt(ctx.venture_id, "loan_applications.applicant",
                                                               app.applicant_enc)) if app else {})
    if app is None:
        return 0
    if (applicant.get("email") or "").lower() != msg.sender_email:
        log.warning("ignoring documents for %s from a sender that is not the applicant", m.group(0))
        return 0
    if not msg.authenticated:   # a forged From: would otherwise slip identity papers into the file
        log.warning("ignoring documents for %s: Gmail could not confirm the sender", m.group(0))
        return 0
    files: list[tuple[str, Any, bytes]] = []
    for att in msg.attachments[:10]:
        if att["filename"].lower().endswith((".pdf", ".jpg", ".jpeg", ".png", ".webp")) and att.get("size", 0) < 15e6:
            files.append((att["filename"], att["mime"], await services.google.get_attachment(token, msg.id,
                                                                                             att["attachment_id"])))
    if not files:
        return 0
    await attach_documents(ctx, app.id, files, None, app.data_principal)
    await start_run(services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                    workflow="loan_verification", input={"application_id": str(app.id)}, trigger_kind="email",
                    trigger_ref=msg.id, title="Verify emailed documents")
    return len(files)


async def _inbox(ctx: RunContext, services: Services, token: str, msg) -> int:
    from kritvia_api.workflows.inbox import message_input
    try:
        await start_run(services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                        workflow="inbox_assistant", trigger_kind="email", trigger_ref=msg.id,
                        dedupe=("gmail:inbox_assistant", msg.id), title=f"Email: {msg.subject[:120]}",
                        input=message_input(channel="email", from_name=msg.sender, from_email=msg.sender_email,
                                            subject=msg.subject, body=msg.body, message_id=msg.id,
                                            thread_id=msg.thread_id))
        return 1
    except DuplicateTrigger:
        return 0


HANDLERS = {"inbox_assistant": _inbox, "lead_triage": _lead, "kitchen_daily": _kitchen_report,
            "loan_verification": _loan_docs}
