"""Trade agents, for exporters, importers and C&F agents.

trade_watch (daily, at the time you set)
  watch   every open shipment file's cut-off, sailing and arrival dates, LC dates, export proceeds to
          realise, cargo waiting at port, documents still needed and C&F jobs not billed, plus the LUT
          -> one short list for the team: Telegram for those who linked it, otherwise email to the
             business's owners and admins, a phone notification, and the list kept in the run.
          Nothing goes to a customer. Written by code from the files: nothing is guessed.

trade_update (from a file's "Send update")
  draft   a status update to the buyer, supplier or client, written from the file (stage, vessel, BL,
          container, ETD/ETA, shipping bill or bill of entry) plus an optional line from the team
          -> [approval: gmail.send / whatsapp.send]
  sent    sends it and notes it on the file's timeline
"""
from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Interrupt, Option, Workflow, registry
from kritvia_api.services import trade as tr

IST = ZoneInfo("Asia/Kolkata")

watch_wf = registry.register(Workflow(
    "trade_watch", title="Shipment watch", start="watch", venture_kinds=("trade", "general"),
    trigger="Every morning at the time you set",
    description="Each morning, a short list of what needs doing on your shipments: cut-offs with documents "
                "missing, sailings and arrivals, LC expiry, export proceeds to realise, cargo waiting at port "
                "and C&F jobs not billed.",
    options=(
        Option("quiet", "Stay quiet on days when nothing needs attention", "boolean", True),
    )))

update_wf = registry.register(Workflow(
    "trade_update", title="Shipment updates", start="draft", venture_kinds=("trade", "general"),
    trigger="When you choose Send update on a shipment",
    description="Writes a status update to your buyer, supplier or client from the shipment file and sends it "
                "by email or WhatsApp after your yes."))

MAX_LINES = 40


@watch_wf.step("watch", agent="trade_watch")
async def watch(ctx: RunContext, state: dict) -> Finish:
    today = datetime.now(IST).date()
    async with ctx.tx() as conn:
        rows = (await conn.execute(text(
            "SELECT * FROM shipments WHERE venture_id = :v AND (stage NOT IN ('closed', 'cancelled')"
            " OR (stage = 'closed' AND for_client AND invoice_id IS NULL AND coalesce(fee_paise, 0) > 0"
            "     AND updated_at > now() - interval '30 days'))"
            " ORDER BY coalesce(cutoff_at, etd::timestamptz, eta::timestamptz, updated_at) LIMIT 500"),
            {"v": ctx.venture_id})).all()
        docs: dict = {r.id: [] for r in rows}
        if rows:
            for d in (await conn.execute(text("SELECT * FROM shipment_docs WHERE shipment_id = ANY (:ids)"),
                                         {"ids": list(docs)})).all():
                docs[d.shipment_id].append(d)
        prof = (await conn.execute(text("SELECT roles, lut_arn, lut_valid_until FROM trade_profiles WHERE venture_id = :v"),
                                   {"v": ctx.venture_id})).first()
    lines: list[tuple[int, str]] = []
    urgent = 0
    for s in rows:
        for a in tr.alerts(s, docs[s.id], today):
            rank = {"urgent": 0, "soon": 1, "info": 2}[a.level]
            urgent += rank == 0
            lines.append((rank, f"{'❗ ' if rank == 0 else '• '}{s.number} ({s.party_name}): {a.text}"))
    la = tr.lut_alert(prof, today)
    if la and la.level != "info":
        lines.append(({"urgent": 0, "soon": 1}[la.level], f"{'❗ ' if la.level == 'urgent' else '• '}{la.text}"))
        urgent += la.level == "urgent"
    lines.sort(key=lambda x: x[0])
    summary = {"open_files": len(rows), "items": len(lines), "urgent": urgent}
    if not lines:
        cfg = await ctx.settings()
        if cfg.get("quiet", True):
            return Finish("all_clear", update={"summary": summary}, note=f"{len(rows)} open file(s); nothing needs attention")
    biz = await ctx.business()
    head = (f"{len(lines)} thing(s) to look at on {len(rows)} open shipment file(s)" if lines
            else f"All {len(rows)} open shipment file(s) are on track")
    body = "\n".join(t for _, t in lines[:MAX_LINES]) + (f"\n…and {len(lines) - MAX_LINES} more in Kritvia" if len(lines) > MAX_LINES else "")
    subject = f"{biz.name}: {head}"[:120]
    path = f"/v/{ctx.venture_id}/shipments"
    done = await _tell_team(ctx, subject, body or head, path)
    if lines:
        from kritvia_api.services.push import notify_venture
        try:
            await notify_venture(ctx.venture_id, title="Shipments need attention",
                                 body=f"{len(lines)} item(s), {urgent} urgent", url=path, tag=f"trade-watch-{today}")
        except Exception:   # noqa: BLE001 - a notification never fails the run
            ctx.note("phone notification not sent")
    return Finish("told_team", update={"summary": {**summary, "text": body[:4000]}}, note=done)


