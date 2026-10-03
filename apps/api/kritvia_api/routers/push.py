"""Push subscriptions: one per browser the member turned notifications on in."""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.deps import TenantDB, UserId
from kritvia_api.services import push

router = APIRouter(tags=["push"])


class PushConfigOut(BaseModel):
    enabled: bool
    public_key: str | None
    subscribed: int    # browsers this user has subscribed


class SubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)
    keys: dict[str, str]
    user_agent: str = Field(default="", max_length=300)


@router.get("/me/push", response_model=PushConfigOut)
async def config(user_id: UserId, db: TenantDB) -> PushConfigOut:
    n = (await db.execute(text("SELECT count(*) FROM push_subscriptions WHERE user_id = :u"), {"u": user_id})).scalar()
    return PushConfigOut(enabled=push.enabled(), public_key=get_settings().vapid_public_key or None, subscribed=int(n or 0))


@router.post("/me/push", response_model=PushConfigOut, status_code=201)
async def subscribe(body: SubscriptionIn, user_id: UserId, db: TenantDB) -> PushConfigOut:
    if not push.enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "notifications are not set up on this server")
    if not body.endpoint.startswith("https://") or not {"p256dh", "auth"} <= set(body.keys):
        raise HTTPException(422, "that does not look like a browser push subscription")
    org = (await db.execute(text("SELECT org_id FROM memberships WHERE user_id = :u ORDER BY created_at LIMIT 1"),
                            {"u": user_id})).scalar()
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no organisation")
    await db.execute(text(
        "INSERT INTO push_subscriptions (user_id, org_id, endpoint, keys, user_agent)"
        " VALUES (:u, :o, :e, CAST(:k AS jsonb), :ua)"
        " ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys,"
        " user_agent = EXCLUDED.user_agent, failures = 0"),
        {"u": user_id, "o": org, "e": body.endpoint, "k": json.dumps({k: body.keys[k] for k in ("p256dh", "auth")}),
         "ua": body.user_agent[:300]})
    return await config(user_id, db)


class UnsubscribeIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2000)


@router.post("/me/push/unsubscribe", response_model=PushConfigOut)
async def unsubscribe(body: UnsubscribeIn, user_id: UserId, db: TenantDB) -> PushConfigOut:
    await db.execute(text("DELETE FROM push_subscriptions WHERE user_id = :u AND endpoint = :e"),
                     {"u": user_id, "e": body.endpoint})
    return await config(user_id, db)


@router.post("/me/push/test", status_code=202)
async def test_push(user_id: UserId, db: TenantDB) -> dict:
    """Sends a test notification to this user's browsers."""
    rows = (await db.execute(text("SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id = :u AND failures < 5"),
                             {"u": user_id})).all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no browser is subscribed")
    import asyncio
    ok = await asyncio.gather(*(asyncio.to_thread(
        push._send, r.endpoint, dict(r.keys), {"title": "Kritvia", "body": "Notifications are on.", "url": "/inbox",
                                                "tag": f"test-{uuid.uuid4().hex[:6]}"}) for r in rows))
    return {"sent": sum(1 for x in ok if x), "browsers": len(rows)}
