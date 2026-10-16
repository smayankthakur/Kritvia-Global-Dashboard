"""Google reviews: the business's listing, its reviews (live from Google) with drafted replies, and when
to ask customers for a review.

  GET   /ventures/{v}/reviews                  listing, rating, reviews and their reply drafts
  GET   /ventures/{v}/reviews/find-place?q=     find the business's own listing on Google Maps
  PUT   /ventures/{v}/review-settings           listing (place ID only) and when to ask (admins)
  PATCH /ventures/{v}/review-replies/{id}       edit a draft, or mark it posted or dismissed
"""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, venture_org
from kritvia_api.services.places import PlacesError
from kritvia_api.services.places_keys import places_for
from kritvia_api.workflows.reviews import review_key, write_review_url

router = APIRouter(tags=["reviews"])


class ReviewSettings(BaseModel):
    place_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{10,300}$")
    ask_after_booking: bool = True
    ask_after_payment: bool = True


class ReplyOut(BaseModel):
    id: uuid.UUID
    draft: str
    status: str


class ReviewOut(BaseModel):
    rating: int
    text: str
    author: str
    when: str
    reply: ReplyOut | None


class PlaceOut(BaseModel):
    name: str
    rating: float | None
    count: int | None
    maps_url: str | None
    write_review_url: str


class ReviewsOut(BaseModel):
    settings: ReviewSettings
    place: PlaceOut | None
    reviews: list[ReviewOut]
    problem: str | None = Field(description="why Google couldn't be read, in words the owner can act on")
    can_edit: bool
    agent_on: bool


@router.get("/ventures/{venture_id}/reviews", response_model=ReviewsOut)
async def reviews(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> ReviewsOut:
    await venture_org(db, venture_id)
    s = (await db.execute(text("SELECT * FROM review_settings WHERE venture_id = :v"), {"v": venture_id})).first()
    settings = ReviewSettings(place_id=s.place_id, ask_after_booking=s.ask_after_booking,
                              ask_after_payment=s.ask_after_payment) if s else ReviewSettings()
    admin = bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())
    on = bool((await db.execute(text("SELECT enabled FROM workflow_configs WHERE venture_id = :v AND workflow = 'reviews'"),
                                {"v": venture_id})).scalar())
    out = ReviewsOut(settings=settings, place=None, reviews=[], problem=None, can_edit=admin, agent_on=on)
    if not settings.place_id:
        return out
    access = await places_for(db, svc, venture_id)
    if access.client is None:
        out.problem = access.problem
        return out
    try:
        got = await access.client.reviews(settings.place_id)
    except PlacesError as exc:
        out.problem = f"Google Maps couldn't be read right now ({str(exc)[:120]})"
        return out
    replies = {r.review_key: r for r in (await db.execute(text(
        "SELECT id, review_key, draft, status FROM review_replies WHERE venture_id = :v"), {"v": venture_id})).all()}
    out.place = PlaceOut(name=got["name"], rating=got["rating"], count=got["count"], maps_url=got["maps_url"],
                         write_review_url=write_review_url(settings.place_id))
    for rv in got["reviews"]:
        r = replies.get(review_key(rv["name"]))
        out.reviews.append(ReviewOut(rating=rv["rating"], text=rv["text"], author=rv["author"], when=rv["when"],
                                     reply=ReplyOut(id=r.id, draft=r.draft, status=r.status) if r else None))
    return out


class PlaceHit(BaseModel):
    place_id: str
    name: str
    address: str | None
    rating: float | None
    count: int | None


@router.get("/ventures/{venture_id}/reviews/find-place", response_model=list[PlaceHit])
async def find_place(venture_id: uuid.UUID, db: TenantDB, svc: Svc,
                     q: str = Query(min_length=3, max_length=200)) -> list[PlaceHit]:
    await venture_org(db, venture_id)
    access = await places_for(db, svc, venture_id)
    if access.client is None:
        raise HTTPException(status.HTTP_409_CONFLICT, access.problem or "Google Maps isn't set up")
    try:
        found = await access.client.search(q, max_results=5)
    except PlacesError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Google Maps search failed ({str(exc)[:120]})") from None
    return [PlaceHit(place_id=p.place_id, name=p.name, address=p.address, rating=p.rating, count=p.review_count)
            for p in found]


@router.put("/ventures/{venture_id}/review-settings", response_model=ReviewSettings)
async def put_settings(venture_id: uuid.UUID, body: ReviewSettings, db: TenantDB) -> ReviewSettings:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can change this")
    await db.execute(text(
        "INSERT INTO review_settings (venture_id, org_id, place_id, ask_after_booking, ask_after_payment)"
        " VALUES (:v, :o, :p, :b, :i) ON CONFLICT (venture_id) DO UPDATE SET place_id = EXCLUDED.place_id,"
        " ask_after_booking = EXCLUDED.ask_after_booking, ask_after_payment = EXCLUDED.ask_after_payment, updated_at = now()"),
        {"v": venture_id, "o": org, "p": body.place_id, "b": body.ask_after_booking, "i": body.ask_after_payment})
    return body


class ReplyPatch(BaseModel):
    draft: str | None = Field(default=None, min_length=1, max_length=2000)
    status: Literal["drafted", "posted", "dismissed"] | None = None


@router.patch("/ventures/{venture_id}/review-replies/{reply_id}", response_model=ReplyOut)
async def edit_reply(venture_id: uuid.UUID, reply_id: uuid.UUID, body: ReplyPatch, db: TenantDB) -> ReplyOut:
    await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can't change replies")
    fields = body.model_dump(exclude_unset=True, exclude_none=True)
    if not fields:
        raise HTTPException(422, "nothing to change")
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    r = (await db.execute(text(f"UPDATE review_replies SET {sets}, updated_at = now() WHERE id = :r AND venture_id = :v"
                               " RETURNING id, draft, status"), {**fields, "r": reply_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "reply not found")
    return ReplyOut(id=r.id, draft=r.draft, status=r.status)
