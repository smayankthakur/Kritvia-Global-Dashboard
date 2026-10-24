"""Social posts: on the days the owner picks, Kritvia writes one short post for the business's Google profile
and Facebook Page, and posts it after a yes.

  daily: route   only on the chosen days (default Monday, Wednesday, Friday) and only where the business can post
         draft   one post from the business's description, its offers and what it posted lately (no repeats)
                 -> [approval: social.post]  edit it, or say no
         posted  posts it, per channel; one failing doesn't stop the other

Posts never promise prices, discounts or anything the owner didn't write in the offers, never name customers,
and use at most two hashtags.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Option, Workflow, registry
from kritvia_api.workflows.common import IST

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

wf = registry.register(Workflow(
    "social", title="Social posts", start="route",
    trigger="On the days you choose, at the time you set",
    description="Writes a short post for your Google profile and Facebook Page on the days you choose (from what "
                "your business does and your current offers) and posts it after your yes.",
    options=(
        Option("post_days", "Days to post", "text", "mon,wed,fri",
               help="Comma-separated: mon, tue, wed, thu, fri, sat, sun"),
        Option("offers", "Offers and news to post about (optional)", "text", "",
               help="e.g. 'Diwali thali ₹299 till 5 Nov; new branch in Rohini'. Kritvia never invents offers."),
        Option("style", "How the posts should sound (optional)", "text", "",
               help="e.g. 'warm, a little Hinglish, one emoji at most'"),
    ), default_schedule="10:00"))


class PostDraft(BaseModel):
    topic: str = Field(description="a few words naming what the post is about")
    body: str = Field(description="the post, 2-5 short sentences, plain text, at most two hashtags")


def post_days(raw: str) -> set[str]:
    got = {d.strip().lower()[:3] for d in (raw or "").split(",") if d.strip()}
    return {d for d in got if d in DAYS} or {"mon", "wed", "fri"}


def offers_changed(cfg: dict, body: str) -> bool:
    """A post quoting an amount, a percentage or an offer word the owner's own offers don't contain: autopilot
    leaves it for the owner (the prompt already forbids it; this is the code check)."""
    from kritvia_api.services import auto_reply as ar
    offers = str(cfg.get("offers") or "")
    if ar.unknown_amounts(body, ar.known_values([offers])):
        return True
    if ar._DISCOUNT_AMOUNT.search(body) and not ar._DISCOUNT_AMOUNT.search(offers):
        return True
    return bool(ar._MONEY_WORDS.search(body)) or (
        "discount_or_offer" in ar.handoff_reasons("", body) and "discount_or_offer" not in ar.handoff_reasons("", offers))


@wf.step("route", agent="social")
async def route(ctx: RunContext, state: dict) -> Goto | Finish:
    from kritvia_api.services import social
    cfg = await ctx.settings()
    today = DAYS[datetime.now(IST).weekday()]
    if not (state.get("input") or {}).get("now") and today not in post_days(str(cfg.get("post_days") or "")):
        return Finish("not_today", note=f"posts go out on {', '.join(sorted(post_days(str(cfg.get('post_days')))))}")
    async with ctx.tx() as conn:
        where = await social.channels(ctx.services, conn, ctx.venture_id)
    if not where:
        if (state.get("input") or {}).get("now"):
            # Asked for a post with nowhere connected: write it anyway, for the owner to copy (round 3, A14).
            return Goto("draft", update={"channels": []}, note="nowhere to post yet: drafting one to copy")
        return Finish("not_set_up", note="connect the Facebook Page, or Google with Business Profile, on the "
                                         "Marketing page")
    return Goto("draft", update={"channels": sorted(where)})


@wf.step("draft", agent="social")
async def draft(ctx: RunContext, state: dict) -> Interrupt | Finish:
    cfg, biz = await ctx.settings(), await ctx.business()
    async with ctx.tx() as conn:
        recent = (await conn.execute(text(
            "SELECT topic, left(body, 160) AS body FROM social_posts WHERE venture_id = :v"
            " ORDER BY created_at DESC LIMIT 8"), {"v": ctx.venture_id})).all()
        good = (await conn.execute(text(
            "SELECT count(*) FROM review_replies WHERE venture_id = :v AND rating >= 4"), {"v": ctx.venture_id})).scalar()
    offers = str(cfg.get("offers") or "").strip()[:800]
    style = str(cfg.get("style") or "").strip()[:200]
    today = datetime.now(IST).strftime("%A %d %B %Y")
    lines = [f"Today is {today}."]
    if offers:
        lines.append(f"Offers and news the owner wrote (the only offers you may mention): {offers}")
    else:
        lines.append("The owner wrote no offers: don't mention any price, discount or offer.")
    if good:
        lines.append(f"The business has {int(good)} reviews of 4-5 stars on Google (you may say customers love it, "
                     "without quoting anyone).")
    if recent:
        lines.append("Posted lately (write about something different):\n" +
                     "\n".join(f"- {r.topic or ''}: {r.body}" for r in recent))
    d = await ctx.llm_json(
        tier="reason", schema=PostDraft,
        system=(f"{await ctx.brief()}\nYou write {biz.name}'s social media posts for its Google profile and Facebook "
                "Page. Short, friendly and specific to this business; one clear reason to visit, call or order. "
                "Never invent prices, discounts, awards or facts; never name or quote customers; no phone numbers "
                f"or links; at most two hashtags. {('Style: ' + style) if style else ''}".strip()),
        prompt="\n".join(lines))
    body = d.body.strip()[:1500]
    async with ctx.tx() as conn:
        pid = (await conn.execute(text(
            "INSERT INTO social_posts (org_id, venture_id, run_id, topic, body, channels)"
            " VALUES (:o, :v, :r, :t, :b, :c) RETURNING id"),
            {"o": ctx.org_id, "v": ctx.venture_id, "r": ctx.run_id, "t": d.topic.strip()[:200] or None,
             "b": body or "-", "c": state["channels"]})).scalar_one()
    if not state["channels"]:
        return Finish("drafted_to_copy", update={"post_id": str(pid), "summary": {"post_id": str(pid)}},
                      note="post written: copy it from Marketing → Social posts (connect a page to post it from here)")
    where = " and ".join("your Google profile" if c == "google" else "your Facebook Page" for c in state["channels"])
    return Interrupt(
        ApprovalRequest(agent="social", action="social.post", key="post_decision",
                        title=f"Post on {where}: {d.topic.strip()[:80]}"[:140],
                        summary="Edit the text if you like; it goes out as you approve it.",
                        payload={"post_id": str(pid), "body": body, "channels": state["channels"]},
                        expires_in_hours=36, autopilot=not offers_changed(cfg, body)),
        resume="posted", on_reject="dismissed", update={"post_id": str(pid)}, note="post drafted")


@wf.step("posted", agent="social")
async def posted(ctx: RunContext, state: dict) -> Finish:
    res = await ctx.invoke("social.post", approval_id=state["post_decision"]["approval_id"])
    return Finish(res.get("status", "posted"), update={"summary": {"posted_to": res.get("posted_to", [])}},
                  note=f"posted to {', '.join(res.get('posted_to') or []) or 'nowhere'}"
                       + (f"; failed: {', '.join(res.get('failed') or {})}" if res.get("failed") else ""))


@wf.step("dismissed", agent="social")
async def dismissed(ctx: RunContext, state: dict) -> Finish:
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE social_posts SET status = 'dismissed' WHERE id = :p AND venture_id = :v"),
                           {"p": uuid.UUID(state["post_id"]), "v": ctx.venture_id})
    return Finish("not_posted")
