"""Truhome Finance: lending checklists, loan applications, document intake.

Applications and their documents are restricted to the loan_officer role by
database policy. Consent for 'loan_processing' is captured when the
application is created; the verification workflow refuses to run without it.
Clients can upload through an expiring, single-application link.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.services.uploads import read_checked
from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services import memory
from kritvia_api.services.crypto import EnvelopeCrypto, mask_label, principal_hash
from kritvia_api.services.textextract import ExtractionError
from kritvia_api.workflows.loan_verification import DEFAULT_CHECKLIST

router = APIRouter(tags=["truhome"])
APPLICANT = "loan_applications.applicant"
RESTRICTED = ["loan_officer"]


# ----------------------------------------------------------------- checklists --
class ChecklistItem(BaseModel):
    doc_type: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    label: str = Field(min_length=1, max_length=200)
    min_count: int = Field(default=1, ge=1, le=24)
    max_age_days: int | None = Field(default=None, ge=1, le=3650)
    required: bool = True


class ChecklistRule(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9_]{2,60}$")
    kind: Literal["same_name", "same_field", "pan_format", "coverage_months"]
    params: dict[str, Any] = Field(default_factory=dict)
    severity: Literal["low", "medium", "high"] = "medium"


class ChecklistIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    items: list[ChecklistItem] = Field(min_length=1, max_length=40)
    rules: list[ChecklistRule] = Field(default_factory=list, max_length=40)


class ChecklistOut(ChecklistIn):
    id: uuid.UUID
    loan_type: str
    version: int
    active: bool
    created_at: datetime


@router.get("/checklists/template", response_model=ChecklistIn)
async def checklist_template(_: UserId) -> ChecklistIn:
    """Starting point for a new loan type (Truhome's compliance advisor must confirm it)."""
    return ChecklistIn(name="Home loan — salaried", **DEFAULT_CHECKLIST)


@router.get("/ventures/{venture_id}/checklists", response_model=list[ChecklistOut])
async def list_checklists(venture_id: uuid.UUID, db: TenantDB) -> list[ChecklistOut]:
    rows = (await db.execute(text(
        "SELECT id, loan_type, version, name, items, rules, active, created_at FROM document_checklists"
        " WHERE venture_id = :v AND active ORDER BY loan_type"), {"v": venture_id})).all()
    return [ChecklistOut(**r._mapping) for r in rows]


@router.put("/ventures/{venture_id}/checklists/{loan_type}", response_model=ChecklistOut)
async def put_checklist(venture_id: uuid.UUID, loan_type: str, body: ChecklistIn, user_id: UserId,
                        db: TenantDB) -> ChecklistOut:
    """Creates a new version; earlier versions stay for the audit trail of past decisions."""
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v) OR private.has_venture_role(:v, '{loan_officer}')"),
                             {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin or a loan officer can change checklists")
    if not (2 <= len(loan_type) <= 40) or not loan_type.replace("_", "").isalnum() or loan_type != loan_type.lower():
        raise HTTPException(422, "loan_type must be lower_snake_case")
    try:
        async with db.begin_nested():
            await db.execute(text("UPDATE document_checklists SET active = false WHERE venture_id = :v"
                                  " AND loan_type = :t"), {"v": venture_id, "t": loan_type})
            row = (await db.execute(text(
                "INSERT INTO document_checklists (org_id, venture_id, loan_type, version, name, items, rules, created_by)"
                " VALUES (:o, :v, :t, coalesce((SELECT max(version) FROM document_checklists WHERE venture_id = :v"
                " AND loan_type = :t), 0) + 1, :n, CAST(:i AS jsonb), CAST(:r AS jsonb), :u)"
                " RETURNING id, loan_type, version, name, items, rules, active, created_at"),
                {"o": org, "v": venture_id, "t": loan_type, "n": body.name,
                 "i": json.dumps([i.model_dump() for i in body.items]),
                 "r": json.dumps([r.model_dump() for r in body.rules]), "u": user_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return ChecklistOut(**row._mapping)


# --------------------------------------------------------------- applications --
class Applicant(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=20)
    pan: str | None = Field(default=None, pattern=r"^[A-Z]{5}[0-9]{4}[A-Z]$")
    dob: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class ConsentIn(BaseModel):
    notice_version: str = Field(min_length=1, max_length=40)
    channel: Literal["web", "email", "paper", "whatsapp", "verbal"] = "paper"


class ApplicationIn(BaseModel):
    loan_type: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    amount_inr: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    applicant: Applicant
    consent: ConsentIn


class LoanDocOut(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    title: str
    doc_type: str | None
    confidence: float | None
    status: str
    issues: list[dict[str, Any]]
    pii_tags: list[str]
    created_at: datetime


class ApplicationOut(BaseModel):
    id: uuid.UUID
    reference: str
    loan_type: str
    amount_inr: Decimal | None
    applicant: Applicant
    status: str
    checklist_result: dict[str, Any]
    consent_id: uuid.UUID | None
    consent_active: bool
    last_run_id: uuid.UUID | None
    upload_link_expires: datetime | None
    created_at: datetime
    updated_at: datetime
    documents: list[LoanDocOut] = Field(default_factory=list)


APP_COLS = ("a.id, a.venture_id, a.reference, a.loan_type, a.amount_inr, a.applicant_enc, a.status, a.checklist_result,"
            " a.consent_id, a.last_run_id, a.upload_token_expires AS upload_link_expires, a.created_at, a.updated_at,"
            " coalesce((SELECT c.withdrawn_at IS NULL FROM consents c WHERE c.id = a.consent_id), false)"
            " AS consent_active")


async def _app_out(conn, svc, r, with_docs: bool = False) -> ApplicationOut:
    applicant = json.loads(await EnvelopeCrypto(conn, svc.keys).decrypt(r.venture_id, APPLICANT, r.applicant_enc))
    docs = []
    if with_docs:
        rows = (await conn.execute(text(
            "SELECT ld.id, ld.document_id, d.title, ld.doc_type, ld.confidence, ld.status, ld.issues, d.pii_tags,"
            " ld.created_at FROM loan_documents ld JOIN documents d ON d.id = ld.document_id"
            " WHERE ld.application_id = :a ORDER BY ld.created_at"), {"a": r.id})).all()
        docs = [LoanDocOut(**x._mapping) for x in rows]
    data = {k: v for k, v in r._mapping.items() if k not in ("applicant_enc", "venture_id")}
    return ApplicationOut(**data, applicant=Applicant(**applicant), documents=docs)


@router.post("/ventures/{venture_id}/loan-applications", response_model=ApplicationOut, status_code=201)
async def create_application(venture_id: uuid.UUID, body: ApplicationIn, user_id: UserId, svc: Svc) -> ApplicationOut:
    async with tenant_tx(user_id) as conn:
        org = await venture_org(conn, venture_id)
        if not (await conn.execute(text("SELECT private.has_venture_role(:v, '{loan_officer}')"),
                                   {"v": venture_id})).scalar():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
        ident = body.applicant.email or body.applicant.phone or body.applicant.pan or body.applicant.name
        dp = principal_hash(svc.keys, org, ident)
        crypto = EnvelopeCrypto(conn, svc.keys)
        try:
            async with conn.begin_nested():
                consent_id = (await conn.execute(text(
                    "INSERT INTO consents (org_id, venture_id, data_principal, principal_label, purpose, notice_version,"
                    " channel, recorded_by) VALUES (:o, :v, :dp, :lbl, 'loan_processing', :nv, :ch, :u) RETURNING id"),
                    {"o": org, "v": venture_id, "dp": dp, "lbl": mask_label(ident), "nv": body.consent.notice_version,
                     "ch": body.consent.channel, "u": user_id})).scalar_one()
                year = datetime.now(timezone.utc).year
                seq = (await conn.execute(text("SELECT count(*) + 1 FROM loan_applications WHERE venture_id = :v"),
                                          {"v": venture_id})).scalar_one()
                reference = f"TRU-{year}-{seq:05d}-{secrets.token_hex(2).upper()}"
                app_id = (await conn.execute(text(
                    "INSERT INTO loan_applications (org_id, venture_id, reference, loan_type, amount_inr, applicant_enc,"
                    " data_principal, consent_id, created_by) VALUES (:o, :v, :ref, :t, :amt, :ap, :dp, :c, :u)"
                    " RETURNING id"),
                    {"o": org, "v": venture_id, "ref": reference, "t": body.loan_type, "amt": body.amount_inr,
                     "ap": await crypto.encrypt(venture_id, APPLICANT, body.applicant.model_dump_json()),
                     "dp": dp, "c": consent_id, "u": user_id})).scalar_one()
        except DBAPIError as exc:
            raise_for_db(exc, "venture not found")
        r = (await conn.execute(text(f"SELECT {APP_COLS} FROM loan_applications a WHERE a.id = :id"),
                                {"id": app_id})).first()
        return await _app_out(conn, svc, r)


@router.get("/ventures/{venture_id}/loan-applications", response_model=list[ApplicationOut])
async def list_applications(venture_id: uuid.UUID, db: TenantDB, svc: Svc,
                            status_: str | None = Query(default=None, alias="status")) -> list[ApplicationOut]:
    q, params = f"SELECT {APP_COLS} FROM loan_applications a WHERE a.venture_id = :v", {"v": venture_id}
    if status_:
        q += " AND a.status = :s"
        params["s"] = status_
    rows = (await db.execute(text(q + " ORDER BY a.updated_at DESC LIMIT 300"), params)).all()
    return [await _app_out(db, svc, r) for r in rows]


@router.get("/ventures/{venture_id}/loan-applications/{application_id}", response_model=ApplicationOut)
async def get_application(venture_id: uuid.UUID, application_id: uuid.UUID, db: TenantDB, svc: Svc) -> ApplicationOut:
    r = (await db.execute(text(f"SELECT {APP_COLS} FROM loan_applications a WHERE a.venture_id = :v AND a.id = :id"),
                          {"v": venture_id, "id": application_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "application not found")
    org = await venture_org(db, venture_id)
    await db.execute(text("SELECT audit_event(:o, :v, 'loan_application.viewed', 'loan_applications', :id)"),
                     {"o": org, "v": venture_id, "id": str(application_id)})
    return await _app_out(db, svc, r, with_docs=True)


async def attach_documents(actor, application_id: uuid.UUID, files: list[tuple[str, str | None, bytes]],
                           created_by: uuid.UUID | None, data_principal: str) -> list[str]:
    """OCR + mask + encrypt each file as a loan_officer-restricted document, then link it."""
    warnings: list[str] = []
    for filename, mime, data in files:
        try:
            res = await memory.ingest(actor, title=filename, kind="loan_document", data=data, filename=filename,
                                      mime=mime, access_roles=RESTRICTED, sensitive=True, created_by=created_by,
                                      data_principal=data_principal, extract_knowledge=False)
        except ExtractionError as exc:
            warnings.append(f"{filename}: {exc}")
            continue
        async with actor.tx("loan_intake") as conn:
            await conn.execute(text(
                "INSERT INTO loan_documents (org_id, venture_id, application_id, document_id)"
                " VALUES (:o, :v, :a, :d) ON CONFLICT (application_id, document_id) DO NOTHING"),
                {"o": actor.org_id, "v": actor.venture_id, "a": application_id, "d": res.document_id})
        warnings += [f"{filename}: {w}" for w in res.warnings]
    return warnings


class UploadResultOut(BaseModel):
    uploaded: int
    warnings: list[str]
    run_id: uuid.UUID | None


@router.post("/ventures/{venture_id}/loan-applications/{application_id}/documents", response_model=UploadResultOut,
             status_code=201)
async def upload_loan_documents(venture_id: uuid.UUID, application_id: uuid.UUID, user_id: UserId, svc: Svc,
                                files: list[UploadFile] = File(...), verify: bool = True) -> UploadResultOut:
    if len(files) > 20:
        raise HTTPException(422, "at most 20 files per upload")
    async with tenant_tx(user_id) as conn:
        app = (await conn.execute(text("SELECT org_id, data_principal FROM loan_applications WHERE venture_id = :v"
                                       " AND id = :id"), {"v": venture_id, "id": application_id})).first()
    if app is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "application not found")
    payload = []
    for f in files:
        data, mime = await read_checked(f, "document")
        payload.append((f.filename or "document", mime, data))
    actor = memory.UserActor(user_id, app.org_id, venture_id, svc.router, svc.keys, workflow="loan_intake")
    warnings = await attach_documents(actor, application_id, payload, user_id, app.data_principal)
    run_id = None
    if verify:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="loan_verification",
                                 input={"application_id": str(application_id)}, trigger_kind="upload",
                                 title="Verify loan documents")
    return UploadResultOut(uploaded=len(payload), warnings=warnings, run_id=run_id)


class StartedOut(BaseModel):
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/loan-applications/{application_id}/verify", response_model=StartedOut,
             status_code=202)
async def verify(venture_id: uuid.UUID, application_id: uuid.UUID, user_id: UserId, svc: Svc) -> StartedOut:
    async with tenant_tx(user_id) as conn:
        ok = (await conn.execute(text("SELECT 1 FROM loan_applications WHERE venture_id = :v AND id = :id"),
                                 {"v": venture_id, "id": application_id})).first()
    if ok is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "application not found")
    run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="loan_verification",
                             input={"application_id": str(application_id)}, title="Verify loan documents")
    return StartedOut(run_id=run_id)


class UploadLinkOut(BaseModel):
    url: str
    token: str
    expires_at: datetime


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@router.post("/ventures/{venture_id}/loan-applications/{application_id}/upload-link", response_model=UploadLinkOut)
async def upload_link(venture_id: uuid.UUID, application_id: uuid.UUID, db: TenantDB, days: int = 7) -> UploadLinkOut:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=min(max(days, 1), 30))
    try:
        async with db.begin_nested():
            res = await db.execute(text("UPDATE loan_applications SET upload_token_hash = :h, upload_token_expires = :x,"
                                        " updated_at = now() WHERE venture_id = :v AND id = :id"),
                                   {"h": _token_hash(token), "x": expires, "v": venture_id, "id": application_id})
    except DBAPIError as exc:
        raise_for_db(exc, "application not found")
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "application not found")
    return UploadLinkOut(url=f"{get_settings().public_web_url}/upload/{token}", token=token, expires_at=expires)


