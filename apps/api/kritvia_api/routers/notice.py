"""The privacy notice a business gives its own customers (DPDP Act s.5), published by Kritvia.

Public and read-only. It shows only what the business chose to publish: its name, city, the
privacy contact it named, and which kinds of processing its switched-on agents do.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.ratelimit import client_ip, limiter

router = APIRouter(tags=["public"])


class NoticeOut(BaseModel):
    business_name: str
    city: str
    contact_name: str
    contact_email: str
    kind: str
    workflows: list[str]
    updated_at: datetime


@router.get("/public/notice/{venture_id}", response_model=NoticeOut)
async def public_notice(venture_id: uuid.UUID, request: Request) -> NoticeOut:
    await limiter.hit(f"notice:{client_ip(request)}", per_minute=60)
    async with tenant_tx(None, "system") as conn:
        row = (await conn.execute(text("SELECT * FROM private.public_notice(:v)"), {"v": venture_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no privacy notice published")
    return NoticeOut(business_name=row.business_name, city=row.city, contact_name=row.contact_name,
                     contact_email=row.contact_email, kind=row.kind, workflows=list(row.workflows or []),
                     updated_at=row.updated_at)
