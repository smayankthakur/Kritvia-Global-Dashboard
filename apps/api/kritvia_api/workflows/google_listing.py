"""Google listing check: once a week Kritvia compares the business's Google Business Profile with what Kritvia
knows, and when the opening hours differ it offers to put Kritvia's hours on Google, after a yes.

  weekly: check   reads the listing (title, hours, website, phone) through the business's own Google connection;
                  Kritvia's hours are the booking hours, else the phone assistant's office hours. Hours that match,
                  or no hours in Kritvia, end here; a listing without a website or phone is noted on the Reviews page
                  -> [approval: google.listing_update] "Update your Google hours to Mon-Sat 10:00-19:00?"
          update  replaces the listing's regular hours on Google; nothing else on the listing is touched

The yes can't be edited (change the hours in Kritvia, and the next check offers them again); a no is
remembered for those exact hours, so the same offer isn't made every week.
"""
from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Interrupt, Option, Workflow, registry
from kritvia_api.workflows.common import IST

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

wf = registry.register(Workflow(
    "google_listing", title="Google listing check", start="check",
    trigger="Once a week, on the day and at the time you set",
    description="Once a week, checks your Google Business Profile against Kritvia: when your opening hours differ, "
                "it offers to update them on Google after your yes, and tells you if the website or phone is missing.",
    options=(Option("day", "Day to check", "text", "tue", help="mon, tue, wed, thu, fri, sat or sun"),),
    default_schedule="09:30"))


def _key(hours: dict) -> str:
    return hashlib.sha256(json.dumps(hours, sort_keys=True).encode()).hexdigest()[:16]


async def _save(ctx: RunContext, state: dict) -> None:
    async with ctx.tx() as conn:
        await conn.execute(text(
            "UPDATE review_settings SET listing_checked_at = now(), listing_state = CAST(:s AS jsonb)"
            " WHERE venture_id = :v"), {"s": json.dumps(state), "v": ctx.venture_id})


@wf.step("check", agent="reviews")
async def check(ctx: RunContext, state: dict) -> Interrupt | Finish:
    from kritvia_api.services import gbp
    cfg = await ctx.settings()
    day = str(cfg.get("day") or "tue").strip().lower()[:3]
    if not (state.get("input") or {}).get("now") and DAYS[datetime.now(IST).weekday()] != (day if day in DAYS else "tue"):
        return Finish("not_today")
    async with ctx.tx() as conn:
        try:
            prof = await gbp.profile(ctx.services, conn, ctx.venture_id)
        except gbp.NotConnected as exc:
            return Finish("not_set_up", note=str(exc))
        ours = await gbp.our_hours(conn, ctx.venture_id)
        last = (await conn.execute(text("SELECT listing_state FROM review_settings WHERE venture_id = :v"),
                                   {"v": ctx.venture_id})).scalar() or {}
    if not prof.location:
        return Finish("not_set_up", note="choose your Google listing on the Reviews page first")
    from kritvia_api.services.google import GoogleError
    try:
        listing = await ctx.services.google.gbp_listing(prof.token, prof.location)
    except GoogleError as exc:
        return Finish("google_refused", note=f"Google didn't share the listing ({exc}); the Business Profile API "
                                             "may still be waiting for Google's approval")
    theirs = gbp.from_google(listing)
    found = {"checked_at": datetime.now(UTC).isoformat(), "title": listing.get("title"),
             "google_hours": gbp.words(theirs), "has_website": bool(listing.get("websiteUri")),
             "has_phone": bool((listing.get("phoneNumbers") or {}).get("primaryPhone"))}
    if ours is None:
        await _save(ctx, {**found, "hours_match": None, "note": "set booking hours or phone office hours in Kritvia"})
        return Finish("no_hours_in_kritvia", note="Kritvia has no opening hours to compare")
    hours, where = ours
    plain = {d: [list(x) for x in v] for d, v in hours.items()}
    match = {d: [tuple(x) for x in v] for d, v in theirs.items()} == {d: [tuple(x) for x in v] for d, v in hours.items()}
    found |= {"hours_match": match, "kritvia_hours": gbp.words(hours), "from": where}
    if match:
        await _save(ctx, found)
        return Finish("in_step", note="the Google hours match Kritvia's")
    if last.get("declined") == _key(plain):
        await _save(ctx, {**found, "declined": _key(plain)})
        return Finish("declined_before", note="these hours were offered before and declined")
    await _save(ctx, found)
    return Interrupt(
        ApprovalRequest(agent="reviews", action="google.listing_update", key="hours_decision",
                        title=f"Update the opening hours on Google ({prof.title or 'your listing'})"[:140],
                        summary=f"Google shows: {gbp.words(theirs)}. Kritvia's {where}: {gbp.words(hours)}. "
                                "Approve to put Kritvia's hours on Google.",
                        payload={"location": prof.location, "hours": plain, "google_hours": gbp.words(theirs),
                                 "kritvia_hours": gbp.words(hours)},
                        required_roles=("venture_admin",), expires_in_hours=96),
        resume="update", on_reject="declined", update={"hours": plain, "found": found}, note="hours differ")


@wf.step("update", agent="reviews")
async def update(ctx: RunContext, state: dict) -> Finish:
    res = await ctx.invoke("google.listing_update", approval_id=state["hours_decision"]["approval_id"])
    await _save(ctx, {**state["found"], "hours_match": True, "updated_at": datetime.now(UTC).isoformat()})
    return Finish("updated", note=f"Google hours set: {res.get('hours')}")


@wf.step("declined", agent="reviews")
async def declined(ctx: RunContext, state: dict) -> Finish:
    await _save(ctx, {**state["found"], "declined": _key(state["hours"])})
    return Finish("not_updated", note="kept Google's hours")

