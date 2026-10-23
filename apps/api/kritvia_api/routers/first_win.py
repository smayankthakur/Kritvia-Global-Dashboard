"""First win: from sign-up to the first approved draft in about ten minutes, and Pilot health.

  GET  /ventures/{v}/first-win            the steps, which are done, and how long the first yes took
  POST /ventures/{v}/first-win/practice   a pretend customer email to the Inbox assistant, so a draft
                                          appears at once; its reply goes to the person who asked
  GET  /staff/pilots                      every organisation's progress (Kritvia's team: STAFF_EMAILS)
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.config import FOUNDER_EMAIL, get_settings
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import DuplicateTrigger, start_run
from kritvia_api.ratelimit import limiter
from kritvia_api.workflows.inbox import message_input

router = APIRouter(tags=["first-win"])

PRACTICE = {
    "software": ("Website for my clothing brand?",
                 "Hi, we're a small clothing brand in Jaipur. How much would a 5-page website with a WhatsApp chat button "
                 "cost, and how soon could you start?"),
    "finance": ("Home loan documents",
                "Namaste, I'm looking for a home loan of about 40 lakh for a flat in Pune. What documents do I need, and "
                "how long does approval take?"),
    "kitchen": ("Lunch for 30 next Friday",
                "Hi, can you cater lunch for 30 people next Friday? Veg only, our office is in Andheri. What would it cost?"),
    "trade": ("Quote for 2 containers of basmati",
              "Hello, we are importers in Dubai. Please quote CIF Jebel Ali for 2 x 20ft containers of 1121 basmati rice, "
              "25 kg bags. What is your earliest shipment date and payment terms?"),
    "general": ("Open this Saturday?",
                "Hi, what are your prices, and are you open this Saturday? I'd like to book for two people around 11."),
}


class Step(BaseModel):
    id: str
    title: str
    detail: str
    done: bool
    href: str
    optional: bool = False


class FirstWinOut(BaseModel):
    steps: list[Step]
    done: int
    total: int
    started_at: datetime
    won_at: datetime | None = Field(description="when the business's first draft was approved")
    minutes_to_win: int | None


def is_staff(email: str | None) -> bool:
    raw = get_settings().staff_emails.strip() or FOUNDER_EMAIL
    staff = {e.strip().lower() for e in raw.split(",") if e.strip()}
    return bool(email) and email.lower() in staff


async def require_staff(db, user_id: uuid.UUID) -> None:
    """Kritvia's team only (404 for anyone else). STAFF_EMAILS decides; the answer is recorded in the database
    (private.kritvia_staff, migration 0074), whose staff functions check it again themselves, so no other code
    path can reach them for someone who isn't staff. A staff account must have a verified email."""
    from kritvia_api.db.session import tenant_tx
    email = (await db.execute(text("SELECT email FROM users WHERE id = :u"), {"u": user_id})).scalar()
    staff = is_staff(email)
    # Recorded in its own transaction, so taking someone off STAFF_EMAILS sticks even though this request fails.
    async with tenant_tx(user_id) as conn:
        recorded = (await conn.execute(text("SELECT private.staff_sync(:u, :s)"), {"u": user_id, "s": staff})).scalar()
    if not (staff and recorded):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")


