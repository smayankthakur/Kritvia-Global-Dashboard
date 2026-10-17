"""Analytics for one business.

  GET /ventures/{venture_id}/analytics?days=30   basic on every plan (30 or 90 days); advanced on
                                                 Growth and above (also 180 and 365 days, and the
                                                 detailed sections)
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from kritvia_api.deps import TenantDB, venture_org
from kritvia_api.services import analytics as an
from kritvia_api.services.quota import plan_for_venture

router = APIRouter(tags=["analytics"])
BASIC_DAYS = (7, 30, 90)
ADVANCED_DAYS = (7, 30, 90, 180, 365)


class AnalyticsOut(BaseModel):
    level: Literal["basic", "advanced"]
    upgrade_to: str | None = Field(description="the plan that unlocks advanced analytics, when this one doesn't")
    days: int
    start: str
    end: str
    bucket: Literal["day", "week", "month"]
    current: dict[str, int]
    previous: dict[str, int] = Field(description="the same numbers for the period just before, to compare")
    trend: list[dict[str, Any]]
    advanced: dict[str, Any] | None = None


@router.get("/ventures/{venture_id}/analytics", response_model=AnalyticsOut)
async def analytics(venture_id: uuid.UUID, db: TenantDB, days: int = Query(30, ge=1, le=366)) -> AnalyticsOut:
    await venture_org(db, venture_id)
    plan = await plan_for_venture(db, venture_id)
    level = "advanced" if plan.analytics == "advanced" else "basic"
    allowed = ADVANCED_DAYS if level == "advanced" else BASIC_DAYS
    if days not in allowed:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED if days in ADVANCED_DAYS else 422,
                            f"{plan.label} shows analytics for {', '.join(str(d) for d in allowed)} days"
                            + ("; upgrade to Growth for up to a year and the detailed sections" if level == "basic" else ""))
    start, end = an.period(days)
    current = await an.headline(db, venture_id, start, end)
    previous = await an.headline(db, venture_id, start - timedelta(days=days), start)
    unit = an.bucket_for(days)
    return AnalyticsOut(
        level=level, upgrade_to=None if level == "advanced" else "Growth",
        days=days, start=start.date().isoformat(), end=(end - timedelta(days=1)).date().isoformat(), bucket=unit,
        current=current, previous=previous, trend=await an.trend(db, venture_id, start, end, unit),
        advanced=await an.advanced(db, venture_id, start, end) if level == "advanced" else None)
