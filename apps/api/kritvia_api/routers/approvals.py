"""Approval inbox: every write/send an agent drafts waits here for a human.

Decisions go through the decide_approval() database function, which checks the
decider's role, refuses agents, updates earned-autonomy counters and re-queues
the paused run — atomically. Edits are validated against the draft's shape and
the diff is returned so the UI can show exactly what the human changed.
"""
from __future__ import annotations

import difflib
import json
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import PAYLOAD_PURPOSE
from kritvia_api.errors import raise_for_db
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import org_usage

router = APIRouter(tags=["approvals"])


class FieldDiff(BaseModel):
    field: str
    before: Any
    after: Any
    unified: str | None = None


class ApprovalOut(BaseModel):
    id: uuid.UUID
    venture_id: uuid.UUID
    venture_name: str
    run_id: uuid.UUID
    workflow: str
    step: str
    agent: str
    action: str
    capability: str
    title: str
    summary: str
    status: str
    sensitive: bool
    required_roles: list[str]
    can_decide: bool
    payload: dict[str, Any] | None = None
    final_payload: dict[str, Any] | None = None
    diff: list[FieldDiff] = Field(default_factory=list)
    comment: str | None
    decided_by_email: str | None
    decided_at: datetime | None
    executed_at: datetime | None
    execution_result: dict[str, Any] | None
    expires_at: datetime | None
    created_at: datetime


COLS = ("a.id, a.venture_id, v.name AS venture_name, a.run_id, r.workflow, a.step, a.agent, a.action, a.capability,"
        " a.title, a.summary, a.status, a.sensitive, a.required_roles, a.payload_enc, a.final_payload_enc, a.comment,"
        " u.email AS decided_by_email, a.decided_at, a.executed_at, a.execution_result, a.expires_at, a.created_at,"
        " NOT private.is_service_user() AND (private.has_venture_role(a.venture_id, a.required_roles)"
        "   OR (NOT a.sensitive AND a.org_id = ANY (private.owned_orgs()))"
        "   OR (NOT a.sensitive AND 'venture_admin' = ANY (a.required_roles)"
        "       AND private.can_admin_venture(a.venture_id))) AS can_decide")
FROM = (" FROM approvals a JOIN ventures v ON v.id = a.venture_id JOIN workflow_runs r ON r.id = a.run_id"
        " LEFT JOIN users u ON u.id = a.decided_by")


def diff_payloads(before: dict[str, Any], after: dict[str, Any] | None) -> list[FieldDiff]:
    if after is None:
        return []
    out = []
    for k in before:
        b, a = before.get(k), after.get(k)
        if b == a:
            continue
        uni = None
        if isinstance(b, str) and isinstance(a, str):
            uni = "\n".join(difflib.unified_diff(b.splitlines(), a.splitlines(), "draft", "approved", lineterm="", n=2))
        out.append(FieldDiff(field=k, before=b, after=a, unified=uni))
    return out


async def _out(crypto: EnvelopeCrypto, r, with_payload: bool = True) -> ApprovalOut:
    data = {k: v for k, v in r._mapping.items() if k not in ("payload_enc", "final_payload_enc")}
    payload = final = None
    if with_payload:
        payload = json.loads(await crypto.decrypt(r.venture_id, PAYLOAD_PURPOSE, r.payload_enc))
        if r.final_payload_enc is not None:
            final = json.loads(await crypto.decrypt(r.venture_id, PAYLOAD_PURPOSE, r.final_payload_enc))
    return ApprovalOut(**data, payload=payload, final_payload=final,
                       diff=diff_payloads(payload, final) if payload is not None else [])