@router.get("/ventures/{venture_id}/first-win", response_model=FirstWinOut)
async def first_win(venture_id: uuid.UUID, db: TenantDB) -> FirstWinOut:
    await venture_org(db, venture_id)
    r = (await db.execute(text("SELECT * FROM private.first_win(:v)"), {"v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    v = f"/v/{venture_id}"
    steps = [
        Step(id="profile", title="Tell Kritvia about your business", done=r.has_profile, href=f"{v}/settings",
             detail="Your business's name and city, so every draft sounds like you."),
        Step(id="agent", title="Switch on the Inbox assistant", done=r.agents_on > 0, href=f"{v}/agents",
             detail="It reads customer messages and drafts replies. Nothing goes out without your yes."),
        Step(id="draft", title="See your first draft", done=r.first_draft_at is not None, href=f"{v}/board",
             detail="Send a practice customer email and watch the reply appear in seconds."),
        Step(id="yes", title="Say yes to it", done=r.first_yes_at is not None, href="/inbox",
             detail="Approve, edit or turn it down. Kritvia learns from what you change."),
        Step(id="phone", title="Get drafts on your phone", done=r.on_phone, href="/account",
             detail="Notifications on this device, or Approve buttons in Telegram or Slack."),
        Step(id="channel", title="Connect where customers write", done=r.has_channel,
             href=f"{v}/settings?tab=connectors",
             detail="Gmail, WhatsApp, a Telegram bot, or forward your email to Kritvia."),
        Step(id="invoice", title="Add an invoice and share its payment link", done=r.has_invoice, optional=True,
             href=f"{v}/invoices", detail="Customers pay by UPI or card; reminders go out for your yes."),
    ]
    won = r.first_yes_at
    return FirstWinOut(steps=steps, done=sum(s.done for s in steps), total=len(steps), started_at=r.created_at,
                       won_at=won, minutes_to_win=max(1, round((won - r.created_at).total_seconds() / 60)) if won else None)


class PracticeOut(BaseModel):
    run_id: uuid.UUID
    reply_to: str


@router.post("/ventures/{venture_id}/first-win/practice", response_model=PracticeOut, status_code=201)
async def practice(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> PracticeOut:
    """A pretend customer email for the Inbox assistant. It is addressed from the person who asked, so
    the reply (after their yes) lands in their own inbox and never reaches a stranger."""
    await venture_org(db, venture_id)
    await limiter.hit(f"practice:{user_id}", per_minute=3)
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can't start agents")
    on = (await db.execute(text("SELECT enabled FROM workflow_configs WHERE venture_id = :v"
                                " AND workflow = 'inbox_assistant'"), {"v": venture_id})).scalar()
    if not on:
        raise HTTPException(status.HTTP_409_CONFLICT, "Switch on the Inbox assistant first (Agents page)")
    me = (await db.execute(text("SELECT email, full_name FROM users WHERE id = :u"), {"u": user_id})).first()
    kind = (await db.execute(text("SELECT kind FROM venture_settings WHERE venture_id = :v"), {"v": venture_id})).scalar()
    subject, body = PRACTICE.get(kind or "general", PRACTICE["general"])
    stamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    try:
        run_id = await start_run(svc, actor_user_id=user_id, actor_type="user", venture_id=venture_id,
                                 workflow="inbox_assistant", trigger_kind="manual", trigger_ref=f"practice-{stamp}",
                                 dedupe=("practice", f"{venture_id}:{user_id}:{stamp}"),
                                 title=f"Practice: {subject}",
                                 input=message_input(channel="email", from_name="Priya (practice customer)",
                                                     from_email=me.email, subject=subject, body=body,
                                                     message_id=None, thread_id=None))
    except DuplicateTrigger:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "one practice message at a time; try again in a moment") from None
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    return PracticeOut(run_id=run_id, reply_to=me.email)


# ------------------------------------------------------------- Pilot health --
class PilotOut(BaseModel):
    org_id: uuid.UUID
    org_name: str
    owner_email: str | None
    plan: str | None
    trial_ends_at: datetime | None
    created_at: datetime
    businesses: int
    members: int
    steps_done: int = Field(description="of 6: profile, agent, draft, yes, phone, channel")
    first_yes_at: datetime | None
    hours_to_first_yes: float | None
    drafts_7d: int
    decided_7d: int
    last_active_at: datetime | None
    health: str = Field(description="won, getting_started, stuck or quiet")


class PilotsOut(BaseModel):
    pilots: list[PilotOut]
    won: int
    stuck: int


def health(r, now: datetime) -> str:
    if r.first_yes_at is None:
        return "stuck" if now - r.created_at > timedelta(days=2) else "getting_started"
    last = r.last_active_at or r.first_yes_at
    return "quiet" if now - last > timedelta(days=7) else "won"


@router.get("/staff/pilots", response_model=PilotsOut)
async def pilots(user_id: UserId, db: TenantDB) -> PilotsOut:
    await require_staff(db, user_id)
    rows = (await db.execute(text("SELECT * FROM private.pilot_health()"))).all()
    now = datetime.now(UTC)
    out = []
    for r in rows:
        done = sum([r.has_profile, r.agents_on > 0, r.first_draft_at is not None, r.first_yes_at is not None,
                    r.on_phone, r.has_channel])
        out.append(PilotOut(
            org_id=r.org_id, org_name=r.org_name, owner_email=r.owner_email, plan=r.plan, trial_ends_at=r.trial_ends_at,
            created_at=r.created_at, businesses=r.businesses, members=r.members, steps_done=done,
            first_yes_at=r.first_yes_at,
            hours_to_first_yes=round((r.first_yes_at - r.created_at).total_seconds() / 3600, 1) if r.first_yes_at else None,
            drafts_7d=r.drafts_7d, decided_7d=r.decided_7d, last_active_at=r.last_active_at, health=health(r, now)))
    return PilotsOut(pilots=out, won=sum(p.health == "won" for p in out), stuck=sum(p.health == "stuck" for p in out))
