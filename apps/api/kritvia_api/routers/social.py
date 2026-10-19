"""Social posts and where they go.

  GET    /ventures/{v}/social                       where the business can post, and its posts
  POST   /ventures/{v}/social/draft-now             write one post now (instead of waiting for a posting day)
  PUT    /ventures/{v}/connectors/facebook          connect the Facebook Page (page id + page token; admins)
  DELETE /ventures/{v}/connectors/facebook          disconnect it
  GET    /ventures/{v}/business-profile/locations   the Google Business Profile listings the Google account manages
  PUT    /ventures/{v}/business-profile             choose the listing (review replies and posts go there)
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.services import facebook, gbp, social
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.google import GoogleError

router = APIRouter(tags=["social"])


async def _admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can change this")
    return org


class PostOut(BaseModel):
    id: uuid.UUID
    topic: str | None
    body: str
    channels: list[str]
    status: Literal["drafted", "posted", "partly_posted", "failed", "dismissed"]
    results: dict[str, Any]
    created_at: datetime
    posted_at: datetime | None


class SocialOut(BaseModel):
    channels: dict[str, str] = Field(description="where posts can go now: google, facebook")
    facebook_page: str | None
    google_business_access: bool = Field(description="Google is connected with Business Profile access")
    google_listing: str | None
    agent_on: bool
    posts: list[PostOut]


@router.get("/ventures/{venture_id}/social", response_model=SocialOut)
async def overview(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> SocialOut:
    await venture_org(db, venture_id)
    where = await social.channels(svc, db, venture_id)
    fb = (await db.execute(text("SELECT account_email FROM connectors WHERE venture_id = :v AND provider = 'facebook_page'"
                                " AND status = 'active'"), {"v": venture_id})).scalar()
    s = (await db.execute(text("SELECT gbp_title FROM review_settings WHERE venture_id = :v"), {"v": venture_id})).first()
    on = bool((await db.execute(text("SELECT enabled FROM workflow_configs WHERE venture_id = :v AND workflow = 'social'"),
                                {"v": venture_id})).scalar())
    rows = (await db.execute(text("SELECT * FROM social_posts WHERE venture_id = :v ORDER BY created_at DESC LIMIT 50"),
                             {"v": venture_id})).all()
    return SocialOut(channels=where, facebook_page=fb, google_business_access=await gbp.has_access(db, venture_id),
                     google_listing=s.gbp_title if s else None, agent_on=on,
                     posts=[PostOut(id=r.id, topic=r.topic, body=r.body, channels=list(r.channels), status=r.status,
                                    results=dict(r.results or {}), created_at=r.created_at, posted_at=r.posted_at)
                            for r in rows])


class StartedOut(BaseModel):
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/social/draft-now", response_model=StartedOut)
async def draft_now(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> StartedOut:
    from kritvia_api.engine.runner import start_run
    from kritvia_api.services.quota import PlanRestricted
    await venture_org(db, venture_id)
    if not await social.channels(svc, db, venture_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "connect the Facebook Page, or Google with Business Profile, first")
    try:
        rid = await start_run(svc, actor_user_id=user_id, actor_type="user", venture_id=venture_id, workflow="social",
                              input={"now": True}, trigger_kind="manual", title="Social post")
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    return StartedOut(run_id=rid)


class FacebookIn(BaseModel):
    page_id: str = Field(min_length=5, max_length=30, pattern=r"^[0-9]+$")
    page_token: str = Field(min_length=20, max_length=1000)


class FacebookOut(BaseModel):
    page_id: str
    page_name: str


@router.put("/ventures/{venture_id}/connectors/facebook", response_model=FacebookOut)
async def connect_facebook(venture_id: uuid.UUID, body: FacebookIn, user_id: UserId, db: TenantDB,
                           svc: Svc) -> FacebookOut:
    from kritvia_api.services.quota import require_integration
    org = await _admin(db, venture_id)
    await require_integration(db, venture_id, "facebook")
    try:
        name = await facebook.check_page(body.page_id, body.page_token.strip())
    except facebook.FacebookError as exc:
        raise HTTPException(422, f"that Page couldn't be reached with this token: {exc}") from None
    cid = (await db.execute(text(
        "INSERT INTO connectors (org_id, venture_id, provider, account_email, external_id, created_by)"
        " VALUES (:o, :v, 'facebook_page', :n, :p, :u) ON CONFLICT (venture_id, provider) DO UPDATE SET"
        " account_email = EXCLUDED.account_email, external_id = EXCLUDED.external_id, status = 'active',"
        " last_error = NULL, updated_at = now() RETURNING id"),
        {"o": org, "v": venture_id, "n": name, "p": body.page_id, "u": user_id})).scalar_one()
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, facebook.SECRET, body.page_token.strip())
    await db.execute(text(
        "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
        " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
        {"c": cid, "o": org, "v": venture_id, "s": enc})
    return FacebookOut(page_id=body.page_id, page_name=name)


@router.delete("/ventures/{venture_id}/connectors/facebook", status_code=204)
async def disconnect_facebook(venture_id: uuid.UUID, db: TenantDB) -> None:
    await _admin(db, venture_id)
    await db.execute(text("UPDATE connectors SET status = 'revoked', updated_at = now() WHERE venture_id = :v"
                          " AND provider = 'facebook_page'"), {"v": venture_id})
    await db.execute(text("DELETE FROM connector_tokens WHERE connector_id IN (SELECT id FROM connectors"
                          " WHERE venture_id = :v AND provider = 'facebook_page')"), {"v": venture_id})


class Listing(BaseModel):
    name: str = Field(pattern=r"^accounts/[0-9]{1,30}/locations/[0-9]{1,30}$")
    title: str = Field(default="", max_length=160)
    address: str = ""


@router.get("/ventures/{venture_id}/business-profile/locations", response_model=list[Listing])
async def gbp_locations(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> list[Listing]:
    await _admin(db, venture_id)
    try:
        prof = await gbp.profile(svc, db, venture_id)
        got = await svc.google.gbp_locations(prof.token)
    except gbp.NotConnected as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    except GoogleError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY,
                            f"Google Business Profile couldn't be read ({exc}); Google may not have approved "
                            "Business Profile API access for Kritvia yet") from None
    return [Listing(name=g["name"], title=g["title"][:160], address=g.get("address", "")[:300]) for g in got]


class ListingIn(BaseModel):
    name: str | None = Field(default=None, pattern=r"^accounts/[0-9]{1,30}/locations/[0-9]{1,30}$")
    title: str | None = Field(default=None, max_length=160)


@router.put("/ventures/{venture_id}/business-profile", response_model=ListingIn)
async def choose_listing(venture_id: uuid.UUID, body: ListingIn, db: TenantDB) -> ListingIn:
    org = await _admin(db, venture_id)
    await db.execute(text(
        "INSERT INTO review_settings (venture_id, org_id, gbp_location, gbp_title) VALUES (:v, :o, :l, :t)"
        " ON CONFLICT (venture_id) DO UPDATE SET gbp_location = EXCLUDED.gbp_location, gbp_title = EXCLUDED.gbp_title,"
        " updated_at = now()"), {"v": venture_id, "o": org, "l": body.name, "t": (body.title or "")[:160] or None})
    return body
