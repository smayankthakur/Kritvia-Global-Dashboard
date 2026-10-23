"""Booking reminders: a short note the day before each booking, for a person's yes.

  daily: find   tomorrow's confirmed bookings (business time) not yet reminded -> one `touch` run each
  touch: draft  the reminder in the channel the customer booked on (WhatsApp, Telegram or email)
                -> [approval: whatsapp.send / telegram.send / gmail.send]
         sent   sends it and marks the booking reminded

The text is written by code from the booking (service, day and time): nothing is guessed. A WhatsApp
reminder only reaches customers who wrote in the last 24 hours (WhatsApp's rule); otherwise it fails
with that reason and the team can call.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Option, Workflow, registry
from kritvia_api.services.bookings import label

wf = registry.register(Workflow(
    "booking_reminders", title="Booking reminders", start="route",
    trigger="Every day at the time you set",
    description="Reminds customers the day before their booking, on WhatsApp, Telegram or email, after your yes.",
    options=(
        Option("note", "Add to every reminder (optional)", "text", "",
               help="e.g. 'Please come 5 minutes early. Parking is behind the building.'"),
    ), default_schedule="18:00"))

MAX_PER_DAY = 100


@wf.step("route", agent="booking_reminders")
async def route(ctx: RunContext, state: dict) -> Goto:
    return Goto("draft" if (state["input"] or {}).get("mode") == "touch" else "find")


async def _tz(ctx: RunContext) -> ZoneInfo:
    async with ctx.tx() as conn:
        tz = (await conn.execute(text("SELECT timezone FROM venture_settings WHERE venture_id = :v"),
                                 {"v": ctx.venture_id})).scalar()
    try:
        return ZoneInfo(tz or "Asia/Kolkata")
    except Exception:  # noqa: BLE001
        return ZoneInfo("Asia/Kolkata")


@wf.step("find", agent="booking_reminders")
async def find(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    tz = await _tz(ctx)
    tomorrow = datetime.now(tz).date() + timedelta(days=1)
    start = datetime.combine(tomorrow, datetime.min.time(), tz)
    async with ctx.tx() as conn:
        rows = (await conn.execute(text(
            "SELECT id FROM bookings WHERE venture_id = :v AND status = 'confirmed' AND reminded_at IS NULL"
            " AND address IS NOT NULL AND channel <> 'manual' AND starts_at >= :s AND starts_at < :e"
            " ORDER BY starts_at LIMIT :n"),
            {"v": ctx.venture_id, "s": start, "e": start + timedelta(days=1), "n": MAX_PER_DAY})).all()
    started = 0
    for r in rows:
        try:
            await start_run(ctx.services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                            workflow="booking_reminders", trigger_kind="schedule",
                            dedupe=("booking_reminders", str(r.id)), title="Booking reminder",
                            input={"mode": "touch", "booking_id": str(r.id)})
            started += 1
        except DuplicateTrigger:
            continue
    return Finish("found", update={"summary": {"reminders": started}}, note=f"{started} reminder(s) to write")


async def _booking(ctx: RunContext, booking_id: str):
    async with ctx.tx() as conn:
        return (await conn.execute(text("SELECT * FROM bookings WHERE id = :b AND venture_id = :v"),
                                   {"b": uuid.UUID(booking_id), "v": ctx.venture_id})).first()


@wf.step("draft", agent="booking_reminders")
async def draft(ctx: RunContext, state: dict) -> Interrupt | Finish:
    b = await _booking(ctx, state["input"]["booking_id"])
    if b is None or b.status != "confirmed" or b.reminded_at is not None or not b.address:
        return Finish("not_needed", note="cancelled, already reminded, or no way to reach the customer")
    cfg, biz, tz = await ctx.settings(), await ctx.business(), await _tz(ctx)
    when = label(b.starts_at.astimezone(tz))
    first = (b.customer_name or "").split(" ")[0] or "there"
    body = (f"Hi {first}, a reminder of your {b.service_name} at {biz.name} tomorrow, {when}. "
            "If you need to change it, just reply here.")
    note = str(cfg.get("note") or "").strip()
    if note:
        body += f" {note[:300]}"
    if b.channel in ("whatsapp", "telegram"):
        action, payload = f"{b.channel}.send", {"to": b.address, "body": body}
    else:
        action, payload = "gmail.send", {"to": b.address, "subject": f"Reminder: {b.service_name} tomorrow",
                                         "body": biz.with_notice(f"{body}\n\n{biz.sign_off}"), "thread_id": None}
    return Interrupt(
        ApprovalRequest(agent="booking_reminders", action=action, key="send_decision",
                        title=f"Booking reminder to {b.customer_name}"[:140],
                        summary=f"{b.service_name}, {when}, by {b.channel}."[:300], payload=payload,
                        required_roles=("approver", "venture_admin"), expires_in_hours=20),
        resume="sent", on_reject="skipped", update={"action": action, "booking_id": str(b.id)},
        note=f"reminder drafted ({b.channel})")


@wf.step("sent", agent="booking_reminders")
async def sent(ctx: RunContext, state: dict) -> Finish:
    b = await _booking(ctx, state["booking_id"])
    if b is None or b.status != "confirmed":
        return Finish("not_needed", note="the booking was cancelled before the reminder went out")
    res = await ctx.invoke(state["action"], approval_id=state["send_decision"]["approval_id"])
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE bookings SET reminded_at = now(), updated_at = now() WHERE id = :b"), {"b": b.id})
    return Finish("reminded", note=f"reminder {res.get('status')} via {res.get('transport')}")


@wf.step("skipped", agent="booking_reminders")
async def skipped(ctx: RunContext, state: dict) -> Finish:
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE bookings SET reminded_at = now() WHERE id = :b AND venture_id = :v"),
                           {"b": uuid.UUID(state["booking_id"]), "v": ctx.venture_id})
    return Finish("not_sent")
