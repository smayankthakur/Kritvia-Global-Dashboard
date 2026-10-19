"""Campaigns: one message to many customers, after one yes (services/campaigns.py says who can be in one).

  request: prepare  fixes the list (people who agreed to hear from the business; nobody who wrote STOP or
                    unsubscribed) -> [approval: campaign.send] "Send 'Diwali offer' to 214 customers?"
           send     the approval is used once; then the batches start
           batch    up to 40 people at a time, until everyone on the list was sent to (or skipped, if they
                    wrote STOP in the meantime)
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Workflow, registry
from kritvia_api.services import campaigns as cs

wf = registry.register(Workflow(
    "campaign", title="Campaigns", start="prepare", starts="request", max_steps=200,
    trigger="When you press Send on the Marketing page",
    description="Sends one WhatsApp template or email to the customers you choose, after one yes for the whole "
                "list. Only people who agreed to hear from you; never anyone who wrote STOP or unsubscribed."))

AUDIENCE_WORDS = {"opted_in": "everyone who agreed to hear from you", "customers": "your customers",
                  "recent_customers": "customers of the last 90 days"}


async def _campaign(ctx: RunContext, cid: uuid.UUID):
    async with ctx.tx() as conn:
        return (await conn.execute(text("SELECT * FROM campaigns WHERE id = :c AND venture_id = :v"),
                                   {"c": cid, "v": ctx.venture_id})).first()


@wf.step("prepare", agent="campaigns")
async def prepare(ctx: RunContext, state: dict) -> Interrupt | Finish:
    from kritvia_api.services import wa_templates
    cid = uuid.UUID(str((state.get("input") or {}).get("campaign_id")))
    c = await _campaign(ctx, cid)
    if c is None or c.status != "draft":
        return Finish("not_draft", note="the campaign was already sent or cancelled")
    async with ctx.tx() as conn:
        if c.channel == "whatsapp":
            t = await wa_templates.by_id(conn, ctx.venture_id, str(c.template_id)) if c.template_id else None
            try:
                preview, _ = wa_templates.render(t, list(c.params or []))
            except wa_templates.TemplateProblem as exc:
                await conn.execute(text("UPDATE campaigns SET status = 'failed' WHERE id = :c"), {"c": cid})
                return Finish("template_problem", note=str(exc)[:200])
        else:
            preview = f"{c.subject}\n\n{c.body}"
        people = await cs.audience(conn, ctx.venture_id, c.channel, c.audience)
        if len(people) > cs.MAX_RECIPIENTS:
            people = people[:cs.MAX_RECIPIENTS]
        for addr, name in people:
            await conn.execute(text(
                "INSERT INTO campaign_recipients (org_id, venture_id, campaign_id, address, name)"
                " VALUES (:o, :v, :c, :a, :n) ON CONFLICT DO NOTHING"),
                {"o": ctx.org_id, "v": ctx.venture_id, "c": cid, "a": addr[:254], "n": (name or "")[:160] or None})
        await conn.execute(text("UPDATE campaigns SET status = 'waiting', recipients = :n, run_id = :r WHERE id = :c"),
                           {"n": len(people), "r": ctx.run_id, "c": cid})
    if not people:
        async with ctx.tx() as conn:
            await conn.execute(text("UPDATE campaigns SET status = 'sent', sent_at = now() WHERE id = :c"), {"c": cid})
        return Finish("nobody", note=f"nobody to send to: no {AUDIENCE_WORDS[c.audience]} yet")
    names = ", ".join(n or a for a, n in people[:5])
    return Interrupt(
        ApprovalRequest(agent="campaigns", action="campaign.send", key="send_decision",
                        title=f"Send '{c.name}' to {len(people)} {'person' if len(people) == 1 else 'people'}"[:140],
                        summary=f"{'WhatsApp template' if c.channel == 'whatsapp' else 'Email'} to "
                                f"{AUDIENCE_WORDS[c.audience]} (for example {names}"
                                f"{'…' if len(people) > 5 else ''}). Exactly this list gets it.",
                        payload={"campaign_id": str(cid), "name": c.name, "channel": c.channel,
                                 "recipients": len(people), "message": preview[:3000]},
                        required_roles=("venture_admin",), expires_in_hours=72, always_review=True),
        resume="send", on_reject="rejected", update={"campaign_id": str(cid)}, note=f"{len(people)} on the list")


@wf.step("send", agent="campaigns")
async def send(ctx: RunContext, state: dict) -> Goto | Finish:
    res = await ctx.invoke("campaign.send", approval_id=state["send_decision"]["approval_id"])
    if not res.get("started"):
        return Finish("not_sent", note=res.get("why"))
    return Goto("batch", note=f"sending to {res.get('recipients')}")


@wf.step("batch", agent="campaigns")
async def batch(ctx: RunContext, state: dict) -> Goto | Finish:
    from kritvia_api.services.messaging import MessagingError
    cid = uuid.UUID(state["campaign_id"])
    approval_id = uuid.UUID(str(state["send_decision"]["approval_id"]))
    c = await _campaign(ctx, cid)
    if c is None or c.status != "sending":
        return Finish("stopped", note="the campaign was stopped")
    async with ctx.tx() as conn:
        todo = (await conn.execute(text(
            "SELECT id, address, name FROM campaign_recipients WHERE campaign_id = :c AND status = 'queued'"
            " ORDER BY address LIMIT :n"), {"c": cid, "n": cs.BATCH})).all()
    for r in todo:
        status, err = "sent", None
        try:
            if c.channel == "whatsapp":
                await ctx.services.messaging.send_whatsapp_template(
                    ctx, approval_id, to=r.address, template_id=str(c.template_id), params=list(c.params or []),
                    campaign_recipient=r.id)
            else:
                async with ctx.tx() as conn:
                    out = (await conn.execute(text("SELECT 1 FROM email_optouts WHERE venture_id = :v AND address = :a"),
                                              {"v": ctx.venture_id, "a": r.address})).first()
                if out:
                    raise MessagingError("unsubscribed")
                link = cs.unsubscribe_url(ctx.venture_id, r.address)
                first = (r.name or "").split(" ")[0]
                body = (f"Hi {first},\n\n" if first else "") + f"{c.body}\n\n—\nDon't want these emails? {link}"
                await ctx.services.messaging.send_email(ctx, approval_id, to=r.address, subject=c.subject, body=body,
                                                        campaign_recipient=r.id)
        except MessagingError as exc:
            msg = str(exc)
            status = "skipped" if ("STOP" in msg or "unsubscribed" in msg or "agreed to hear" in msg) else "failed"
            err = msg[:300]
        async with ctx.tx() as conn:
            await conn.execute(text("UPDATE campaign_recipients SET status = :s, error = :e, sent_at = :t WHERE id = :id"),
                               {"s": status, "e": err, "t": datetime.now(UTC) if status == "sent" else None,
                                "id": r.id})
    async with ctx.tx() as conn:
        n = (await conn.execute(text(
            "SELECT count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE status = 'failed') AS failed,"
            " count(*) FILTER (WHERE status = 'skipped') AS skipped, count(*) FILTER (WHERE status = 'queued') AS queued"
            " FROM campaign_recipients WHERE campaign_id = :c"), {"c": cid})).first()
        done = n.queued == 0
        await conn.execute(text(
            "UPDATE campaigns SET sent = :s, failed = :f, skipped = :k,"
            " status = CASE WHEN :done THEN 'sent' ELSE status END, sent_at = CASE WHEN :done THEN now() END"
            " WHERE id = :c"), {"s": n.sent, "f": n.failed, "k": n.skipped, "done": done, "c": cid})
    if not done:
        return Goto("batch")
    return Finish("sent", update={"summary": {"sent": n.sent, "failed": n.failed, "skipped": n.skipped}},
                  note=f"{n.sent} sent, {n.failed} failed, {n.skipped} skipped")


@wf.step("rejected", agent="campaigns")
async def rejected(ctx: RunContext, state: dict) -> Finish:
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE campaigns SET status = 'rejected' WHERE id = :c AND venture_id = :v"),
                           {"c": uuid.UUID(state["campaign_id"]), "v": ctx.venture_id})
        await conn.execute(text("DELETE FROM campaign_recipients WHERE campaign_id = :c AND status = 'queued'"),
                           {"c": uuid.UUID(state["campaign_id"])})
    return Finish("not_sent")
