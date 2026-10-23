"""Inbound connectors: turn new Gmail messages into workflow runs.

Runs as each venture's agent runtime (never as a human). What a venture polls
for depends on the workflows it has enabled:

  inbox_assistant   new inbox mail            -> one run per message; hands enquiries to lead_triage
  lead_triage       new inbox mail            -> one run per message (only when inbox_assistant is off)
  kitchen_daily     aggregator report emails  -> CSV attachments stored as 'report' documents,
                                                 parsed by the 23:30 run
  loan_verification mail whose subject carries an application reference (TRU-...)
                                              -> attachments added to that application + a run
  (Money)           a bank's statement email  -> its CSV/Excel/PDF read into Money → Bank, matched to invoices and
                                                 bills, owners told (services/bank.py says which senders count)

Forwarded mail (deliver_forwarded) is handled the same way, except that when the business's Gmail is connected
with read access for the same mailbox, the poller already reads that email: the forwarded copy then only feeds
the attachment readers (CVs, bills, statements, which the poller doesn't) and is otherwise left alone, so one
email is never answered twice.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.services.quota import read_only
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
    # Only when the inbox assistant is off (it matches prospects itself): notice replies from prospects
    # so their follow-ups stop.
    "prospector": "in:inbox newer_than:2d",
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
        async with tenant_tx(None, "system") as conn:
            if await read_only(conn, venture_id=c.venture_id):
                continue   # free trial ended without a plan: nothing new comes in until one is chosen
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
    from kritvia_api.services.google import SCOPES
    if SCOPES["gmail.readonly"] not in g.scopes:
        return {}   # connected to send only; this business's mail arrives by forwarding (email_in)
    token = await google.access_token(g.id, g.refresh_token)
    counts: dict[str, int] = {}
    for wf, settings in configs.items():
        if wf not in DEFAULT_QUERIES or not settings.get("poll_gmail", True):
            continue
        if wf in ("lead_triage", "prospector") and "inbox_assistant" in configs:
            continue   # the inbox assistant reads the inbox, hands enquiries over and spots prospect replies
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
    try:
        async with ctx.tx() as conn:
            on = (await conn.execute(text("SELECT statements_by_email FROM cash_settings WHERE venture_id = :v"),
                                     {"v": venture_id})).scalar()
        if on is not False:
            if (n := await poll_statements(ctx, services, token, g.email)):
                counts["statements"] = n
    except Exception:  # noqa: BLE001 - a statement problem never stops the inbox
        log.warning("statement scan failed for %s", venture_id, exc_info=True)
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
                                            thread_id=msg.thread_id, sender_verified=msg.authenticated,
                                            automated=getattr(msg, "automated", False)))
        return 1
    except DuplicateTrigger:
        return 0


async def _prospect_reply(ctx: RunContext, services: Services, token: str, msg) -> int:
    """A prospect wrote back: stop their follow-ups (no run; the owner answers from Gmail)."""
    from kritvia_api.workflows.prospector import match_reply
    async with ctx.tx() as conn:
        hit = await match_reply(conn, ctx.venture_id, email=msg.sender_email, phone=None,
                                thread_id=msg.thread_id, body=msg.body)
    await _mark(ctx, "gmail:prospector", msg.id)
    return 1 if hit else 0


HANDLERS = {"inbox_assistant": _inbox, "prospector": _prospect_reply, "lead_triage": _lead, "kitchen_daily": _kitchen_report,
            "loan_verification": _loan_docs}


# --------------------------------------------------------------------- forwarded mail --
async def deliver_forwarded(services: Services, org_id: uuid.UUID, venture_id: uuid.UUID, run_as: uuid.UUID,
                            msg) -> dict[str, int]:
    """Mail the business forwarded to its Kritvia address: the inbox assistant answers it (or lead
    triage when the assistant is off), and a prospect's reply stops their follow-ups.

    Forwarded mail can't be checked for who really sent it, so it never files loan documents or
    sales reports; those workflows still need Gmail connected with read access."""
    ctx = RunContext(run_id=uuid.uuid4(), org_id=org_id, venture_id=venture_id, run_as=run_as,
                     workflow="email_in", services=services, agent="email_in")
    async with ctx.tx() as conn:
        on = {r.workflow for r in (await conn.execute(text(
            "SELECT workflow FROM workflow_configs WHERE venture_id = :v AND enabled"), {"v": venture_id})).all()}
    counts: dict[str, int] = {}
    from kritvia_api.services import people
    if await people.cv_forwarded(ctx, services, msg):
        return {"hiring": 1}
    if await _bill_forwarded(ctx, services, msg):
        return {"bills": 1}
    if await statement_mail(ctx, services, msg.sender_email, msg.subject, msg.attachments, verified=False):
        return {"statements": 1}
    if await gmail_reads(ctx, msg):
        return {"read_by_gmail": 1}
    if "inbox_assistant" in on:
        counts["inbox_assistant"] = await _inbox_forwarded(ctx, services, msg)
        return counts
    if "prospector" in on:
        counts["prospector"] = await _prospect_reply(ctx, services, "", msg)
    if "lead_triage" in on and not counts.get("prospector"):
        counts["lead_triage"] = await _lead_forwarded(ctx, services, msg)
    return counts


def forwarded_from(msg) -> str | None:
    """The mailbox that forwarded this email: Gmail adds X-Forwarded-For: <mailbox> <our address>."""
    raw = (getattr(msg, "headers", None) or {}).get("x-forwarded-for", "")
    first = raw.replace(",", " ").split()
    return first[0].strip("<>").lower() if first and "@" in first[0] else None


async def gmail_reads(ctx: RunContext, msg) -> bool:
    """True when this business's Gmail connection already reads the mailbox the email was forwarded from (or
    sent to), so the poller handles it and the forwarded copy would only answer it a second time."""
    from kritvia_api.services.google import SCOPES
    who = {a.strip().lower() for a in (msg.to or "").split(",") if "@" in a}
    if (f := forwarded_from(msg)):
        who.add(f)
    if not who:
        return False
    async with ctx.tx() as conn:
        g = (await conn.execute(text(
            "SELECT lower(account_email) AS email, scopes FROM connectors WHERE venture_id = :v AND provider = 'google'"
            " AND status = 'active' AND last_error IS NULL"), {"v": ctx.venture_id})).first()
    return bool(g and g.email in who and SCOPES["gmail.readonly"] in (g.scopes or []))


async def statement_mail(ctx: RunContext, services: Services, sender: str, subject: str, attachments: list[dict],
                         *, verified: bool, fetch=None) -> bool:
    """A bank's statement email: its file is read into Money → Bank and matched, and the owners are told how
    many payments it shows. `fetch(att)` returns the file's bytes when the attachment only carries an id."""
    from kritvia_api.routers.bank import ImportProblem, import_statement, statement_password
    from kritvia_api.services import bank
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.owner_news import tell_admins
    att = bank.statement_attachment(sender, subject, attachments)
    if att is None:
        return False
    async with ctx.tx() as conn:
        on = (await conn.execute(text("SELECT statements_by_email FROM cash_settings WHERE venture_id = :v"),
                                 {"v": ctx.venture_id})).scalar()
    if on is False:
        return False
    data = att.get("data") if att.get("data") is not None else (await fetch(att) if fetch else b"")
    name = str(att.get("filename") or "statement.pdf")
    mime = "application/pdf" if name.lower().endswith(".pdf") else (
        "text/csv" if name.lower().endswith(".csv") else
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    bank_name = sender.lower().rpartition("@")[2]
    async with ctx.tx() as conn:
        try:
            pw = await statement_password(conn, EnvelopeCrypto(conn, services.keys), ctx.venture_id) \
                if bank.pdf_encrypted(data or b"") else None
            got = await import_statement(conn, org=ctx.org_id, venture_id=ctx.venture_id, data=data or b"",
                                         filename=name, mime=mime, account_label=bank_name, uploaded_by=None,
                                         password=pw, source="email", sender=sender, verified=verified)
            subject_out = (f"Bank statement read: {got.new_lines} new line{'s' if got.new_lines != 1 else ''}"
                           f"{f', {got.sure} sure matches' if got.sure else ''}")
            body = (f"The statement from {bank_name} ({subject[:120]}) is in Money → Bank: {got.new_lines} new lines, "
                    f"{got.sure} matched for sure and {got.likely} likely. Nothing is recorded until someone confirms."
                    + ("" if verified else " It came by forwarded email, so check each match against your bank."))
        except ImportProblem as exc:
            subject_out = "A bank statement couldn't be read"
            body = f"Kritvia got a statement from {bank_name} by email but couldn't read it: {exc}."
        await tell_admins(services, conn, ctx.venture_id, subject=subject_out, body=body,
                          path=f"/v/{ctx.venture_id}/money?tab=bank", tag=f"statement-{ctx.venture_id}")
    return True


async def poll_statements(ctx: RunContext, services: Services, token: str, own_email: str | None) -> int:
    """Statement emails in the connected Gmail (the last 3 days), each once."""
    google = services.google
    ids = await google.list_message_ids(
        token, "has:attachment newer_than:3d (subject:statement OR subject:e-statement)", max_results=10)
    n = 0
    for mid in ids:
        if await _seen(ctx, "gmail:bank_statement", mid):
            continue
        msg = await google.get_message(token, mid)
        await _mark(ctx, "gmail:bank_statement", mid)
        if own_email and msg.sender_email == own_email.lower():
            continue

        async def fetch(att, _mid=mid):
            return await google.get_attachment(token, _mid, att["attachment_id"])
        if await statement_mail(ctx, services, msg.sender_email, msg.subject, msg.attachments,
                                verified=msg.authenticated, fetch=fetch):
            n += 1
    return n


async def _inbox_forwarded(ctx: RunContext, services: Services, msg) -> int:
    from kritvia_api.services.auto_reply import automated_sender
    from kritvia_api.workflows.inbox import message_input
    try:
        await start_run(services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                        workflow="inbox_assistant", trigger_kind="email", trigger_ref=msg.id[:200],
                        dedupe=("email_in:inbox_assistant", msg.id), title=f"Email: {msg.subject[:120]}",
                        input=message_input(channel="email", from_name=msg.sender, from_email=msg.sender_email,
                                            subject=msg.subject, body=msg.body, message_id=None, thread_id=None,
                                            automated=automated_sender(msg.sender_email, msg.headers)))
        return 1
    except DuplicateTrigger:
        return 0


async def _lead_forwarded(ctx: RunContext, services: Services, msg) -> int:
    try:
        await start_run(services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                        workflow="lead_triage", trigger_kind="email", trigger_ref=msg.id[:200],
                        dedupe=("email_in:lead_triage", msg.id), title=f"Email: {msg.subject[:120]}",
                        input={"source": "email", "from_name": msg.sender, "from_email": msg.sender_email,
                               "subject": msg.subject, "body": msg.body[:20000], "thread_id": None,
                               "message_id": None})
        return 1
    except DuplicateTrigger:
        return 0


BILL_SUBJECT = re.compile(r"\b(invoice|bill|tax invoice|payment due|proforma|statement of account|बिल)\b", re.I)
BILL_FILES = (".pdf", ".png", ".jpg", ".jpeg", ".webp")


def _sender_checked(msg) -> bool:
    """A forwarded bill is trusted a little only when the business's own mailbox forwarded it and Cloudflare
    verified its From domain; mail sent straight to the Kritvia address is marked unverified."""
    return bool(forwarded_from(msg)) and bool(getattr(msg, "authenticated", False))


async def _bill_forwarded(ctx: RunContext, services: Services, msg) -> bool:
    """A supplier's bill forwarded to the business's Kritvia address (a bill or invoice in the subject, with a
    PDF or photo): read and filed under Money → Bills, marked as from email so a person checks it is real
    before paying. Kritvia never pays a bill."""
    import asyncio

    from kritvia_api.routers.bills import read_bill_text
    from kritvia_api.services.textextract import ExtractionError, extract_text
    if not BILL_SUBJECT.search(msg.subject or ""):
        return False
    files = [a for a in msg.attachments if str(a.get("filename", "")).lower().endswith(BILL_FILES)
             and 0 < int(a.get("size") or 0) <= 15 * 1024 * 1024]
    if not files:
        return False
    f = files[0]
    try:
        ex = await asyncio.to_thread(extract_text, f["data"], f["filename"], f.get("mime") or "application/pdf")
    except ExtractionError:
        return False
    body = (ex.text or "").strip()
    if len(body) < 20:
        return False
    async with ctx.tx() as conn:
        biz = (await conn.execute(text("SELECT business_name FROM venture_settings WHERE venture_id = :v"),
                                  {"v": ctx.venture_id})).scalar()
    try:
        d = await read_bill_text(services, ctx.org_id, ctx.venture_id, ctx.run_as, body, biz, agent=True)
    except Exception:  # noqa: BLE001 - unreadable: the email goes on to the inbox as usual
        log.info("forwarded bill not readable", exc_info=True)
        return False
    if not d.amount_paise or not d.vendor:
        return False
    try:
        async with ctx.tx() as conn:
            await conn.execute(text(
                "INSERT INTO bills (org_id, venture_id, vendor, number, vendor_gstin, amount_paise, gst_paise,"
                " bill_date, due_on, category, notes, source)"
                " VALUES (:o, :v, :ve, :n, :g, :a, :gst, :bd, :d, :c, :no, 'email')"),
                {"o": ctx.org_id, "v": ctx.venture_id, "ve": d.vendor, "n": d.number, "g": d.vendor_gstin,
                 "a": d.amount_paise, "gst": d.gst_paise, "bd": d.bill_date, "d": d.due_on, "c": d.category,
                 "no": (("" if _sender_checked(msg) else "UNVERIFIED SENDER: this email came straight to the"
                         " Kritvia address (not forwarded from your own mailbox) or its sender couldn't be"
                         " checked. ") + f"From an email from {msg.sender_email}: {msg.subject}"[:800]
                        + ". Check it is genuine before paying.")})
    except Exception:  # noqa: BLE001 - most often the same bill forwarded twice (bills_number_uq)
        log.info("forwarded bill not filed", exc_info=True)
        return True
    return True
