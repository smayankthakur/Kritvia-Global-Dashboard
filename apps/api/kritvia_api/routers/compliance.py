"""DPDP Act foundations: consents, data-principal requests (access, correction,
erasure, grievance), retention policies and the breach register.

Requests are executed only by a venture admin (or org owner). Access exports and
erasures work off the keyed principal hash plus the identifier held encrypted
in the request, and every execution is recorded in the hash-chained audit log.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services.crypto import EnvelopeCrypto, mask_label, principal_hash

router = APIRouter(prefix="/ventures/{venture_id}", tags=["compliance"])
DETAILS = "dpdp_requests.details"


async def _admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    return org


async def _admin_or_officer(db, venture_id: uuid.UUID) -> None:
    """Consents gate lending, so only an admin or a loan officer may record or withdraw one."""
    ok = (await db.execute(text("SELECT private.can_admin_venture(:v)"
                                " OR private.has_venture_role(:v, '{loan_officer}')"), {"v": venture_id})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin or a loan officer can change consents")


# ---------------------------------------------------------------- consents --
class ConsentIn(BaseModel):
    identifier: str = Field(min_length=3, max_length=200, description="email, phone or PAN of the data principal")
    purpose: str = Field(pattern=r"^[a-z0-9_]{2,60}$")
    notice_version: str = Field(min_length=1, max_length=40)
    lawful_basis: Literal["consent", "legitimate_use"] = "consent"
    channel: Literal["web", "email", "paper", "whatsapp", "verbal"] = "web"


class ConsentOut(BaseModel):
    id: uuid.UUID
    principal_label: str
    purpose: str
    lawful_basis: str
    notice_version: str
    channel: str
    granted_at: datetime
    withdrawn_at: datetime | None


@router.get("/consents", response_model=list[ConsentOut])
async def list_consents(venture_id: uuid.UUID, db: TenantDB, identifier: str | None = None) -> list[ConsentOut]:
    q, params = ("SELECT id, principal_label, purpose, lawful_basis, notice_version, channel, granted_at, withdrawn_at"
                 " FROM consents WHERE venture_id = :v"), {"v": venture_id}
    if identifier:
        from kritvia_api.engine.context import get_services
        org = await venture_org(db, venture_id)
        q += " AND data_principal = :dp"
        params["dp"] = principal_hash(get_services().keys, org, identifier)
    rows = (await db.execute(text(q + " ORDER BY granted_at DESC LIMIT 500"), params)).all()
    return [ConsentOut(**r._mapping) for r in rows]


@router.post("/consents", response_model=ConsentOut, status_code=201)
async def record_consent(venture_id: uuid.UUID, body: ConsentIn, user_id: UserId, db: TenantDB,
                         svc: Svc) -> ConsentOut:
    org = await venture_org(db, venture_id)
    await _admin_or_officer(db, venture_id)
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "INSERT INTO consents (org_id, venture_id, data_principal, principal_label, purpose, lawful_basis,"
                " notice_version, channel, recorded_by) VALUES (:o, :v, :dp, :l, :p, :lb, :nv, :ch, :u)"
                " RETURNING id, principal_label, purpose, lawful_basis, notice_version, channel, granted_at,"
                " withdrawn_at"),
                {"o": org, "v": venture_id, "dp": principal_hash(svc.keys, org, body.identifier),
                 "l": mask_label(body.identifier), "p": body.purpose, "lb": body.lawful_basis,
                 "nv": body.notice_version, "ch": body.channel, "u": user_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return ConsentOut(**row._mapping)


@router.post("/consents/{consent_id}/withdraw", response_model=ConsentOut)
async def withdraw_consent(venture_id: uuid.UUID, consent_id: uuid.UUID, db: TenantDB) -> ConsentOut:
    await venture_org(db, venture_id)
    await _admin_or_officer(db, venture_id)
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "UPDATE consents SET withdrawn_at = coalesce(withdrawn_at, now()) WHERE venture_id = :v AND id = :id"
                " RETURNING id, principal_label, purpose, lawful_basis, notice_version, channel, granted_at,"
                " withdrawn_at"), {"v": venture_id, "id": consent_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "consent not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "consent not found")
    return ConsentOut(**row._mapping)


# ------------------------------------------------------------ DPDP requests --
class DPDPIn(BaseModel):
    identifier: str = Field(min_length=3, max_length=200)
    kind: Literal["access", "correction", "erasure", "grievance", "nomination"]
    details: str = Field(default="", max_length=5000)


class DPDPOut(BaseModel):
    id: uuid.UUID
    principal_label: str
    kind: str
    status: str
    resolution: str | None
    due_at: datetime
    result: dict[str, Any]
    created_at: datetime
    closed_at: datetime | None
    overdue: bool


DCOLS = ("id, principal_label, kind, status, resolution, due_at, result, created_at, closed_at,"
         " (closed_at IS NULL AND due_at < now()) AS overdue")


@router.get("/dpdp-requests", response_model=list[DPDPOut])
async def list_requests(venture_id: uuid.UUID, db: TenantDB) -> list[DPDPOut]:
    rows = (await db.execute(text(f"SELECT {DCOLS} FROM dpdp_requests WHERE venture_id = :v"
                                  " ORDER BY (closed_at IS NULL) DESC, due_at"), {"v": venture_id})).all()
    return [DPDPOut(**r._mapping) for r in rows]


@router.post("/dpdp-requests", response_model=DPDPOut, status_code=201)
async def create_request(venture_id: uuid.UUID, body: DPDPIn, db: TenantDB, svc: Svc) -> DPDPOut:
    org = await venture_org(db, venture_id)
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, DETAILS, json.dumps(
        {"identifier": body.identifier, "details": body.details}))
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "INSERT INTO dpdp_requests (org_id, venture_id, data_principal, principal_label, kind, details_enc)"
                f" VALUES (:o, :v, :dp, :l, :k, :d) RETURNING {DCOLS}"),
                {"o": org, "v": venture_id, "dp": principal_hash(svc.keys, org, body.identifier),
                 "l": mask_label(body.identifier), "k": body.kind, "d": enc})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return DPDPOut(**row._mapping)


class DPDPPatch(BaseModel):
    status: Literal["verifying", "in_progress", "completed", "rejected"]
    resolution: str | None = Field(default=None, max_length=5000)


@router.patch("/dpdp-requests/{request_id}", response_model=DPDPOut)
async def update_request(venture_id: uuid.UUID, request_id: uuid.UUID, body: DPDPPatch, user_id: UserId,
                         db: TenantDB) -> DPDPOut:
    await _admin(db, venture_id)
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "UPDATE dpdp_requests SET status = :s, resolution = coalesce(:r, resolution), handled_by = :u,"
                " closed_at = CASE WHEN :s IN ('completed', 'rejected') THEN now() ELSE NULL END"
                f" WHERE venture_id = :v AND id = :id RETURNING {DCOLS}"),
                {"s": body.status, "r": body.resolution, "u": user_id, "v": venture_id, "id": request_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "request not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    return DPDPOut(**row._mapping)


class ExecuteOut(BaseModel):
    request: DPDPOut
    export: dict[str, Any] | None = None


@router.post("/dpdp-requests/{request_id}/execute", response_model=ExecuteOut)
async def execute_request(venture_id: uuid.UUID, request_id: uuid.UUID, user_id: UserId, svc: Svc) -> ExecuteOut:
    """access -> export everything held about the principal in this venture;
    erasure -> delete their documents (and all derived chunks/facts), applications and leads.
    Consent records are kept as evidence of lawful processing (withdrawn if still active)."""
    async with tenant_tx(user_id) as db:
        org = await _admin(db, venture_id)
        run_as = (await db.execute(text("SELECT venture_service_account(:v)"), {"v": venture_id})).scalar_one()
        kind = (await db.execute(text("SELECT kind FROM dpdp_requests WHERE venture_id = :v AND id = :id"),
                                 {"v": venture_id, "id": request_id})).scalar()
        await db.execute(text("SELECT audit_event(:o, :v, 'dpdp.execute.requested', 'dpdp_requests', :id)"),
                         {"o": org, "v": venture_id, "id": str(request_id)})
    # Erasure runs as the venture's agent runtime so role-restricted records (loan
    # files) are included — it must be complete regardless of who clicked. An access
    # export runs as the requesting admin, so it can only contain what they may see;
    # restricted records are counted and must be exported by someone holding the role.
    principal, actor, agent = ((run_as, "agent", "dpdp_executor") if kind == "erasure"
                               else (user_id, "user", None))
    async with tenant_tx(principal, actor, agent) as db:
        req = (await db.execute(text("SELECT kind, data_principal, details_enc, status FROM dpdp_requests"
                                     " WHERE venture_id = :v AND id = :id"),
                                {"v": venture_id, "id": request_id})).first()
        if req is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
        if req.kind not in ("access", "erasure"):
            raise HTTPException(422, "only access and erasure requests are executed automatically")
        if req.status in ("completed", "rejected"):
            raise HTTPException(status.HTTP_409_CONFLICT, f"request already {req.status}")
        crypto = EnvelopeCrypto(db, svc.keys)
        ident = json.loads(await crypto.decrypt(venture_id, DETAILS, req.details_enc))["identifier"].strip().lower()
        dp = req.data_principal
        docs = (await db.execute(text("SELECT id, title, kind, created_at FROM documents WHERE venture_id = :v"
                                      " AND data_principal = :dp"), {"v": venture_id, "dp": dp})).all()
        apps = (await db.execute(text("SELECT id, reference, loan_type, status, applicant_enc, created_at"
                                      " FROM loan_applications WHERE venture_id = :v AND data_principal = :dp"),
                                 {"v": venture_id, "dp": dp})).all()
        leads = (await db.execute(text("SELECT id, name, email, company, status, created_at FROM leads"
                                       " WHERE venture_id = :v AND (lower(email) = :i OR phone = :i)"),
                                  {"v": venture_id, "i": ident})).all()
        consents = (await db.execute(text("SELECT purpose, notice_version, granted_at, withdrawn_at FROM consents"
                                          " WHERE venture_id = :v AND data_principal = :dp"),
                                     {"v": venture_id, "dp": dp})).all()
        export = None
        if req.kind == "access":
            export = {
                "documents": [{"title": d.title, "kind": d.kind, "created_at": d.created_at.isoformat()} for d in docs],
                "loan_applications": [{"reference": a.reference, "loan_type": a.loan_type, "status": a.status,
                                       "applicant": json.loads(await crypto.decrypt(
                                           venture_id, "loan_applications.applicant", a.applicant_enc)),
                                       "created_at": a.created_at.isoformat()} for a in apps],
                "leads": [{"name": l.name, "email": l.email, "company": l.company, "status": l.status,
                           "created_at": l.created_at.isoformat()} for l in leads],
                "consents": [{"purpose": c.purpose, "notice_version": c.notice_version,
                              "granted_at": c.granted_at.isoformat(),
                              "withdrawn_at": c.withdrawn_at.isoformat() if c.withdrawn_at else None} for c in consents],
            }
            result = {k: len(v) for k, v in export.items()}
            async with tenant_tx(run_as, "agent", "dpdp_executor") as agent_db:
                hidden = (await agent_db.execute(text(
                    "SELECT (SELECT count(*) FROM loan_applications WHERE venture_id = :v AND data_principal = :dp)"
                    " + (SELECT count(*) FROM documents WHERE venture_id = :v AND data_principal = :dp)"),
                    {"v": venture_id, "dp": dp})).scalar() - len(docs) - len(apps)
            if hidden:
                export["restricted_records_not_exported"] = hidden
                result["restricted_not_exported"] = hidden
        else:
            await db.execute(text("DELETE FROM documents WHERE venture_id = :v AND data_principal = :dp"),
                             {"v": venture_id, "dp": dp})
            await db.execute(text("DELETE FROM loan_applications WHERE venture_id = :v AND data_principal = :dp"),
                             {"v": venture_id, "dp": dp})
            await db.execute(text("DELETE FROM leads WHERE venture_id = :v AND (lower(email) = :i OR phone = :i)"),
                             {"v": venture_id, "i": ident})
            await db.execute(text("UPDATE consents SET withdrawn_at = coalesce(withdrawn_at, now())"
                                  " WHERE venture_id = :v AND data_principal = :dp"), {"v": venture_id, "dp": dp})
            result = {"documents": len(docs), "loan_applications": len(apps), "leads": len(leads),
                      "consents_withdrawn": sum(1 for c in consents if c.withdrawn_at is None)}
        row = (await db.execute(text(
            "UPDATE dpdp_requests SET status = 'completed', result = CAST(:r AS jsonb), handled_by = :u,"
            f" closed_at = now() WHERE id = :id RETURNING {DCOLS}"),
            {"r": json.dumps(result), "u": user_id, "id": request_id})).first()
        await db.execute(text("SELECT audit_event(:o, :v, :a, 'dpdp_requests', :id, CAST(:d AS jsonb))"),
                         {"o": org, "v": venture_id, "a": f"dpdp.{req.kind}.executed", "id": str(request_id),
                          "d": json.dumps(result)})
    return ExecuteOut(request=DPDPOut(**row._mapping), export=export)


# ---------------------------------------------------------------- retention --
DataClass = Literal["upload", "email", "drive", "transcript", "meeting", "note", "proposal", "loan_document", "report"]


class RetentionIn(BaseModel):
    data_class: DataClass
    retain_days: int = Field(ge=1, le=36500)
    note: str | None = Field(default=None, max_length=500)


@router.get("/retention", response_model=list[RetentionIn])
async def list_retention(venture_id: uuid.UUID, db: TenantDB) -> list[RetentionIn]:
    rows = (await db.execute(text("SELECT data_class, retain_days, note FROM retention_policies WHERE venture_id = :v"
                                  " ORDER BY data_class"), {"v": venture_id})).all()
    return [RetentionIn(**r._mapping) for r in rows]


@router.put("/retention", response_model=list[RetentionIn])
async def put_retention(venture_id: uuid.UUID, body: RetentionIn, db: TenantDB) -> list[RetentionIn]:
    """Applies to documents ingested from now on (existing ones keep their deadline)."""
    org = await _admin(db, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO retention_policies (org_id, venture_id, data_class, retain_days, note)"
                " VALUES (:o, :v, :c, :d, :n) ON CONFLICT (venture_id, data_class) DO UPDATE SET"
                " retain_days = EXCLUDED.retain_days, note = EXCLUDED.note, updated_at = now()"),
                {"o": org, "v": venture_id, "c": body.data_class, "d": body.retain_days, "n": body.note})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await list_retention(venture_id, db)


# ------------------------------------------------------------------ breaches --
class BreachIn(BaseModel):
    detected_at: datetime
    summary: str = Field(min_length=3, max_length=5000)
    severity: Literal["low", "medium", "high", "critical"]
    affected_principals: int | None = Field(default=None, ge=0)
    data_classes: list[str] = Field(default_factory=list, max_length=20)
    containment: str | None = Field(default=None, max_length=5000)


class BreachPatch(BaseModel):
    status: Literal["open", "contained", "closed"] | None = None
    containment: str | None = Field(default=None, max_length=5000)
    board_notified: bool | None = None
    principals_notified: bool | None = None


class BreachOut(BaseModel):
    id: uuid.UUID
    detected_at: datetime
    summary: str
    severity: str
    affected_principals: int | None
    data_classes: list[str]
    containment: str | None
    board_notified_at: datetime | None
    principals_notified_at: datetime | None
    status: str
    created_at: datetime


BCOLS = ("id, detected_at, summary, severity, affected_principals, data_classes, containment, board_notified_at,"
         " principals_notified_at, status, created_at")


@router.get("/breaches", response_model=list[BreachOut])
async def list_breaches(venture_id: uuid.UUID, db: TenantDB) -> list[BreachOut]:
    rows = (await db.execute(text(f"SELECT {BCOLS} FROM breach_register WHERE venture_id = :v"
                                  " ORDER BY detected_at DESC"), {"v": venture_id})).all()
    return [BreachOut(**r._mapping) for r in rows]


@router.post("/breaches", response_model=BreachOut, status_code=201)
async def record_breach(venture_id: uuid.UUID, body: BreachIn, user_id: UserId, db: TenantDB) -> BreachOut:
    org = await _admin(db, venture_id)
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "INSERT INTO breach_register (org_id, venture_id, detected_at, summary, severity, affected_principals,"
                " data_classes, containment, recorded_by) VALUES (:o, :v, :d, :s, :sev, :a, :dc, :c, :u)"
                f" RETURNING {BCOLS}"),
                {"o": org, "v": venture_id, "d": body.detected_at, "s": body.summary, "sev": body.severity,
                 "a": body.affected_principals, "dc": body.data_classes, "c": body.containment, "u": user_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return BreachOut(**row._mapping)


@router.patch("/breaches/{breach_id}", response_model=BreachOut)
async def update_breach(venture_id: uuid.UUID, breach_id: uuid.UUID, body: BreachPatch, db: TenantDB) -> BreachOut:
    await _admin(db, venture_id)
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "UPDATE breach_register SET status = coalesce(:s, status), containment = coalesce(:c, containment),"
                " board_notified_at = CASE WHEN :b THEN coalesce(board_notified_at, now()) ELSE board_notified_at END,"
                " principals_notified_at = CASE WHEN :p THEN coalesce(principals_notified_at, now())"
                " ELSE principals_notified_at END"
                f" WHERE venture_id = :v AND id = :id RETURNING {BCOLS}"),
                {"s": body.status, "c": body.containment, "b": bool(body.board_notified),
                 "p": bool(body.principals_notified), "v": venture_id, "id": breach_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "breach not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "breach not found")
    return BreachOut(**row._mapping)

