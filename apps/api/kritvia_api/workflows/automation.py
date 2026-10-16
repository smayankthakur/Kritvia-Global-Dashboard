"""Automation: one run of a standing request made in plain words ("every Monday send me last week's sales").

  write    the business's numbers for the period (code) + the request -> a short report (the model may
           use only those numbers and the business's documents)
  deliver  to the person who made it: by email, their linked Telegram chat, the business's Slack, or in
           the app (always kept in the app too); to anyone else: an email that waits for a yes
           [approval: gmail.send] -> sent
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Workflow, registry
from kritvia_api.services import automations as au

wf = registry.register(Workflow(
    "automation", title="Automation", start="write",
    trigger="On the schedule you set in plain words",
    description="Runs what you asked for in plain words on a schedule, e.g. 'every Monday send me last week's sales'."))

RESULT_PURPOSE = "automation.result"


class Report(BaseModel):
    subject: str = Field(description="a short title, under 70 characters")
    body: str = Field(description="the report, plain text, under 250 words; numbers copied exactly")


async def _automation(ctx: RunContext, automation_id: str):
    async with ctx.tx() as conn:
        return (await conn.execute(text(
            "SELECT a.*, o.email AS owner_email, o.full_name AS owner_name, coalesce(s.timezone, 'Asia/Kolkata') AS tz"
            " FROM automations a LEFT JOIN LATERAL private.automation_owner(a.id) o ON true"
            " LEFT JOIN venture_settings s ON s.venture_id = a.venture_id WHERE a.id = :a AND a.venture_id = :v"),
            {"a": uuid.UUID(automation_id), "v": ctx.venture_id})).first()


@wf.step("write", agent="automation")
async def write(ctx: RunContext, state: dict) -> Goto | Finish:
    a = await _automation(ctx, state["input"]["automation_id"])
    if a is None or not a.enabled:
        return Finish("not_needed", note="the automation was switched off or removed")
    try:
        tz = ZoneInfo(a.tz)
    except Exception:  # noqa: BLE001
        tz = ZoneInfo("Asia/Kolkata")
    start, end = au.period_range(a.period, tz, datetime.now(UTC))
    async with ctx.tx() as conn:
        numbers = await au.facts(conn, ctx.venture_id, start, end)
    biz = await ctx.business()
    r = await ctx.llm_json(
        tier="reason", schema=Report,
        system=(f"{await ctx.brief()}\nYou prepare a short report for {biz.name}'s owner. Use ONLY the numbers given; "
                "copy amounts exactly; never invent figures. If a number the request asks for isn't given, say it isn't "
                "tracked in Kritvia yet. Plain text, short lines, no tables."),
        prompt=f"Request: {a.task}\nPeriod: {au.PERIOD_WORDS[a.period]}\n\nThe business's numbers:\n{numbers}")
    body = r.body.strip()[:4000]
    async with ctx.tx() as conn:
        enc = await ctx.crypto(conn).encrypt(ctx.venture_id, RESULT_PURPOSE, f"{r.subject}\n\n{body}")
        rid = (await conn.execute(text(
            "INSERT INTO automation_results (org_id, venture_id, automation_id, run_id, body_enc)"
            " VALUES (:o, :v, :a, :r, :b) RETURNING id"),
            {"o": ctx.org_id, "v": ctx.venture_id, "a": a.id, "r": ctx.run_id, "b": enc})).scalar_one()
    return Goto("deliver", update={"result_id": str(rid), "subject": r.subject.strip()[:120], "body": body},
                note="report written")


@wf.step("deliver", agent="automation")
async def deliver(ctx: RunContext, state: dict) -> Interrupt | Finish:
    a = await _automation(ctx, state["input"]["automation_id"])
    if a is None:
        return Finish("not_needed")
    subject, body = state["subject"], state["body"]
    path = f"/v/{ctx.venture_id}/automations?a={a.id}"
    done = "kept in the app"
    if a.channel == "email" and a.owner_email:
        from kritvia_api.services.mailer import get_mailer
        await get_mailer().send(a.owner_email, subject, f"{body}\n\nAutomation: {a.name}. Change or stop it in Kritvia.")
        done = "emailed to you"
    elif a.channel == "telegram":
        from kritvia_api.services import chat_approvals
        from kritvia_api.services.telegram import TelegramError
        async with ctx.tx() as conn:
            chat = (await conn.execute(text(
                "SELECT external_id FROM approver_links WHERE venture_id = :v AND user_id = :u AND channel = 'telegram'"),
                {"v": ctx.venture_id, "u": a.created_by})).scalar()
        bot = await chat_approvals.telegram_bot(ctx.venture_id) if chat else None
        if bot is not None:
            try:
                await ctx.services.telegram.call(bot.token, "sendMessage", {"chat_id": int(chat), "text": f"{subject}\n\n{body}"[:4000]})
                done = "sent to your Telegram"
            except TelegramError as exc:
                ctx.note(f"Telegram didn't take it ({exc})")
        else:
            ctx.note("no linked Telegram chat; kept in the app")
    elif a.channel == "slack":
        from kritvia_api.services import slack
        if await slack.notify(ctx.venture_id, title=subject, body=body[:180], path=path):
            done = "posted in Slack"
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE automation_results SET delivered = :d WHERE id = :r"),
                           {"d": done, "r": uuid.UUID(state["result_id"])})
    others = [x for x in (a.recipients or []) if x and x != a.owner_email]
    if not others:
        return Finish("delivered", note=done)
    biz = await ctx.business()
    return Interrupt(
        ApprovalRequest(agent="automation", action="gmail.send", key="send_decision",
                        title=f"{a.name}: send to {', '.join(others)[:80]}",
                        summary=f"Automation '{a.name}' ({au.describe(a.freq, list(a.weekdays), a.day_of_month, a.at_time)}).",
                        payload={"to": others[0], "cc": others[1:], "subject": subject,
                                 "body": biz.with_notice(f"{body}\n\n{biz.sign_off}"), "thread_id": None},
                        required_roles=("approver", "venture_admin"), expires_in_hours=24),
        resume="sent", update={"delivered": done}, note=f"{done}; email to others waits for a yes")


@wf.step("sent", agent="automation")
async def sent(ctx: RunContext, state: dict) -> Finish:
    res = await ctx.invoke("gmail.send", approval_id=state["send_decision"]["approval_id"])
    return Finish("delivered", note=f"{state.get('delivered')}; emailed others ({res.get('status')})")
