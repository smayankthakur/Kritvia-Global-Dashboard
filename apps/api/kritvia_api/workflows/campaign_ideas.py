"""Campaign ideas: once a week Kritvia looks for a reason to write to customers, and when it finds one it writes
the email campaign and asks for the one yes a campaign needs.

  weekly: route   only on the chosen day (default Monday). A reason is either
                    an occasion 7-21 days away (Diwali, Holi, Raksha Bandhan...; services/occasions.py) that this
                    business hasn't had a campaign for yet, or
                    a slow fortnight: fewer than 60% of the usual new leads and bookings (the usual being the
                    average of the twelve weeks before; only once the business has that much history)
                  and some customers to write to (email; nobody who unsubscribed)
          draft   the subject and email, from the business's brief and the offers the owner wrote; then the
                  campaign is saved and the Campaigns agent fixes the list and asks: "Send 'Diwali 2026' to 214
                  people?" -> [approval: campaign.send]. A no simply drops it.

One campaign per occasion at most (campaigns.occasion is unique per business), so a rejected idea isn't
suggested again. It never promises a price or discount the owner didn't write in the offers.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import Finish, Goto, Option, Workflow, registry
from kritvia_api.services import occasions
from kritvia_api.workflows.common import IST

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
SLOW_SHARE = 0.6
SLOW_MIN_USUAL = 4      # a fortnight's usual leads + bookings below this is too little to call a week "slow"

wf = registry.register(Workflow(
    "campaign_ideas", title="Campaign ideas", start="route",
    trigger="Once a week, on the day and at the time you set",
    description="Once a week, looks for a festival coming up (Diwali, Holi, Raksha Bandhan and more) or a slow "
                "fortnight, writes an email campaign for your customers and asks for your yes before anyone gets it.",
    options=(
        Option("day", "Day to look", "text", "mon", help="mon, tue, wed, thu, fri, sat or sun"),
        Option("offers", "Offers Kritvia may mention (optional)", "text", "",
               help="e.g. 'Diwali gift hampers from ₹499; 10% off website packages till 10 Nov'. Without offers it "
                    "writes greetings and reminders, never prices."),
        Option("also", "Extra occasions (optional)", "text", "",
               help="Smaller ones to include, comma-separated: lohri, dhanteras, bhai-dooj, karwa-chauth, "
                    "chhath-puja, janmashtami, ram-navami, baisakhi, gudi-padwa-ugadi, guru-nanak-jayanti, "
                    "maha-shivaratri, eid-ul-adha, fathers-day, republic-day, vasant-panchami"),
        Option("skip", "Occasions to skip (optional)", "text", "", help="e.g. valentines-day, christmas"),
        Option("audience", "Who gets it", "text", "customers",
               help="customers (everyone who bought), or recent_customers (the last 90 days)"),
        Option("slow_weeks", "Also suggest one in a slow fortnight", "boolean", True),
    ), default_schedule="10:30"))


class CampaignDraft(BaseModel):
    name: str = Field(description="a short name for the campaign, e.g. 'Diwali 2026 greetings'")
    subject: str = Field(description="the email subject, under 70 characters")
    body: str = Field(description="the email, 60-160 words, plain text, warm and specific to this business")


def _set(raw: object) -> set[str]:
    return {x.strip().lower() for x in str(raw or "").split(",") if x.strip()}


async def slow_fortnight(conn, venture_id: uuid.UUID, today: date) -> dict | None:
    """Leads and bookings in the last 14 days against the usual fortnight (the 12 weeks before)."""
    r = (await conn.execute(text(
        "SELECT (SELECT count(*) FROM leads WHERE venture_id = :v AND source <> 'prospector'"
        "         AND created_at >= CAST(:t AS date) - 14) +"
        "       (SELECT count(*) FROM bookings WHERE venture_id = :v AND created_at >= CAST(:t AS date) - 14) AS recent,"
        "       (SELECT count(*) FROM leads WHERE venture_id = :v AND source <> 'prospector'"
        "         AND created_at >= CAST(:t AS date) - 98 AND created_at < CAST(:t AS date) - 14) +"
        "       (SELECT count(*) FROM bookings WHERE venture_id = :v AND created_at >= CAST(:t AS date) - 98"
        "         AND created_at < CAST(:t AS date) - 14) AS before,"
        "       (SELECT min(created_at) FROM leads WHERE venture_id = :v) AS first"),
        {"v": venture_id, "t": today})).first()
    if r is None or r.first is None or r.first.date() > today - timedelta(days=98):
        return None
    usual = r.before / 6          # twelve weeks = six fortnights
    if usual < SLOW_MIN_USUAL or r.recent >= usual * SLOW_SHARE:
        return None
    return {"recent": int(r.recent), "usual": round(usual, 1)}


@wf.step("route", agent="campaigns")
async def route(ctx: RunContext, state: dict) -> Goto | Finish:
    from kritvia_api.services import campaigns as cs
    cfg = await ctx.settings()
    now = datetime.now(IST)
    today = now.date()
    day = str(cfg.get("day") or "mon").strip().lower()[:3]
    if not (state.get("input") or {}).get("now") and DAYS[today.weekday()] != (day if day in DAYS else "mon"):
        return Finish("not_today", note=f"looks on {day if day in DAYS else 'mon'}")
    audience = str(cfg.get("audience") or "customers")
    audience = audience if audience in ("customers", "recent_customers") else "customers"
    async with ctx.tx() as conn:
        people = await cs.audience(conn, ctx.venture_id, "email", audience)
        if not people:
            return Finish("no_audience", note="no customers with an email address to write to yet")
        used = set((await conn.execute(text(
            "SELECT occasion FROM campaigns WHERE venture_id = :v AND occasion IS NOT NULL"),
            {"v": ctx.venture_id})).scalars().all())
        recent = (await conn.execute(text(
            "SELECT count(*) FROM campaigns WHERE venture_id = :v AND created_at > now() - interval '6 days'"),
            {"v": ctx.venture_id})).scalar()
        if recent:
            return Finish("recent_campaign", note="a campaign was made this week already")
        pick = None
        for o in occasions.upcoming(today, include=_set(cfg.get("also")), skip=_set(cfg.get("skip"))):
            if o.key not in used:
                pick = {"occasion": o.key, "title": f"{o.name} {o.day.year}", "why": "occasion",
                        "day": o.day.isoformat(), "note": o.note}
                break
        if pick is None and cfg.get("slow_weeks", True):
            slow = await slow_fortnight(conn, ctx.venture_id, today)
            iso = today.isocalendar()
            key = f"slow-{iso.year}-w{iso.week:02d}"
            if slow and key not in used and not any(u.startswith("slow-") and u >= f"slow-{iso.year}-w{iso.week - 2:02d}"
                                                    for u in used):
                pick = {"occasion": key, "title": f"Customer note, week of {today:%d %b}", "why": "slow", **slow}
    if pick is None:
        return Finish("nothing_this_week", note="no occasion in the next three weeks and business as usual")
    return Goto("draft", update={"pick": pick, "audience": audience, "people": len(people)})


@wf.step("draft", agent="campaigns")
async def draft(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.runner import start_run
    cfg, biz = await ctx.settings(), await ctx.business()
    pick = state["pick"]
    offers = str(cfg.get("offers") or "").strip()[:800]
    lines = [f"Today is {datetime.now(IST):%A %d %B %Y}."]
    if pick["why"] == "occasion":
        lines.append(f"Write for {pick['title']} on {date.fromisoformat(pick['day']):%A %d %B} ({pick['note']}). "
                     "Send good wishes and give customers one reason to come back before or around the day.")
    else:
        lines.append("It has been a quiet fortnight. Write a friendly note that reminds customers what the business "
                     "does and invites them to get in touch; don't say business is slow.")
    lines.append(f"Offers the owner wrote (the only offers you may mention): {offers}" if offers
                 else "The owner wrote no offers: mention no price, discount or offer.")
    d = await ctx.llm_json(
        tier="reason", schema=CampaignDraft,
        system=(f"{await ctx.brief()}\nYou write {biz.name}'s marketing emails to its own customers. Warm, short, "
                "specific to this business, in simple English (a little Hinglish is fine for an Indian audience). "
                "Never invent prices, discounts, deadlines, awards or facts; no links (the email gets an unsubscribe "
                "link by itself); sign off with the business's name."),
        prompt="\n".join(lines))
    name = (d.name.strip() or pick["title"])[:80]
    async with ctx.tx() as conn:
        try:
            async with conn.begin_nested():
                cid = (await conn.execute(text(
                    "INSERT INTO campaigns (org_id, venture_id, name, channel, subject, body, audience, occasion,"
                    " suggested) VALUES (:o, :v, :n, 'email', :s, :b, :a, :oc, true) RETURNING id"),
                    {"o": ctx.org_id, "v": ctx.venture_id, "n": name, "s": d.subject.strip()[:150] or name,
                     "b": d.body.strip()[:5000] or "-", "a": state["audience"], "oc": pick["occasion"]})).scalar_one()
        except IntegrityError:
            return Finish("already_suggested", note=f"{pick['title']} was suggested before")
    rid = await start_run(ctx.services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                          workflow="campaign", input={"campaign_id": str(cid)}, trigger_kind="schedule",
                          dedupe=("campaign_ideas", pick["occasion"]), title=f"Campaign: {name}"[:120])
    return Finish("suggested", update={"summary": {"campaign_id": str(cid), "occasion": pick["occasion"],
                                                   "campaign_run_id": str(rid)}},
                  note=f"suggested '{name}' to {state['people']} customers; waiting for a yes")