# ----------------------------------------------------------- public upload --
class PublicUploadInfo(BaseModel):
    reference: str
    needed: list[str]
    expires_at: datetime


async def _resolve_token(token: str):
    if len(token) < 20 or len(token) > 100:
        return None
    async with tenant_tx(None, "system") as conn:
        return (await conn.execute(text("SELECT * FROM private.upload_token_principal(:h)"),
                                   {"h": _token_hash(token)})).first()


@router.get("/public/upload/{token}", response_model=PublicUploadInfo)
async def public_upload_info(token: str, request: Request) -> PublicUploadInfo:
    await limiter.hit(f"public-upload-info:{client_ip(request)}", per_minute=30)
    p = await _resolve_token(token)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "link not found or expired")
    async with tenant_tx(p.run_as, "agent", "client_upload") as conn:
        a = (await conn.execute(text("SELECT reference, checklist_result, upload_token_expires FROM loan_applications"
                                     " WHERE id = :id"), {"id": p.application_id})).first()
    missing = [m["label"] for m in (a.checklist_result or {}).get("missing", [])]
    return PublicUploadInfo(reference=a.reference, needed=missing, expires_at=a.upload_token_expires)


@router.post("/public/upload/{token}", response_model=UploadResultOut, status_code=201)
async def public_upload(token: str, request: Request, svc: Svc, files: list[UploadFile] = File(...)) -> UploadResultOut:
    """Unauthenticated, but scoped to ONE application by an unguessable expiring token.
    The upload runs as the venture's agent runtime, never as a human."""
    await limiter.hit(f"public-upload:{client_ip(request)}", per_minute=10)
    p = await _resolve_token(token)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "link not found or expired")
    if len(files) > 10:
        raise HTTPException(422, "at most 10 files per upload")
    allowed = (".pdf", ".jpg", ".jpeg", ".png", ".webp")
    payload = []
    for f in files:
        name = (f.filename or "document").split("/")[-1].split("\\")[-1]
        if not name.lower().endswith(allowed):
            raise HTTPException(422, "only PDF and image files are accepted")
        data, mime = await read_checked(f, "image_or_pdf")
        payload.append((name, mime, data))

    from kritvia_api.engine.context import RunContext
    ctx = RunContext(run_id=uuid.uuid4(), org_id=p.org_id, venture_id=p.venture_id, run_as=p.run_as,
                     workflow="client_upload", services=svc, agent="client_upload")
    async with ctx.tx() as conn:
        dp = (await conn.execute(text("SELECT data_principal FROM loan_applications WHERE id = :id"),
                                 {"id": p.application_id})).scalar_one()
    warnings = await attach_documents(ctx, p.application_id, payload, None, dp)
    run_id = await start_run(svc, actor_user_id=p.run_as, actor_type="agent", venture_id=p.venture_id,
                             workflow="loan_verification", input={"application_id": str(p.application_id)},
                             trigger_kind="upload", title="Verify client-uploaded documents")
    return UploadResultOut(uploaded=len(payload), warnings=[w.split(":")[0] + ": could not be read" for w in warnings],
                           run_id=run_id)

