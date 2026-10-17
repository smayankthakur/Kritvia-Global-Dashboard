"""Custom workflows: a business's own agent, made in the app (Scale and Enterprise).

  route   scan: once a day -> find
          one:  one record -> write
  find    records that match the workflow's trigger, not handled before -> one `one` run each
  write   the owner's instructions + the record's facts -> a short message (amounts and dates are
          copied from the facts, never invented)
          email:  to the customer -> [approval: gmail.send] -> sent
          notify: to the person who made it (Telegram if linked, else email), kept in the run
"""
from __future__ import annotations

import uuid

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Workflow, registry
from kritvia_api.plans import plan as plan_of
from kritvia_api.services import custom_workflows as cw

wf = registry.register(Workflow(
    "custom", title="Custom workflows", start="route",
    trigger="Once a day, for each record that matches a workflow you made",
    description="Your own agents: when an invoice is overdue, a booking is done or a lead goes quiet, "
                "it writes what you asked for and sends it after your yes."))


class Message(BaseModel):
    subject: str = Field(description="a short subject line, under 70 characters")
    body: str = Field(description="the message, plain text, under 150 words; amounts and dates copied exactly from the facts")


async def _workflow(ctx: RunContext, custom_id: str):
    async with ctx.tx() as conn:
        return (await conn.execute(text(
            "SELECT c.*, o.email AS owner_email, o.user_id AS owner_id FROM custom_workflows c"
            " LEFT JOIN LATERAL private.custom_owner(c.id) o ON true WHERE c.id = :c AND c.venture_id = :v"),
            {"c": uuid.UUID(custom_id), "v": ctx.venture_id})).first()


async def _allowed(ctx: RunContext) -> bool:
    from kritvia_api.services.quota import plan_for_venture
    async with ctx.tx() as conn:
        p = await plan_for_venture(conn, ctx.venture_id)
    return "custom_workflows" in plan_of(p.code).extras


@wf.step("route", agent="custom")
async def route(ctx: RunContext, state: dict) -> Goto:
    return Goto("write" if (state["input"] or {}).get("mode") == "one" else "find")


@wf.step("find", agent="custom")
async def find(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    c = await _workflow(ctx, state["input"]["custom_id"])
    if c is None or not c.enabled:
        return Finish("not_needed", note="switched off or removed")
    if not await _allowed(ctx):
        return Finish("not_on_plan", note="custom workflows are part of the Scale and Enterprise plans")
    async with ctx.tx() as conn:
        ids = await cw.candidates(conn, ctx.venture_id, c.trigger, c.wait_days, email_only=c.action == "email")
    started = 0
    for rid in ids:
        if started >= cw.MAX_PER_DAY:
            break
        try:
            await start_run(ctx.services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                            workflow="custom", trigger_kind="schedule", dedupe=("custom", f"{c.id}:{rid}"),
                            title=f"{c.name}"[:120],
                            input={"mode": "one", "custom_id": str(c.id), "record": cw.RECORD[c.trigger], "record_id": str(rid)})
            started += 1
        except DuplicateTrigger:
            continue
    return Finish("found", update={"summary": {"records": started}}, note=f"{started} new record(s)")


@wf.step("write", agent="custom")
async def write(ctx: RunContext, state: dict) -> Interrupt | Finish:
    inp = state["input"]
    c = await _workflow(ctx, inp["custom_id"])
    if c is None or not c.enabled:
        return Finish("not_needed", note="switched off or removed")
    async with ctx.tx() as conn:
        facts, email, who = await cw.record_facts(conn, ctx.venture_id, inp["record"], uuid.UUID(inp["record_id"]))
    if not facts:
        return Finish("not_needed", note="the record is gone")
    biz = await ctx.business()
    to_customer = c.action == "email"
    m = await ctx.llm_json(
        tier="reason", schema=Message,
        system=(f"{await ctx.brief()}\nYou write for {biz.name}. Follow the owner's instructions exactly. "
                + ("Write to the customer named in the facts, warmly and briefly, in the language of the instructions. "
                   "No signature block. " if to_customer else
                   "Write a short note to the owner (not to the customer): what to do about this record and why. ")
                + "Use ONLY the facts given; copy amounts and dates exactly; never invent prices, dates or promises."),
        prompt=f"Owner's instructions: {c.instructions}\n\nWhen: {cw.describe(c.trigger, c.wait_days)}\n\nFacts:\n"
               + "\n".join(f"- {k}: {v}" for k, v in facts.items() if v not in ("", None)))
    subject, body = m.subject.strip()[:120], m.body.strip()[:3000]
    if to_customer:
        if not email:
            return Finish("no_email", note=f"{who} has no email address")
        return Interrupt(
            ApprovalRequest(agent="custom", action="gmail.send", key="send_decision",
                            title=f"{c.name}: email to {who}"[:140],
                            summary=f"Your custom workflow '{c.name}' ({cw.describe(c.trigger, c.wait_days).lower()})."[:300],
                            payload={"to": email, "subject": subject,
                                     "body": biz.with_notice(f"{body}\n\n{biz.sign_off}"), "thread_id": None},
                            required_roles=("approver", "venture_admin"), expires_in_hours=72),
            resume="sent", note="email drafted; waits for a yes")
    done = "kept in the app"
    if c.owner_id:
        from kritvia_api.services import chat_approvals
        from kritvia_api.services.telegram import TelegramError
        async with ctx.tx() as conn:
            chat = (await conn.execute(text(
                "SELECT external_id FROM approver_links WHERE venture_id = :v AND user_id = :u AND channel = 'telegram'"),
                {"v": ctx.venture_id, "u": c.owner_id})).scalar()
        bot = await chat_approvals.telegram_bot(ctx.venture_id) if chat else None
        if bot is not None:
            try:
                await ctx.services.telegram.call(bot.token, "sendMessage", {"chat_id": int(chat), "text": f"{c.name}: {subject}\n\n{body}"[:4000]})
                done = "sent to your Telegram"
            except TelegramError as exc:
                ctx.note(f"Telegram didn't take it ({exc})")
    if done == "kept in the app" and c.owner_email:
        from kritvia_api.services.mailer import get_mailer
        await get_mailer().send(c.owner_email, f"{c.name}: {subject}", f"{body}\n\nCustom workflow: {c.name}. Change or stop it in Kritvia.")
        done = "emailed to you"
    return Finish("told_you", update={"summary": {"subject": subject, "body": body}}, note=done)


@wf.step("sent", agent="custom")
async def sent(ctx: RunContext, state: dict) -> Finish:
    res = await ctx.invoke("gmail.send", approval_id=state["send_decision"]["approval_id"])
    return Finish("sent", note=f"emailed ({res.get('status')})")