async def _tell_team(ctx: RunContext, subject: str, body: str, path: str) -> str:
    """Telegram for each owner/admin who linked it, email for the others."""
    from kritvia_api.config import get_settings
    from kritvia_api.services import chat_approvals
    from kritvia_api.services.mailer import get_mailer
    from kritvia_api.services.telegram import TelegramError
    async with ctx.tx() as conn:
        people = (await conn.execute(text("SELECT * FROM private.venture_admin_people(:v)"), {"v": ctx.venture_id})).all()
        chats = {r.user_id: r.external_id for r in (await conn.execute(text(
            "SELECT user_id, external_id FROM approver_links WHERE venture_id = :v AND channel = 'telegram'"),
            {"v": ctx.venture_id})).all()}
    bot = await chat_approvals.telegram_bot(ctx.venture_id) if chats else None
    link = get_settings().public_web_url.rstrip("/") + path
    tg = mail = 0
    for p in people:
        chat = chats.get(p.user_id)
        if bot is not None and chat:
            try:
                await ctx.services.telegram.call(bot.token, "sendMessage",
                                                 {"chat_id": int(chat), "text": f"{subject}\n\n{body}\n\n{link}"[:4000]})
                tg += 1
                continue
            except TelegramError as exc:
                ctx.note(f"Telegram didn't take it ({exc})")
        if p.email:
            await get_mailer().send(p.email, subject, f"{body}\n\nOpen your shipments: {link}\n\n"
                                                      "Shipment watch, Kritvia. Change its time or switch it off under Agents.")
            mail += 1
    return f"sent to {tg} Telegram chat(s) and {mail} email address(es)" if tg or mail else "kept in the app"


# ------------------------------------------------------------------------------- update --
async def _shipment(ctx: RunContext, shipment_id: str):
    async with ctx.tx() as conn:
        return (await conn.execute(text("SELECT * FROM shipments WHERE id = :s AND venture_id = :v"),
                                   {"s": uuid.UUID(shipment_id), "v": ctx.venture_id})).first()


@update_wf.step("draft", agent="trade_update")
async def draft(ctx: RunContext, state: dict) -> Interrupt | Finish:
    inp = state["input"]
    s = await _shipment(ctx, inp["shipment_id"])
    if s is None:
        return Finish("not_needed", note="the file was deleted")
    biz = await ctx.business()
    async with ctx.tx() as conn:
        legal = (await conn.execute(text("SELECT legal_name FROM trade_profiles WHERE venture_id = :v"),
                                    {"v": ctx.venture_id})).scalar()
    name = legal or biz.name
    msg = tr.status_message(s, name, tr.stage_label(s.direction, s.stage), inp.get("note") or "")
    channel = inp.get("channel") or "email"
    if channel == "whatsapp":
        if not s.party_phone:
            return Finish("no_phone", note="no phone number on the file")
        action, payload = "whatsapp.send", {"to": s.party_phone, "body": msg}
    else:
        if not s.party_email:
            return Finish("no_email", note="no email address on the file")
        action = "gmail.send"
        payload = {"to": s.party_email, "subject": f"{s.number}: {tr.stage_label(s.direction, s.stage)}"[:120],
                   "body": biz.with_notice(msg), "thread_id": None}
    return Interrupt(
        ApprovalRequest(agent="trade_update", action=action, key="send_decision",
                        title=f"Update to {s.party_name} on {s.number}"[:140],
                        summary=f"{tr.stage_label(s.direction, s.stage)}, by {channel}."[:300], payload=payload,
                        required_roles=("approver", "venture_admin"), expires_in_hours=48),
        resume="sent", on_reject="skipped", update={"action": action, "shipment_id": str(s.id), "channel": channel},
        note=f"update drafted ({channel})")


@update_wf.step("sent", agent="trade_update")
async def sent(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.tools import AlreadyExecuted
    s = await _shipment(ctx, state["shipment_id"])
    try:
        res = await ctx.invoke(state["action"], approval_id=state["send_decision"]["approval_id"])
    except AlreadyExecuted as done:
        res = (done.args[0] if done.args else None) or {}
    if s is not None:
        async with ctx.tx() as conn:
            await conn.execute(text("UPDATE shipments SET last_update_at = now() WHERE id = :s"), {"s": s.id})
            await conn.execute(text(
                "INSERT INTO shipment_events (org_id, venture_id, shipment_id, kind, text, stage)"
                " VALUES (:o, :v, :s, 'update_sent', :t, :st)"),
                {"o": s.org_id, "v": s.venture_id, "s": s.id, "st": s.stage,
                 "t": f"Update sent to {s.party_name} by {state.get('channel', 'email')}"})
    return Finish("sent", note=f"update {res.get('status')} via {res.get('transport')}")


@update_wf.step("skipped", agent="trade_update")
async def skipped(ctx: RunContext, state: dict) -> Finish:
    return Finish("not_sent")
