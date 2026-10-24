"""Autopilot: one switch per business that lets the agents do routine work by themselves (round 3, "make it
autonomous, money still asks").

With autopilot on:

  Inbox (WhatsApp, Telegram, email)   answers customers by itself (as the inbox assistant's "reply by itself"),
                                      with every guard services/auto_reply.py applies: refunds, discounts,
                                      prices not on record, complaints, legal, orders and payments, people asking
                                      for a person and unverified email senders still go to the owner.
  Booking reminders                   the day-before reminder.
  Payment reminders                   the first two friendly reminders of an invoice (later ones ask).
  Reviews                             replies to 4-5 star reviews; asks happy customers for a review.
  Social posts                        posts on the chosen days (only offers the owner wrote).
  WhatsApp follow-ups                 the follow-up to an enquiry that went quiet.
  Prospector                          first messages and follow-ups from the owner's offer line (a price the
                                      offer doesn't contain still asks).

Never by autopilot, whatever the plan: invoices, purchase orders, proposals, refunds, campaigns, payments, calls,
anything in another app, changes to Kritvia itself. The database enforces the list (private.autopilot_allows,
migration 0080); this module is the code side: the plan's rule (free trial: inbox replies only, as before;
Starter: one kind of action per agent; Growth and up: all) and the 8 pm summary.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text

IST = ZoneInfo("Asia/Kolkata")

# Each agent's actions autopilot may take, most important first (Starter allows the first one per agent).
ACTIONS: dict[str, tuple[str, ...]] = {
    "inbox": ("whatsapp.send", "telegram.send", "gmail.send"),
    "booking_reminders": ("whatsapp.send", "whatsapp.template", "telegram.send", "gmail.send"),
    "collections": ("whatsapp.template", "gmail.send"),
    "reviews": ("google.review_reply", "whatsapp.template", "whatsapp.send", "gmail.send", "telegram.send"),
    "social": ("social.post",),
    "followup": ("whatsapp.template",),
    "prospector": ("gmail.send",),
}
# On Starter "one kind of action per agent" counts each agent once, whatever the channel.
CHANNEL_FAMILY = {"whatsapp.send", "whatsapp.template", "telegram.send", "gmail.send"}

WORDS = {
    "inbox": "answered customers",
    "booking_reminders": "booking reminders",
    "collections": "payment reminders",
    "reviews": "review replies and requests",
    "social": "social posts",
    "followup": "WhatsApp follow-ups",
    "prospector": "Prospector messages",
}


def plan_allows(plan, agent: str, action: str) -> bool:
    """The plan's rule for autopilot. `plan` is plans.Plan (autonomy_per_agent: None, 0 = all, n)."""
    if action not in ACTIONS.get(agent, ()):
        return False
    per = plan.autonomy_per_agent
    if agent == "inbox":
        return True                       # replying by itself: on every plan, as before autopilot
    if per is None:
        return False                      # free trial: agents ask (the pricing page says so)
    if per == 0:
        return True
    # Starter: the agent's first kind of action (all its channels count as one kind)
    first = ACTIONS[agent][0]
    return action == first or (first in CHANNEL_FAMILY and action in CHANNEL_FAMILY)


async def is_on(conn, venture_id: uuid.UUID) -> bool:
    return bool((await conn.execute(text("SELECT autopilot FROM venture_settings WHERE venture_id = :v"),
                                    {"v": venture_id})).scalar())


async def allowed(conn, venture_id: uuid.UUID, agent: str, action: str) -> bool:
    """Autopilot is on for this business and its plan lets this agent take this action by itself."""
    from kritvia_api.services.quota import plan_for_venture
    if not await is_on(conn, venture_id):
        return False
    return plan_allows(await plan_for_venture(conn, venture_id), agent, action)


@dataclass
class Day:
    by_itself: dict[str, int]
    waiting: int
    failed: int
    held: int


async def today(conn, venture_id: uuid.UUID, since: datetime) -> Day:
    rows = (await conn.execute(text(
        "SELECT agent, count(*) AS n FROM approvals WHERE venture_id = :v AND status = 'auto_approved'"
        " AND created_at >= :s GROUP BY agent"), {"v": venture_id, "s": since})).all()
    waiting = (await conn.execute(text(
        "SELECT count(*) FROM approvals WHERE venture_id = :v AND status = 'pending'"), {"v": venture_id})).scalar()
    failed = (await conn.execute(text(
        "SELECT count(*) FROM workflow_runs WHERE venture_id = :v AND status = 'failed' AND updated_at >= :s"),
        {"v": venture_id, "s": since})).scalar()
    held = (await conn.execute(text(
        "SELECT count(*) FROM approvals WHERE venture_id = :v AND step = 'owner_draft' AND created_at >= :s"),
        {"v": venture_id, "s": since})).scalar()
    return Day(by_itself={r.agent: int(r.n) for r in rows}, waiting=int(waiting or 0), failed=int(failed or 0),
               held=int(held or 0))


def summary_text(business: str, d: Day) -> tuple[str, str]:
    done = sum(d.by_itself.values())
    lines = [f"Autopilot today at {business}:"]
    if done:
        lines += [f"• {n} {WORDS.get(a, a)}" for a, n in sorted(d.by_itself.items(), key=lambda kv: -kv[1])]
    else:
        lines.append("• nothing went out by itself today")
    if d.held:
        lines.append(f"• {d.held} message(s) about money, a complaint or an order came to you (the customer was told "
                     "the team will reply)")
    lines.append(f"Waiting for your yes: {d.waiting}." if d.waiting else "Nothing is waiting for you.")
    if d.failed:
        lines.append(f"{d.failed} run(s) failed today: open Kritvia to see why.")
    lines.append("Reply PAUSE to stop autopilot, RESUME to start it again.")
    subject = f"Autopilot: {done} done by itself, {d.waiting} waiting for you"
    return subject, "\n".join(lines)


async def set_on(conn, venture_id: uuid.UUID, on: bool, user_id: uuid.UUID | None) -> None:
    await conn.execute(text(
        "UPDATE venture_settings SET autopilot = :on, autopilot_changed_at = now(), autopilot_changed_by = :u"
        " WHERE venture_id = :v"), {"on": on, "u": user_id, "v": venture_id})


async def evening(services, now: datetime | None = None) -> int:
    """8 pm IST: each business with autopilot on gets the day's summary (push, Telegram, email)."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.owner_news import tell_admins
    now = (now or datetime.now(IST)).astimezone(IST)
    since = now.replace(hour=0, minute=0, second=0, microsecond=0)
    async with tenant_tx(None, "system") as conn:
        rows = (await conn.execute(text("SELECT * FROM private.autopilot_targets()"))).all()
    told = 0
    for r in rows:
        if r.run_as is None:
            continue
        try:
            async with tenant_tx(r.run_as) as conn:
                d = await today(conn, r.venture_id, since)
                subject, body = summary_text(r.business or "your business", d)
                await tell_admins(services, conn, r.venture_id, subject=subject, body=body,
                                  path=f"/v/{r.venture_id}/inbox", tag=f"autopilot-{r.venture_id}")
            told += 1
        except Exception:  # noqa: BLE001 - one business's problem never stops the others
            import logging
            logging.getLogger("kritvia.autopilot").exception("autopilot summary failed for %s", r.venture_id)
    return told