@router.get("/approvals/inbox", response_model=list[ApprovalOut])
async def inbox(db: TenantDB, svc: Svc, limit: int = 100) -> list[ApprovalOut]:
    """Pending drafts across every venture the caller can read, oldest first."""
    rows = (await db.execute(text(
        f"SELECT {COLS}{FROM} WHERE a.status = 'pending' AND r.status NOT IN ('cancelled', 'failed')"
        " ORDER BY a.created_at LIMIT :l"), {"l": min(max(limit, 1), 300)})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return [await _out(crypto, r) for r in rows]


@router.get("/ventures/{venture_id}/approvals", response_model=list[ApprovalOut])
async def list_approvals(venture_id: uuid.UUID, db: TenantDB, svc: Svc,
                         status_: Literal["pending", "decided", "all"] = Query(default="pending", alias="status"),
                         limit: int = 100
                         ) -> list[ApprovalOut]:
    cond = {"pending": "a.status = 'pending'", "decided": "a.status <> 'pending'", "all": "true"}[status_]
    rows = (await db.execute(text(f"SELECT {COLS}{FROM} WHERE a.venture_id = :v AND {cond}"
                                  " ORDER BY a.created_at DESC LIMIT :l"),
                             {"v": venture_id, "l": min(max(limit, 1), 300)})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return [await _out(crypto, r, with_payload=(status_ == "pending")) for r in rows]


@router.get("/ventures/{venture_id}/approvals/{approval_id}", response_model=ApprovalOut)
async def get_approval(venture_id: uuid.UUID, approval_id: uuid.UUID, db: TenantDB, svc: Svc) -> ApprovalOut:
    r = (await db.execute(text(f"SELECT {COLS}{FROM} WHERE a.venture_id = :v AND a.id = :id"),
                          {"v": venture_id, "id": approval_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")
    return await _out(EnvelopeCrypto(db, svc.keys), r)


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    edited_payload: dict[str, Any] | None = Field(
        default=None, description="Approve with changes: the full payload as it should be executed")
    comment: str | None = Field(default=None, max_length=2000)


def validate_edit(original: dict[str, Any], edited: dict[str, Any]) -> dict[str, Any]:
    extra = set(edited) - set(original)
    if extra:
        raise HTTPException(422, f"unknown fields in edit: {sorted(extra)}")
    merged = dict(original)
    for k, v in edited.items():
        o = original[k]
        if o is not None and v is not None and type(o) is not type(v) and not (
                isinstance(o, int | float) and isinstance(v, int | float)):
            raise HTTPException(422, f"field {k!r} must stay {type(o).__name__}")
        merged[k] = v
    if "to" in merged and (not isinstance(merged["to"], str) or "@" not in merged["to"]):
        raise HTTPException(422, "recipient must be an email address")
    return merged


@router.post("/ventures/{venture_id}/approvals/{approval_id}/decision", response_model=ApprovalOut)
async def decide(venture_id: uuid.UUID, approval_id: uuid.UUID, body: DecisionIn, user_id: UserId,
                 svc: Svc) -> ApprovalOut:
    async with tenant_tx(user_id) as conn:
        row = (await conn.execute(text("SELECT payload_enc, status FROM approvals WHERE id = :id AND venture_id = :v"),
                                  {"id": approval_id, "v": venture_id})).first()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")
        crypto = EnvelopeCrypto(conn, svc.keys)
        final_enc, decision = None, "rejected"
        if body.decision == "approve":
            original = json.loads(await crypto.decrypt(venture_id, PAYLOAD_PURPOSE, row.payload_enc))
            decision = "approved"
            if body.edited_payload is not None:
                merged = validate_edit(original, body.edited_payload)
                if merged != original:
                    decision = "edited"
                    final_enc = await crypto.encrypt(venture_id, PAYLOAD_PURPOSE, json.dumps(merged, default=str))
        try:
            async with conn.begin_nested():
                res = (await conn.execute(text("SELECT * FROM decide_approval(:id, :d, :f, :c)"),
                                          {"id": approval_id, "d": decision, "f": final_enc,
                                           "c": body.comment})).first()
        except DBAPIError as exc:
            raise_for_db(exc, "approval not found")
    await svc.dispatcher.enqueue_run(res.decided_run_id)
    async with tenant_tx(user_id) as conn:
        r = (await conn.execute(text(f"SELECT {COLS}{FROM} WHERE a.id = :id"), {"id": approval_id})).first()
        return await _out(EnvelopeCrypto(conn, svc.keys), r)


# ------------------------------------------------------------------ autonomy --
class TrustOut(BaseModel):
    agent: str
    action: str
    approved_clean: int
    edited: int
    rejected: int
    auto_executed: int
    consecutive_clean: int
    auto_run: bool
    threshold: int
    eligible: bool
    approval_rate: float | None
    promoted_at: datetime | None


@router.get("/ventures/{venture_id}/trust", response_model=list[TrustOut])
async def trust(venture_id: uuid.UUID, db: TenantDB) -> list[TrustOut]:
    rows = (await db.execute(text(
        "SELECT t.*, coalesce(s.trust_threshold, 30) AS threshold FROM agent_trust t"
        " LEFT JOIN venture_settings s ON s.venture_id = t.venture_id WHERE t.venture_id = :v"
        " ORDER BY t.agent, t.action"), {"v": venture_id})).all()
    out = []
    for r in rows:
        decided = r.approved_clean + r.edited + r.rejected
        out.append(TrustOut(agent=r.agent, action=r.action, approved_clean=r.approved_clean, edited=r.edited,
                            rejected=r.rejected, auto_executed=r.auto_executed, consecutive_clean=r.consecutive_clean,
                            auto_run=r.auto_run, threshold=r.threshold, eligible=r.consecutive_clean >= r.threshold,
                            approval_rate=round(r.approved_clean / decided, 3) if decided else None,
                            promoted_at=r.promoted_at))
    return out


class AutonomyIn(BaseModel):
    auto_run: bool
    reason: str = Field(min_length=3, max_length=500)


@router.post("/ventures/{venture_id}/trust/{agent}/{action}", response_model=list[TrustOut])
async def set_autonomy(venture_id: uuid.UUID, agent: str, action: str, body: AutonomyIn, db: TenantDB,
                       svc: Svc) -> list[TrustOut]:
    if body.auto_run:
        org = await venture_org(db, venture_id)
        u = await org_usage(db, org, svc.router.local_deployments())
        if u is not None and not u.plan.autonomy:
            raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                                f"on the {u.plan.name} plan agents always ask first; upgrade to let them act alone")
        cap = u.plan.autonomy_per_agent if u is not None else None
        if cap:   # e.g. Starter: each agent may act alone on one kind of action
            others = (await db.execute(text(
                "SELECT count(*) FROM agent_trust WHERE venture_id = :v AND agent = :a AND auto_run AND action <> :t"),
                {"v": venture_id, "a": agent, "t": action})).scalar()
            if int(others or 0) >= cap:
                raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                                    f"on the {u.plan.name} plan each agent can act alone on {cap} kind of action; "
                                    "switch the other one off first, or upgrade to Growth for no limit")
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT set_autonomy(:v, :a, :t, :auto, :r)"),
                             {"v": venture_id, "a": agent, "t": action, "auto": body.auto_run, "r": body.reason})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await trust(venture_id, db)
