"""Help page contact form. Public (people who cannot sign in need help too), rate-limited."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services.mailer import MailError, get_mailer

router = APIRouter(tags=["support"])


class SupportIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    topic: Literal["question", "problem", "billing", "privacy", "security", "sales"] = "question"
    message: str = Field(min_length=5, max_length=5000)
    website: str = Field(default="", max_length=200, description="leave empty (spam trap)")


@router.post("/public/support", status_code=202)
async def contact(body: SupportIn, request: Request) -> dict:
    await limiter.hit(f"support-ip:{client_ip(request)}", per_minute=3)
    if body.website:          # bots fill every field
        return {"received": True}
    async with tenant_tx(None, "system") as conn:
        rid = (await conn.execute(text("SELECT support_submit(:n, :e, :t, :m, NULL)"),
                                  {"n": body.name.strip(), "e": body.email.lower(), "t": body.topic,
                                   "m": body.message.strip()})).scalar_one()
    inbox = get_settings().support_inbox
    if inbox:
        try:
            await get_mailer().send(inbox, f"[Kritvia {body.topic}] {body.name}",
                                    f"From: {body.name} <{body.email}>\nTopic: {body.topic}\nRef: {rid}\n\n{body.message}")
        except MailError:
            pass  # stored; the operator still sees it
    if not rid:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "could not save your message")
    return {"received": True, "reference": str(rid)[:8]}
