"""Ads: spend from uploaded Meta / Google Ads reports set against the leads they brought (services/ads.py).

  POST   /ventures/{v}/ads/reports              upload a campaign report (CSV or Excel)
  GET    /ventures/{v}/ads/reports              what was uploaded
  DELETE /ventures/{v}/ads/reports/{id}         remove one and its spend (admins)
  GET    /ventures/{v}/ads/summary?days=        spend, leads, won and cost per lead, per platform and campaign
  POST   /ventures/{v}/ads/advice               a few suggestions from those numbers (Kritvia never spends)
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.routers.bank import can_write
from kritvia_api.services import ads
from kritvia_api.services.llm import LLMOutputError, complete_json
from kritvia_api.services.model_router import CallContext
from kritvia_api.services.uploads import read_checked
from kritvia_api.workflows.common import IST

router = APIRouter(tags=["ads"])

Platform = Literal["meta", "google", "other"]
PLATFORM_WORDS = {"meta": "Facebook / Instagram (Meta)", "google": "Google Ads", "other": "Other ads"}


class AdReportOut(BaseModel):
    id: uuid.UUID
    platform: Platform
    file_name: str | None
    period_from: date | None
    period_to: date | None
    rows: int
    spend_paise: int
    created_at: datetime


class AdCampaignOut(BaseModel):
    platform: Platform
    campaign: str
    spend_paise: int
    clicks: int | None
    results: int | None = Field(description="what the ad platform counted (its 'results' or 'conversions')")
    leads: int = Field(description="leads in Kritvia tagged with this campaign")
    won: int
    cost_per_lead_paise: int | None


class AdPlatformOut(BaseModel):
    platform: Platform
    words: str
    spend_paise: int
    leads: int
    untagged_leads: int = Field(description="leads from this platform without a campaign name")
    won: int
    cost_per_lead_paise: int | None
    cost_per_won_paise: int | None


class LeadSourceOut(BaseModel):
    source: str
    leads: int
    won: int


class AdSummaryOut(BaseModel):
    days: int
    since: date
    platforms: list[AdPlatformOut]
    campaigns: list[AdCampaignOut]
    sources: list[LeadSourceOut] = Field(description="every lead source in the period, ads or not")
    tracking: bool = Field(description="some leads in the period carry an ad tag")


class AdAdviceOut(BaseModel):
    points: list[str]


class _Advice(BaseModel):
    points: list[str] = Field(description="3-5 short suggestions, each one sentence, grounded in the numbers")


def _out(r) -> AdReportOut:
    return AdReportOut(id=r.id, platform=r.platform, file_name=r.file_name, period_from=r.period_from,
                       period_to=r.period_to, rows=r.rows, spend_paise=r.spend_paise, created_at=r.created_at)


@router.post("/ventures/{venture_id}/ads/reports", response_model=AdReportOut, status_code=201)
async def upload_report(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, file: UploadFile = File(...),
                        platform: Platform | None = Form(default=None),
                        period_from: date | None = Form(default=None),
                        period_to: date | None = Form(default=None)) -> AdReportOut:
    org = await venture_org(db, venture_id)
    await can_write(db, venture_id)
    data, mime = await read_checked(file, "statement", max_mb=10)
    if mime == "application/pdf":
        raise HTTPException(422, "upload the report as CSV or Excel (Export in Ads Manager / Download in Google Ads)")
    period = (period_from, period_to) if period_from and period_to else None
    try:
        found, rows = await asyncio.to_thread(ads.read, data, file.filename or "report.csv", period)
    except ads.ReportError as exc:
        raise HTTPException(422, str(exc)) from None
    plat = platform or found
    rid = (await db.execute(text(
        "INSERT INTO ad_reports (org_id, venture_id, platform, file_name, period_from, period_to, rows, spend_paise,"
        " uploaded_by) VALUES (:o, :v, :p, :f, :a, :b, :n, :s, :u) RETURNING id"),
        {"o": org, "v": venture_id, "p": plat, "f": (file.filename or "")[:200] or None,
         "a": min(r.day_from for r in rows), "b": max(r.day_to for r in rows), "n": len(rows),
         "s": sum(r.spend_paise for r in rows), "u": user_id})).scalar_one()
    for r in rows:
        await db.execute(text(
            "INSERT INTO ad_spend (org_id, venture_id, report_id, platform, campaign, day_from, day_to, spend_paise,"
            " impressions, clicks, results) VALUES (:o, :v, :r, :p, :c, :a, :b, :s, :i, :k, :x)"
            " ON CONFLICT (venture_id, platform, lower(campaign), day_from, day_to) DO UPDATE SET report_id = :r,"
            " campaign = :c, spend_paise = :s, impressions = :i, clicks = :k, results = :x"),
            {"o": org, "v": venture_id, "r": rid, "p": plat, "c": r.campaign, "a": r.day_from, "b": r.day_to,
             "s": r.spend_paise, "i": r.impressions, "k": r.clicks, "x": r.results})
    return _out((await db.execute(text("SELECT * FROM ad_reports WHERE id = :r"), {"r": rid})).first())


@router.get("/ventures/{venture_id}/ads/reports", response_model=list[AdReportOut])
async def list_reports(venture_id: uuid.UUID, db: TenantDB) -> list[AdReportOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT * FROM ad_reports WHERE venture_id = :v ORDER BY created_at DESC LIMIT 50"),
                             {"v": venture_id})).all()
    return [_out(r) for r in rows]


@router.delete("/ventures/{venture_id}/ads/reports/{report_id}", status_code=204)
async def delete_report(venture_id: uuid.UUID, report_id: uuid.UUID, db: TenantDB) -> None:
    await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can remove a report")
    r = await db.execute(text("DELETE FROM ad_reports WHERE id = :r AND venture_id = :v"),
                         {"r": report_id, "v": venture_id})
    if not r.rowcount:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "report not found")


async def summary(db, venture_id: uuid.UUID, days: int) -> AdSummaryOut:
    since = datetime.now(IST).date() - timedelta(days=days - 1)
    # spend overlapping the period, counted in proportion to the days inside it
    spend = (await db.execute(text(
        "SELECT platform, min(campaign) AS campaign, regexp_replace(lower(campaign), '[^a-z0-9]+', '', 'g') AS k,"
        " sum(round(spend_paise * (LEAST(day_to, CAST(:t AS date)) - GREATEST(day_from, CAST(:s AS date)) + 1)::numeric"
        "     / (day_to - day_from + 1)))::bigint AS spend, sum(clicks)::bigint AS clicks, sum(results)::bigint AS results"
        " FROM ad_spend WHERE venture_id = :v AND day_to >= :s AND day_from <= :t GROUP BY platform, 3"),
        {"v": venture_id, "s": since, "t": datetime.now(IST).date()})).all()
    leads = (await db.execute(text(
        "SELECT ad_source, regexp_replace(lower(ad_campaign), '[^a-z0-9]+', '', 'g') AS k, count(*) AS n, count(*) FILTER (WHERE status = 'won') AS won"
        " FROM leads WHERE venture_id = :v AND ad_source IS NOT NULL AND created_at >= CAST(:s AS date)"
        " GROUP BY 1, 2"), {"v": venture_id, "s": since})).all()
    sources = (await db.execute(text(
        "SELECT coalesce(ad_source, source) AS src, count(*) AS n, count(*) FILTER (WHERE status = 'won') AS won"
        " FROM leads WHERE venture_id = :v AND created_at >= CAST(:s AS date) GROUP BY 1 ORDER BY 2 DESC LIMIT 20"),
        {"v": venture_id, "s": since})).all()
    by_lead = {(r.ad_source, r.k): r for r in leads}
    campaigns = []
    for r in sorted(spend, key=lambda x: -int(x.spend or 0)):
        lr = by_lead.get((r.platform, r.k))
        n, w = (int(lr.n), int(lr.won)) if lr else (0, 0)
        campaigns.append(AdCampaignOut(platform=r.platform, campaign=r.campaign, spend_paise=int(r.spend or 0),
                                       clicks=r.clicks, results=r.results, leads=n, won=w,
                                       cost_per_lead_paise=ads.per_lead(int(r.spend or 0), n)))
    platforms = []
    for p in ("meta", "google", "other"):
        sp = sum(c.spend_paise for c in campaigns if c.platform == p)
        n = sum(int(r.n) for r in leads if r.ad_source == p)
        w = sum(int(r.won) for r in leads if r.ad_source == p)
        untagged = sum(int(r.n) for r in leads if r.ad_source == p and not r.k)
        if sp or n:
            platforms.append(AdPlatformOut(platform=p, words=PLATFORM_WORDS[p], spend_paise=sp, leads=n,
                                           untagged_leads=untagged, won=w, cost_per_lead_paise=ads.per_lead(sp, n),
                                           cost_per_won_paise=ads.per_lead(sp, w)))
    return AdSummaryOut(days=days, since=since, platforms=platforms, campaigns=campaigns[:100],
                        sources=[LeadSourceOut(source=r.src, leads=int(r.n), won=int(r.won)) for r in sources],
                        tracking=bool(leads))


@router.get("/ventures/{venture_id}/ads/summary", response_model=AdSummaryOut)
async def get_summary(venture_id: uuid.UUID, db: TenantDB, days: int = Query(default=30, ge=7, le=365)) -> AdSummaryOut:
    await venture_org(db, venture_id)
    return await summary(db, venture_id, days)


@router.post("/ventures/{venture_id}/ads/advice", response_model=AdAdviceOut)
async def advice(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc,
                 days: int = Query(default=30, ge=7, le=365)) -> AdAdviceOut:
    org = await venture_org(db, venture_id)
    s = await summary(db, venture_id, days)
    if not s.campaigns:
        raise HTTPException(status.HTTP_409_CONFLICT, "upload an ad report first")
    facts = {
        "days": days,
        "platforms": [{"platform": p.words, "spend_rupees": p.spend_paise // 100, "leads": p.leads, "won": p.won,
                       "untagged_leads": p.untagged_leads,
                       "cost_per_lead_rupees": (p.cost_per_lead_paise or 0) // 100 or None} for p in s.platforms],
        "campaigns": [{"campaign": c.campaign, "platform": c.platform, "spend_rupees": c.spend_paise // 100,
                       "clicks": c.clicks, "platform_results": c.results, "kritvia_leads": c.leads, "won": c.won}
                      for c in s.campaigns[:25]],
        "all_lead_sources": [{"source": x.source, "leads": x.leads, "won": x.won} for x in s.sources],
        "ad_tags_on_leads": s.tracking,
    }
    cc = CallContext(org_id=org, venture_id=venture_id, user_id=user_id, workflow="ads")
    try:
        r = await complete_json(
            svc.router, cc, tier="reason", schema=_Advice,
            system=("You advise an Indian small business owner on their ads, in plain words. Use ONLY the numbers "
                    "given; never invent figures or benchmarks. Say which campaigns to keep, cut or fix and why, "
                    "and if leads aren't tagged, say to add UTM tags (utm_source, utm_medium=cpc, utm_campaign) to "
                    "the ad links. Never tell them Kritvia will change or spend anything: they make the changes in "
                    "Ads Manager or Google Ads themselves."),
            prompt=f"The numbers for the last {days} days:\n{json.dumps(facts, ensure_ascii=False)}")
    except LLMOutputError:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "couldn't write advice just now; try again") from None
    return AdAdviceOut(points=[p.strip()[:400] for p in r.points if p.strip()][:5])
