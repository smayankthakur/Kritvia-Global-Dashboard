"""People: hiring and attendance (services/people.py, workflows/hiring.py).

  GET/POST  /ventures/{v}/jobs                                 open and closed roles; add one (admins)
  PATCH     /ventures/{v}/jobs/{id}                            change it, or close it
  GET       /ventures/{v}/jobs/{id}/candidates                 who applied, best first
  POST      /ventures/{v}/jobs/{id}/candidates                 upload a CV (PDF or Word); Kritvia screens it
  GET       /ventures/{v}/candidates/{id}                      one candidate, with the CV text (admins)
  PATCH     /ventures/{v}/candidates/{id}                      shortlist, reject or mark hired (by a person)
  GET/POST  /ventures/{v}/staff                                the team; add someone (admins)
  PATCH     /ventures/{v}/staff/{id}
  GET       /ventures/{v}/attendance?day=                      who came in on a day
  PUT       /ventures/{v}/attendance                           mark someone (present, half day, absent, leave)
  GET       /ventures/{v}/attendance/sheet?month=              the month added up, with a pay estimate
  GET       /ventures/{v}/attendance/sheet/file?month=         the same as Excel, for the accountant
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, time
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.routers.invoices import phone_digits
from kritvia_api.services import people
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.textextract import ExtractionError, extract_text
from kritvia_api.services.uploads import read_checked
from kritvia_api.workflows.common import IST
from kritvia_api.workflows.hiring import CV_PURPOSE

router = APIRouter(tags=["people"])


async def _admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can do this")
    return org


async def _writer(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can see this but not change it")
    return org


# -------------------------------------------------------------------------------------------- jobs --
class JobIn(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    location: str | None = Field(default=None, max_length=120)
    description: str = Field(default="", max_length=4000)
    must_have: str = Field(default="", max_length=2000)
    nice_to_have: str = Field(default="", max_length=2000)


class JobPatch(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=120)
    location: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    must_have: str | None = Field(default=None, max_length=2000)
    nice_to_have: str | None = Field(default=None, max_length=2000)
    status: Literal["open", "closed"] | None = None


class JobOut(BaseModel):
    id: uuid.UUID
    code: str
    title: str
    location: str | None
    description: str
    must_have: str
    nice_to_have: str
    status: Literal["open", "closed"]
    candidates: int
    shortlisted: int
    created_at: datetime
    apply_by_email: str | None = Field(description="send CVs here with the code in the subject")


JOB_SQL = ("SELECT j.*, (SELECT count(*) FROM candidates c WHERE c.job_id = j.id) AS candidates,"
           " (SELECT count(*) FROM candidates c WHERE c.job_id = j.id AND c.status IN ('shortlisted', 'invited', 'hired'))"
           " AS shortlisted FROM jobs j")


async def _forwarding(db, venture_id: uuid.UUID) -> str | None:
    return (await db.execute(text("SELECT account_email FROM connectors WHERE venture_id = :v AND provider = 'email_in'"
                                  " AND status = 'active'"), {"v": venture_id})).scalar()


def _job(r, addr: str | None) -> JobOut:
    return JobOut(id=r.id, code=r.code, title=r.title, location=r.location, description=r.description,
                  must_have=r.must_have, nice_to_have=r.nice_to_have, status=r.status, candidates=r.candidates,
                  shortlisted=r.shortlisted, created_at=r.created_at, apply_by_email=addr)


@router.get("/ventures/{venture_id}/jobs", response_model=list[JobOut])
async def list_jobs(venture_id: uuid.UUID, db: TenantDB) -> list[JobOut]:
    await venture_org(db, venture_id)
    addr = await _forwarding(db, venture_id)
    rows = (await db.execute(text(f"{JOB_SQL} WHERE j.venture_id = :v ORDER BY j.status = 'closed', j.created_at DESC"),
                             {"v": venture_id})).all()
    return [_job(r, addr) for r in rows]


@router.post("/ventures/{venture_id}/jobs", response_model=JobOut, status_code=201)
async def add_job(venture_id: uuid.UUID, body: JobIn, user_id: UserId, db: TenantDB) -> JobOut:
    org = await _admin(db, venture_id)
    for _ in range(5):
        try:
            async with db.begin_nested():
                jid = (await db.execute(text(
                    "INSERT INTO jobs (org_id, venture_id, code, title, location, description, must_have, nice_to_have,"
                    " created_by) VALUES (:o, :v, :c, :t, :l, :d, :m, :n, :u) RETURNING id"),
                    {"o": org, "v": venture_id, "c": people.new_code(), "t": body.title.strip(),
                     "l": (body.location or "").strip() or None, "d": body.description.strip(),
                     "m": body.must_have.strip(), "n": body.nice_to_have.strip(), "u": user_id})).scalar_one()
            break
        except IntegrityError:
            continue
    else:
        raise HTTPException(status.HTTP_409_CONFLICT, "try again")
    r = (await db.execute(text(f"{JOB_SQL} WHERE j.id = :j"), {"j": jid})).first()
    return _job(r, await _forwarding(db, venture_id))


@router.patch("/ventures/{venture_id}/jobs/{job_id}", response_model=JobOut)
async def edit_job(venture_id: uuid.UUID, job_id: uuid.UUID, body: JobPatch, db: TenantDB) -> JobOut:
    await _admin(db, venture_id)
    fields = {k: (v.strip() if isinstance(v, str) else v) for k, v in body.model_dump(exclude_unset=True).items()}
    if fields.get("title") is None:
        fields.pop("title", None)
    for k in ("description", "must_have", "nice_to_have"):
        if k in fields and fields[k] is None:
            fields[k] = ""
    if fields:
        sets = ", ".join(f"{k} = :{k}" for k in fields)
        extra = (", closed_at = CASE WHEN :status = 'closed' THEN coalesce(closed_at, now()) ELSE NULL END"
                 if "status" in fields else "")
        r = await db.execute(text(f"UPDATE jobs SET {sets}{extra} WHERE id = :j AND venture_id = :v"),
                             {**fields, "j": job_id, "v": venture_id})
        if not r.rowcount:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "role not found")
    r = (await db.execute(text(f"{JOB_SQL} WHERE j.id = :j AND j.venture_id = :v"), {"j": job_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "role not found")
    return _job(r, await _forwarding(db, venture_id))


# --------------------------------------------------------------------------------------- candidates --
class CandidateOut(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    name: str
    email: str | None
    phone: str | None
    source: Literal["upload", "email"]
    file_name: str | None
    score: int | None
    verdict: Literal["shortlist", "maybe", "reject"] | None
    reasons: str | None
    status: Literal["new", "screened", "shortlisted", "invited", "rejected", "hired"]
    created_at: datetime


class CandidateDetail(CandidateOut):
    cv: str


class CandidatePatch(BaseModel):
    status: Literal["shortlisted", "rejected", "hired", "screened"]


CAND = ("id, job_id, name, email, phone, source, file_name, score, verdict, reasons, status, created_at")


@router.get("/ventures/{venture_id}/jobs/{job_id}/candidates", response_model=list[CandidateOut])
async def list_candidates(venture_id: uuid.UUID, job_id: uuid.UUID, db: TenantDB) -> list[CandidateOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text(
        f"SELECT {CAND} FROM candidates WHERE job_id = :j AND venture_id = :v"
        " ORDER BY score DESC NULLS FIRST, created_at DESC LIMIT 500"), {"j": job_id, "v": venture_id})).all()
    return [CandidateOut(**r._mapping) for r in rows]


@router.post("/ventures/{venture_id}/jobs/{job_id}/candidates", response_model=CandidateOut, status_code=201)
async def upload_cv(venture_id: uuid.UUID, job_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc,
                    file: UploadFile = File(...), name: str | None = Form(default=None, max_length=160),
                    email: str | None = Form(default=None, max_length=254)) -> CandidateOut:
    org = await _writer(db, venture_id)
    job = (await db.execute(text("SELECT id, status FROM jobs WHERE id = :j AND venture_id = :v"),
                            {"j": job_id, "v": venture_id})).first()
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "role not found")
    if job.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, "this role is closed")
    data, mime = await read_checked(file, "document", max_mb=10)
    if not (file.filename or "").lower().endswith((".pdf", ".docx")):
        raise HTTPException(415, "upload the CV as a PDF or Word (.docx) file")
    try:
        ex = await asyncio.to_thread(extract_text, data, file.filename or "cv.pdf", mime)
    except ExtractionError as exc:
        raise HTTPException(422, f"couldn't read this CV: {exc}") from None
    if len((ex.text or "").strip()) < 50:
        raise HTTPException(422, "no text could be read from this CV (a scanned image?); ask for a PDF or Word file")
    from kritvia_api.db.session import tenant_tx
    async with tenant_tx(user_id) as conn:      # committed before the screening run starts, so it sees the CV
        cid = await people.add_candidate(svc, conn, org_id=org, venture_id=venture_id, job_id=job_id,
                                         name=(name or "").strip() or "Applicant", email=email, phone=None,
                                         source="upload", cv_text=ex.text, file_name=file.filename)
        r = (await conn.execute(text(f"SELECT {CAND} FROM candidates WHERE id = :c"), {"c": cid})).first() if cid else None
    if cid is None or r is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this person already applied for this role")
    await people.screen(svc, actor_user_id=user_id, actor_type="user", venture_id=venture_id, candidate_id=cid,
                        name=r.name)
    return CandidateOut(**r._mapping)


@router.get("/ventures/{venture_id}/candidates/{candidate_id}", response_model=CandidateDetail)
async def candidate(venture_id: uuid.UUID, candidate_id: uuid.UUID, db: TenantDB, svc: Svc) -> CandidateDetail:
    await _admin(db, venture_id)
    r = (await db.execute(text(f"SELECT {CAND}, cv_enc FROM candidates WHERE id = :c AND venture_id = :v"),
                          {"c": candidate_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "candidate not found")
    cv = await EnvelopeCrypto(db, svc.keys).decrypt_str(venture_id, CV_PURPOSE, r.cv_enc) if r.cv_enc else ""
    fields = {k: v for k, v in r._mapping.items() if k != "cv_enc"}
    return CandidateDetail(**fields, cv=cv or "")


@router.patch("/ventures/{venture_id}/candidates/{candidate_id}", response_model=CandidateOut)
async def decide_candidate(venture_id: uuid.UUID, candidate_id: uuid.UUID, body: CandidatePatch,
                           db: TenantDB) -> CandidateOut:
    await _writer(db, venture_id)
    r = (await db.execute(text(f"UPDATE candidates SET status = :s, updated_at = now() WHERE id = :c AND venture_id = :v"
                               f" RETURNING {CAND}"), {"s": body.status, "c": candidate_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "candidate not found")
    return CandidateOut(**r._mapping)


# --------------------------------------------------------------------------------------------- staff --
class StaffIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=24, description="their WhatsApp number, for IN / OUT")
    role: str | None = Field(default=None, max_length=80)
    pay_kind: Literal["monthly", "daily"] = "monthly"
    pay_paise: int = Field(default=0, ge=0, le=10_000_000_000)
    starts_at: time = time(10, 0)


class StaffPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=24)
    role: str | None = Field(default=None, max_length=80)
    pay_kind: Literal["monthly", "daily"] | None = None
    pay_paise: int | None = Field(default=None, ge=0, le=10_000_000_000)
    starts_at: time | None = None
    active: bool | None = None


class StaffOut(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    role: str | None
    pay_kind: Literal["monthly", "daily"]
    pay_paise: int
    starts_at: time
    active: bool


def _phone(raw: str | None) -> str | None:
    try:
        return phone_digits(raw) if raw and raw.strip() else None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/ventures/{venture_id}/staff", response_model=list[StaffOut])
async def list_staff(venture_id: uuid.UUID, db: TenantDB) -> list[StaffOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT id, name, phone, role, pay_kind, pay_paise, starts_at, active FROM staff"
                                  " WHERE venture_id = :v ORDER BY active DESC, name"), {"v": venture_id})).all()
    return [StaffOut(**r._mapping) for r in rows]


@router.post("/ventures/{venture_id}/staff", response_model=StaffOut, status_code=201)
async def add_staff(venture_id: uuid.UUID, body: StaffIn, db: TenantDB) -> StaffOut:
    org = await _admin(db, venture_id)
    try:
        async with db.begin_nested():
            r = (await db.execute(text(
                "INSERT INTO staff (org_id, venture_id, name, phone, role, pay_kind, pay_paise, starts_at)"
                " VALUES (:o, :v, :n, :p, :r, :k, :pay, :s)"
                " RETURNING id, name, phone, role, pay_kind, pay_paise, starts_at, active"),
                {"o": org, "v": venture_id, "n": body.name.strip(), "p": _phone(body.phone),
                 "r": (body.role or "").strip() or None, "k": body.pay_kind, "pay": body.pay_paise,
                 "s": body.starts_at})).first()
    except IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, "someone on the team already has this number") from None
    return StaffOut(**r._mapping)


@router.patch("/ventures/{venture_id}/staff/{staff_id}", response_model=StaffOut)
async def edit_staff(venture_id: uuid.UUID, staff_id: uuid.UUID, body: StaffPatch, db: TenantDB) -> StaffOut:
    await _admin(db, venture_id)
    fields = body.model_dump(exclude_unset=True)
    if "phone" in fields:
        fields["phone"] = _phone(fields["phone"])
    for k in ("name", "pay_kind", "pay_paise", "starts_at", "active"):
        if k in fields and fields[k] is None:
            fields.pop(k)
    if not fields:
        raise HTTPException(422, "nothing to change")
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    try:
        async with db.begin_nested():
            r = (await db.execute(text(f"UPDATE staff SET {sets} WHERE id = :s AND venture_id = :v"
                                       " RETURNING id, name, phone, role, pay_kind, pay_paise, starts_at, active"),
                                  {**fields, "s": staff_id, "v": venture_id})).first()
    except IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, "someone on the team already has this number") from None
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    return StaffOut(**r._mapping)


# ---------------------------------------------------------------------------------------- attendance --
Status = Literal["present", "half_day", "absent", "leave"]


class DayRow(BaseModel):
    staff_id: uuid.UUID
    name: str
    in_at: datetime | None
    out_at: datetime | None
    status: Status | None = Field(description="None: nothing marked yet")
    late: bool
    source: Literal["whatsapp", "manual"] | None


class MarkIn(BaseModel):
    staff_id: uuid.UUID
    day: date
    status: Status
    note: str | None = Field(default=None, max_length=200)


@router.get("/ventures/{venture_id}/attendance", response_model=list[DayRow])
async def day_view(venture_id: uuid.UUID, db: TenantDB, day: date | None = None) -> list[DayRow]:
    await venture_org(db, venture_id)
    day = day or datetime.now(IST).date()
    rows = (await db.execute(text(
        "SELECT s.id AS staff_id, s.name, s.starts_at, a.in_at, a.out_at, a.status, a.source FROM staff s"
        " LEFT JOIN attendance a ON a.staff_id = s.id AND a.day = :d WHERE s.venture_id = :v AND s.active ORDER BY s.name"),
        {"v": venture_id, "d": day})).all()
    out = []
    for r in rows:
        late = bool(r.in_at and r.in_at.astimezone(IST).time()
                    > (datetime.combine(day, r.starts_at) + people.LATE_AFTER).time())
        out.append(DayRow(staff_id=r.staff_id, name=r.name, in_at=r.in_at, out_at=r.out_at, status=r.status,
                          late=late, source=r.source))
    return out


@router.put("/ventures/{venture_id}/attendance", response_model=DayRow)
async def mark(venture_id: uuid.UUID, body: MarkIn, db: TenantDB) -> DayRow:
    org = await _writer(db, venture_id)
    s = (await db.execute(text("SELECT id, name FROM staff WHERE id = :s AND venture_id = :v"),
                          {"s": body.staff_id, "v": venture_id})).first()
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    if body.day > datetime.now(IST).date() and body.status != "leave":
        raise HTTPException(422, "that day hasn't come yet (only leave can be marked ahead)")
    r = (await db.execute(text(
        "INSERT INTO attendance (org_id, venture_id, staff_id, day, status, source, note)"
        " VALUES (:o, :v, :s, :d, :st, 'manual', :n) ON CONFLICT (staff_id, day) DO UPDATE SET status = EXCLUDED.status,"
        " note = EXCLUDED.note RETURNING in_at, out_at, status, source"),
        {"o": org, "v": venture_id, "s": body.staff_id, "d": body.day, "st": body.status,
         "n": (body.note or "").strip() or None})).first()
    return DayRow(staff_id=s.id, name=s.name, in_at=r.in_at, out_at=r.out_at, status=r.status, late=False, source=r.source)


class SheetRow(BaseModel):
    staff_id: uuid.UUID
    name: str
    role: str | None
    pay_kind: Literal["monthly", "daily"]
    pay_paise: int
    present: int
    half_days: int
    leave: int
    absent: int
    late: int
    working_days: int
    pay_estimate_paise: int


def _month(month: str) -> tuple[int, int]:
    try:
        y, m = (int(x) for x in month.split("-"))
        assert 2020 <= y <= 2100 and 1 <= m <= 12
        return y, m
    except (ValueError, AssertionError):
        raise HTTPException(422, "month must look like 2026-10") from None


@router.get("/ventures/{venture_id}/attendance/sheet", response_model=list[SheetRow])
async def sheet(venture_id: uuid.UUID, db: TenantDB, month: str = Query(pattern=r"^\d{4}-\d{2}$")) -> list[SheetRow]:
    await venture_org(db, venture_id)
    y, m = _month(month)
    return [SheetRow(**r.__dict__) for r in await people.month_sheet(db, venture_id, y, m)]


@router.get("/ventures/{venture_id}/attendance/sheet/file")
async def sheet_file(venture_id: uuid.UUID, db: TenantDB, month: str = Query(pattern=r"^\d{4}-\d{2}$")) -> Response:
    from kritvia_api.services.xlsx import workbook
    await _admin(db, venture_id)
    y, m = _month(month)
    rows = await people.month_sheet(db, venture_id, y, m)
    data = workbook([(f"Attendance {month}", [
        ["Name", "Role", "Present", "Half days", "Leave", "Absent", "Late", "Working days", "Pay basis", "Pay (₹)",
         "Estimate (₹)"],
        *[[r.name, r.role or "", r.present, r.half_days, r.leave, r.absent, r.late, r.working_days,
           "per month" if r.pay_kind == "monthly" else "per day", r.pay_paise / 100, r.pay_estimate_paise / 100]
          for r in rows]])])
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="attendance-{month}.xlsx"'})
