"""Campaigns: one WhatsApp template or email to many customers, after one yes (services/campaigns.py).

  GET    /ventures/{v}/campaigns                    campaigns, newest first
  GET    /ventures/{v}/campaigns/audience?channel=&audience=   how many people that would reach
  POST   /ventures/{v}/campaigns                    a draft (admins)
  POST   /ventures/{v}/campaigns/{id}/send          fix the list and ask for the yes (admins)
  POST   /ventures/{v}/campaigns/{id}/cancel        stop it (before or while it sends)
  DELETE /ventures/{v}/campaigns/{id}               a draft
  POST   /public/campaign-unsubscribe               the signed link in every campaign email
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services import campaigns as cs

router = APIRouter(tags=["campaigns"])

Channel = Literal["whatsapp", "email"]
Audience = Literal["opted_in", "customers", "recent_customers"]


class CampaignIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    channel: Channel
    audience: Audience = "customers"
    template_id: uuid.UUID | None = Field(default=None, description="WhatsApp: one of the business's approved templates")
    params: list[str] = Field(default_factory=list, max_length=10, description="WhatsApp: the template's blanks")
    subject: str | None = Field(default=None, max_length=150)
    body: str | None = Field(default=None, max_length=5000)


class CampaignOut(BaseModel):
    id: uuid.UUID
    name: str
    channel: Channel
    audience: Audience
    template_id: uuid.UUID | None
    template: str | None
    params: list[str]
    subject: str | None
    body: str | None
    status: Literal["draft", "waiting", "sending", "sent", "rejected", "cancelled", "failed"]
    recipients: int
    sent: int
    failed: int
    skipped: int
    created_at: datetime
    sent_at: datetime | None


class AudienceOut(BaseModel):
    people: int
    capped: bool = Field(description="more than a campaign can take; the first ones are used")


async def _admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can send campaigns")
    return org


SELECT = ("SELECT c.*, t.name AS template FROM campaigns c LEFT JOIN wa_templates t ON t.id = c.template_id")


def _out(r) -> CampaignOut:
    return CampaignOut(id=r.id, name=r.name, channel=r.channel, audience=r.audience, template_id=r.template_id,
                       template=r.template, params=list(r.params or []), subject=r.subject, body=r.body,
                       status=r.status, recipients=r.recipients, sent=r.sent, failed=r.failed, skipped=r.skipped,
                       created_at=r.created_at, sent_at=r.sent_at)


@router.get("/ventures/{venture_id}/campaigns", response_model=list[CampaignOut])
async def list_campaigns(venture_id: uuid.UUID, db: TenantDB) -> list[CampaignOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text(f"{SELECT} WHERE c.venture_id = :v ORDER BY c.created_at DESC LIMIT 100"),
                             {"v": venture_id})).all()
    return [_out(r) for r in rows]


@router.get("/ventures/{venture_id}/campaigns/audience", response_model=AudienceOut)
async def audience_size(venture_id: uuid.UUID, db: TenantDB, channel: Channel, audience: Audience) -> AudienceOut:
    await venture_org(db, venture_id)
    if channel == "email" and audience == "opted_in":
        raise HTTPException(422, "an email campaign goes to customers")
    people = await cs.audience(db, venture_id, channel, audience)
    return AudienceOut(people=min(len(people), cs.MAX_RECIPIENTS), capped=len(people) > cs.MAX_RECIPIENTS)


@router.post("/ventures/{venture_id}/campaigns", response_model=CampaignOut, status_code=201)
async def create_campaign(venture_id: uuid.UUID, body: CampaignIn, user_id: UserId, db: TenantDB) -> CampaignOut:
    from kritvia_api.services import wa_templates
    org = await _admin(db, venture_id)
    if body.channel == "whatsapp":
        t = await wa_templates.by_id(db, venture_id, str(body.template_id)) if body.template_id else None
        try:
            wa_templates.render(t, body.params)
        except wa_templates.TemplateProblem as exc:
            raise HTTPException(422, str(exc)) from None
        subject = msg = None
    else:
        if body.audience == "opted_in":
            raise HTTPException(422, "an email campaign goes to customers")
        if not (body.subject or "").strip() or not (body.body or "").strip():
            raise HTTPException(422, "an email campaign needs a subject and a message")
        subject, msg = body.subject.strip(), body.body.strip()
    cid = (await db.execute(text(
        "INSERT INTO campaigns (org_id, venture_id, name, channel, template_id, params, subject, body, audience,"
        " created_by) VALUES (:o, :v, :n, :c, :t, CAST(:p AS jsonb), :s, :b, :a, :u) RETURNING id"),
        {"o": org, "v": venture_id, "n": body.name.strip(), "c": body.channel,
         "t": body.template_id if body.channel == "whatsapp" else None,
         "p": __import__("json").dumps([x.strip() for x in body.params] if body.channel == "whatsapp" else []),
         "s": subject, "b": msg, "a": body.audience, "u": user_id})).scalar_one()
    return _out((await db.execute(text(f"{SELECT} WHERE c.id = :c"), {"c": cid})).first())


class StartedOut(BaseModel):
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/campaigns/{campaign_id}/send", response_model=StartedOut)
async def send_campaign(venture_id: uuid.UUID, campaign_id: uuid.UUID, user_id: UserId, db: TenantDB,
                        svc: Svc) -> StartedOut:
    from kritvia_api.engine.runner import start_run
    from kritvia_api.services.quota import PlanRestricted
    await _admin(db, venture_id)
    c = (await db.execute(text("SELECT status, name FROM campaigns WHERE id = :c AND venture_id = :v"),
                          {"c": campaign_id, "v": venture_id})).first()
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "campaign not found")
    if c.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, f"this campaign is {c.status}")
    try:
        rid = await start_run(svc, actor_user_id=user_id, actor_type="user", venture_id=venture_id, workflow="campaign",
                              input={"campaign_id": str(campaign_id)}, trigger_kind="manual",
                              title=f"Campaign: {c.name}"[:120])
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    return StartedOut(run_id=rid)


@router.post("/ventures/{venture_id}/campaigns/{campaign_id}/cancel", response_model=CampaignOut)
async def cancel_campaign(venture_id: uuid.UUID, campaign_id: uuid.UUID, user_id: UserId, db: TenantDB) -> CampaignOut:
    """Stops a campaign: a draft or one waiting for its yes is cancelled; one sending stops after its batch."""
    await _admin(db, venture_id)
    r = (await db.execute(text(
        "UPDATE campaigns c SET status = 'cancelled' FROM (SELECT id, status AS was FROM campaigns WHERE id = :c"
        " FOR UPDATE) old WHERE c.id = old.id AND c.venture_id = :v AND c.status IN ('draft', 'waiting', 'sending')"
        " RETURNING c.run_id, old.was"), {"c": campaign_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this campaign can't be stopped now")
    await db.execute(text("DELETE FROM campaign_recipients WHERE campaign_id = :c AND status = 'queued'"),
                     {"c": campaign_id})
    if r.run_id and r.was == "waiting":       # the run waits for the yes: it ends here (as cancel_run does)
        n = await db.execute(text(
            "UPDATE workflow_runs SET status = 'cancelled', finished_at = now(), updated_at = now(),"
            " lease_owner = NULL, lease_until = NULL WHERE id = :r AND status IN ('queued', 'waiting', 'failed')"),
            {"r": r.run_id})
        if n.rowcount:
            await db.execute(text("UPDATE approvals SET status = 'cancelled' WHERE run_id = :r AND status = 'pending'"),
                             {"r": r.run_id})
            await db.execute(text("SELECT ticket_for_run(:r, 'cancelled', NULL)"), {"r": r.run_id})
    return _out((await db.execute(text(f"{SELECT} WHERE c.id = :c"), {"c": campaign_id})).first())


@router.delete("/ventures/{venture_id}/campaigns/{campaign_id}", status_code=204)
async def delete_campaign(venture_id: uuid.UUID, campaign_id: uuid.UUID, db: TenantDB) -> None:
    await _admin(db, venture_id)
    r = await db.execute(text("DELETE FROM campaigns WHERE id = :c AND venture_id = :v AND status IN ('draft', 'cancelled',"
                              " 'rejected', 'failed')"), {"c": campaign_id, "v": venture_id})
    if not r.rowcount:
        raise HTTPException(status.HTTP_409_CONFLICT, "only a campaign that wasn't sent can be deleted")


class CampaignUnsubscribeIn(BaseModel):
    token: str = Field(min_length=40, max_length=500)


@router.post("/public/campaign-unsubscribe")
async def campaign_unsubscribe(body: CampaignUnsubscribeIn, request: Request) -> dict:
    await limiter.hit(f"campaign-unsub-ip:{client_ip(request)}", per_minute=20)
    got = cs.verify(body.token)
    if got is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this unsubscribe link is not valid")
    venture_id, address = got
    async with tenant_tx(None, "system") as conn:
        await conn.execute(text("SELECT private.email_unsubscribe(:v, :a)"), {"v": venture_id, "a": address})
        name = (await conn.execute(text("SELECT coalesce(nullif(s.business_name, ''), v.name) FROM ventures v"
                                        " LEFT JOIN venture_settings s ON s.venture_id = v.id WHERE v.id = :v"),
                                   {"v": venture_id})).scalar()
    return {"ok": True, "business": name or "this business"}
