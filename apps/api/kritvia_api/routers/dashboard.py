"""Executive dashboard across every venture the caller can read, and model usage."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId

router = APIRouter(tags=["dashboard"])


class VentureCard(BaseModel):
    venture_id: uuid.UUID
    name: str
    kind: str
    runs_7d: dict[str, int]
    failed_recent: list[dict[str, Any]]
    pending_approvals: int
    oldest_pending_hours: float | None
    approvals_30d: dict[str, int]
    approval_without_edit_rate: float | None
    model_calls_7d: dict[str, Any]
    metrics: dict[str, Any]


class DashboardOut(BaseModel):
    org_id: uuid.UUID
    ventures: list[VentureCard]
    totals: dict[str, Any]


@router.get("/orgs/{org_id}/dashboard", response_model=DashboardOut)
async def dashboard(org_id: uuid.UUID, db: TenantDB) -> DashboardOut:
    ventures = (await db.execute(text(
        "SELECT v.id, v.name, coalesce(s.kind, 'general') AS kind FROM ventures v"
        " LEFT JOIN venture_settings s ON s.venture_id = v.id"
        " WHERE v.org_id = :o AND v.id = ANY (private.readable_ventures()) ORDER BY v.name"), {"o": org_id})).all()
    if not ventures:
        member = (await db.execute(text("SELECT :o = ANY (private.member_orgs())"), {"o": org_id})).scalar()
        if not member:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    cards = []
    for v in ventures:
        p = {"v": v.id}
        runs = {r.status: r.n for r in (await db.execute(text(
            "SELECT status, count(*) AS n FROM workflow_runs WHERE venture_id = :v"
            " AND created_at > now() - interval '7 days' GROUP BY status"), p)).all()}
        failed = [dict(r._mapping) for r in (await db.execute(text(
            "SELECT id, workflow, title, error, updated_at FROM workflow_runs WHERE venture_id = :v"
            " AND status = 'failed' ORDER BY updated_at DESC LIMIT 5"), p)).all()]
        pend = (await db.execute(text(
            "SELECT count(*) AS n, extract(epoch FROM now() - min(created_at)) / 3600 AS oldest FROM approvals"
            " WHERE venture_id = :v AND status = 'pending'"), p)).first()
        ap = {r.status: r.n for r in (await db.execute(text(
            "SELECT status, count(*) AS n FROM approvals WHERE venture_id = :v AND created_at > now() - interval"
            " '30 days' AND status <> 'pending' GROUP BY status"), p)).all()}
        human = ap.get("approved", 0) + ap.get("edited", 0) + ap.get("rejected", 0)
        mc = (await db.execute(text(
            "SELECT count(*) AS calls, count(*) FILTER (WHERE status = 'rate_limited') AS rate_limited,"
            " count(*) FILTER (WHERE status = 'blocked') AS blocked, count(*) FILTER (WHERE status = 'error') AS errors,"
            " coalesce(sum(prompt_tokens), 0) AS prompt_tokens, coalesce(sum(completion_tokens), 0) AS completion_tokens,"
            " coalesce(sum(cost_usd), 0) AS cost_usd"
            " FROM model_calls WHERE venture_id = :v AND created_at > now() - interval '7 days'"), p)).first()
        metrics: dict[str, Any] = {}
        if v.kind in ("software", "general"):
            metrics["leads"] = {r.status: r.n for r in (await db.execute(text(
                "SELECT status, count(*) AS n FROM leads WHERE venture_id = :v GROUP BY status"), p)).all()}
            metrics["hot_leads"] = (await db.execute(text(
                "SELECT count(*) FROM leads WHERE venture_id = :v AND priority = 'hot'"
                " AND status IN ('new','qualified','proposal')"), p)).scalar()
            tt = (await db.execute(text(
                "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.decided_at - r.created_at))"
                " / 3600 FROM approvals a JOIN workflow_runs r ON r.id = a.run_id WHERE a.venture_id = :v"
                " AND r.workflow = 'lead_triage' AND a.agent = 'proposal' AND a.decided_at IS NOT NULL"), p)).scalar()
            metrics["median_hours_inquiry_to_approved_proposal"] = round(tt, 2) if tt is not None else None
        if v.kind in ("finance", "general"):
            metrics["loan_applications"] = {r.status: r.n for r in (await db.execute(text(
                "SELECT status, count(*) AS n FROM loan_applications WHERE venture_id = :v GROUP BY status"), p)).all()}
        if v.kind in ("kitchen", "general"):
            last = (await db.execute(text(
                "SELECT target_date, sum(final_qty) AS portions FROM forecasts WHERE venture_id = :v"
                " GROUP BY target_date ORDER BY target_date DESC LIMIT 1"), p)).first()
            metrics["latest_forecast"] = {"target_date": str(last.target_date), "portions": float(last.portions)} \
                if last else None
            mape = (await db.execute(text(
                "WITH latest AS (SELECT DISTINCT ON (target_date, dish_id) target_date, dish_id, final_qty"
                " FROM forecasts WHERE venture_id = :v AND target_date > current_date - 14"
                " ORDER BY target_date, dish_id, created_at DESC),"
                " actual AS (SELECT sale_date, dish_id, sum(qty) AS qty FROM sales_daily WHERE venture_id = :v"
                " GROUP BY 1, 2) SELECT avg(abs(l.final_qty - a.qty) / a.qty) * 100 FROM latest l JOIN actual a"
                " ON a.sale_date = l.target_date AND a.dish_id = l.dish_id AND a.qty > 0"), p)).scalar()
            metrics["mape_14d"] = round(float(mape), 1) if mape is not None else None
            metrics["po_value_7d"] = float((await db.execute(text(
                "SELECT coalesce(sum(total_inr), 0) FROM purchase_orders WHERE venture_id = :v AND status = 'sent'"
                " AND sent_at > now() - interval '7 days'"), p)).scalar())
        cards.append(VentureCard(
            venture_id=v.id, name=v.name, kind=v.kind, runs_7d=runs, failed_recent=failed,
            pending_approvals=pend.n, oldest_pending_hours=round(pend.oldest, 1) if pend.oldest else None,
            approvals_30d=ap, approval_without_edit_rate=round(ap.get("approved", 0) / human, 3) if human else None,
            model_calls_7d={k: (float(v2) if k == "cost_usd" else v2) for k, v2 in mc._mapping.items()},
            metrics=metrics))
    totals = {"pending_approvals": sum(c.pending_approvals for c in cards),
              "failed_runs": sum(len(c.failed_recent) for c in cards),
              "runs_7d": sum(sum(c.runs_7d.values()) for c in cards)}
    return DashboardOut(org_id=org_id, ventures=cards, totals=totals)


class UsageRow(BaseModel):
    day: str
    tier: str
    provider_model: str | None
    calls: int
    ok: int
    rate_limited: int
    blocked: int
    errors: int
    prompt_tokens: int
    completion_tokens: int
    avg_latency_ms: float | None


@router.get("/ventures/{venture_id}/usage", response_model=list[UsageRow])
async def usage(venture_id: uuid.UUID, db: TenantDB, days: int = 14) -> list[UsageRow]:
    rows = (await db.execute(text(
        "SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, tier, provider_model, count(*) AS calls,"
        " count(*) FILTER (WHERE status = 'ok') AS ok, count(*) FILTER (WHERE status = 'rate_limited') AS rate_limited,"
        " count(*) FILTER (WHERE status = 'blocked') AS blocked, count(*) FILTER (WHERE status = 'error') AS errors,"
        " coalesce(sum(prompt_tokens), 0) AS prompt_tokens, coalesce(sum(completion_tokens), 0) AS completion_tokens,"
        " avg(latency_ms) AS avg_latency_ms FROM model_calls WHERE venture_id = :v"
        " AND created_at > now() - make_interval(days => :d) GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2"),
        {"v": venture_id, "d": min(max(days, 1), 90)})).all()
    return [UsageRow(**{**r._mapping, "avg_latency_ms": float(r.avg_latency_ms) if r.avg_latency_ms else None})
            for r in rows]


class TierOut(BaseModel):
    tier: str
    chain: list[dict[str, str]]


@router.get("/tiers", response_model=list[TierOut])
async def tiers(_: UserId, svc: Svc) -> list[TierOut]:
    """Capability tiers and their fallback chains (no secrets): what 'private' really means."""
    cfg = svc.router.config
    return [TierOut(tier=t, chain=[{"deployment": d, "data_policy": cfg.policies[d],
                                    "sensitive_allowed": str(cfg.policies[d] in cfg.sensitive_allowed).lower()}
                                   for d in chain]) for t, chain in cfg.tiers.items()]
