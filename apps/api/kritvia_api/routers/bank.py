"""Bank statements: upload one, and let Kritvia match its credits to invoices and its debits to bills.

  POST /ventures/{v}/bank/statements          upload a CSV, Excel or PDF statement; lines already seen are skipped
  GET  /ventures/{v}/bank/statements          what was uploaded
  DELETE /ventures/{v}/bank/statements/{id}   remove one (admins); payments it confirmed stay recorded
  GET  /ventures/{v}/bank/lines?state=        lines, with what each one was matched to
  POST /ventures/{v}/bank/lines/{id}/confirm  record the payment (optionally choosing another invoice or bill)
  POST /ventures/{v}/bank/lines/{id}/ignore   not a customer or supplier payment (salary, transfer, fees)
  POST /ventures/{v}/bank/lines/{id}/reset    undo an ignore
  POST /ventures/{v}/bank/confirm-sure        confirm every 'sure' match in one go
  POST /ventures/{v}/bank/rematch             match again (after adding invoices or bills)

Statements also arrive by email (services/pollers.py): forwarded to the business's Kritvia address or read from
its Gmail. One whose sender Kritvia couldn't check (forwarded mail) is marked unverified, and its lines are only
ever 'likely' matches, so each is confirmed one by one and never in the one-tap 'confirm all sure'.

The statement file isn't kept; only its lines are. Matching is code (services/bank.py), never a model.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.services import bank
from kritvia_api.services.textextract import ExtractionError, extract_text
from kritvia_api.services.uploads import read_checked

router = APIRouter(tags=["bank"])


async def can_write(db, venture_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can see the money pages but not change them")


class StatementOut(BaseModel):
    id: uuid.UUID
    account_label: str | None
    file_name: str | None
    period_from: date | None
    period_to: date | None
    lines: int
    credits_paise: int
    debits_paise: int
    source: Literal["upload", "email"] = "upload"
    sender: str | None = None
    verified: bool = True
    created_at: datetime


class UploadOut(BaseModel):
    statement: StatementOut
    new_lines: int
    already_seen: int
    sure: int = Field(description="lines matched with confidence: one tap confirms them all")
    likely: int


class MatchOut(BaseModel):
    kind: Literal["invoice", "bill"]
    id: uuid.UUID
    party: str
    number: str
    balance_paise: int
    confidence: Literal["sure", "likely"] | None


class LineOut(BaseModel):
    id: uuid.UUID
    line_date: date
    narration: str
    reference: str | None
    amount_paise: int = Field(description="credit > 0, debit < 0")
    state: Literal["unmatched", "suggested", "confirmed", "ignored"]
    match: MatchOut | None
    unverified: bool = Field(default=False, description="from an emailed statement whose sender couldn't be checked: "
                                                        "compare it with your bank before confirming")


class LinesOut(BaseModel):
    lines: list[LineOut]
    counts: dict[str, int]
    sure: int


async def rematch(db, venture_id: uuid.UUID) -> tuple[int, int]:
    """Suggests a match for every line nobody has decided yet. Returns (sure, likely)."""
    inv = (await db.execute(text(
        "SELECT id, customer_name, number, amount_paise - paid_paise AS bal, customer_paid_ref FROM invoices"
        " WHERE venture_id = :v AND status = 'open' AND amount_paise > paid_paise"), {"v": venture_id})).all()
    bills = (await db.execute(text(
        "SELECT id, vendor, number, amount_paise - paid_paise AS bal FROM bills"
        " WHERE venture_id = :v AND status = 'open' AND amount_paise > paid_paise"), {"v": venture_id})).all()
    lines = (await db.execute(text(
        "SELECT l.id, l.amount_paise, l.narration, coalesce(l.reference, '') AS ref, s.verified FROM bank_lines l"
        " JOIN bank_statements s ON s.id = l.statement_id"
        " WHERE l.venture_id = :v AND l.state IN ('unmatched', 'suggested') ORDER BY l.line_date, l.created_at"),
        {"v": venture_id})).all()
    found = bank.match(
        [(str(x.id), x.amount_paise, f"{x.narration} {x.ref}") for x in lines],
        [bank.Open(str(i.id), i.customer_name, i.number or "", i.bal, i.customer_paid_ref) for i in inv],
        [bank.Open(str(b.id), b.vendor, b.number or "", b.bal) for b in bills])
    sure = likely = 0
    for x in lines:
        m = found.get(str(x.id))
        if m:
            kind, mt = m
            if not x.verified and mt.confidence == "sure":   # an emailed statement nobody could vouch for
                mt = bank.Match(mt.id, "likely")
            sure += mt.confidence == "sure"
            likely += mt.confidence == "likely"
            await db.execute(text(
                "UPDATE bank_lines SET state = 'suggested', match_kind = :k, match_id = :m, confidence = :c"
                " WHERE id = :id"), {"k": kind, "m": uuid.UUID(mt.id), "c": mt.confidence, "id": x.id})
        else:
            await db.execute(text(
                "UPDATE bank_lines SET state = 'unmatched', match_kind = NULL, match_id = NULL, confidence = NULL"
                " WHERE id = :id AND state = 'suggested'"), {"id": x.id})
    return sure, likely


def _statement(r) -> StatementOut:
    return StatementOut(**r._mapping)


class ImportProblem(Exception):
    """The file isn't a statement Kritvia can read (the message says why, for a person)."""


async def statement_password(db, crypto, venture_id: uuid.UUID) -> str | None:
    enc = (await db.execute(text("SELECT statement_password_enc FROM cash_settings WHERE venture_id = :v"),
                            {"v": venture_id})).scalar()
    return (await crypto.decrypt_str(venture_id, "cash.statement_password", enc)) if enc else None


async def import_statement(db, *, org: uuid.UUID, venture_id: uuid.UUID, data: bytes, filename: str, mime: str,
                           account_label: str | None, uploaded_by: uuid.UUID | None, password: str | None = None,
                           source: str = "upload", sender: str | None = None, verified: bool = True) -> UploadOut:
    """Reads a statement file into bank lines (lines already seen are skipped) and matches them."""
    pdf_text = None
    if mime == "application/pdf":
        if bank.pdf_encrypted(data):
            if not password:
                raise ImportProblem("this PDF is password-protected: save the statement password on Money → Bank, "
                                    "or download the statement as CSV or Excel from netbanking")
            try:
                pdf_text = await asyncio.to_thread(bank.pdf_text, data, password)
            except bank.StatementError as exc:
                raise ImportProblem(str(exc)) from None
        else:
            try:
                ex = await asyncio.to_thread(extract_text, data, filename or "statement.pdf", mime)
            except ExtractionError as exc:
                raise ImportProblem(f"couldn't read this PDF: {exc}") from None
            pdf_text = ex.text
    try:
        st = await asyncio.to_thread(bank.read, data, filename or "statement.csv", pdf_text)
    except bank.StatementError as exc:
        raise ImportProblem(str(exc)) from None
    first, last = st.period
    sid = (await db.execute(text(
        "INSERT INTO bank_statements (org_id, venture_id, account_label, file_name, period_from, period_to, lines,"
        " credits_paise, debits_paise, uploaded_by, source, sender, verified)"
        " VALUES (:o, :v, :a, :f, :p1, :p2, :n, :c, :d, :u, :src, :snd, :ok) RETURNING id"),
        {"o": org, "v": venture_id, "a": (account_label or "").strip()[:80] or None,
         "f": (filename or "")[:200] or None, "p1": first, "p2": last, "n": len(st.lines), "c": st.credits,
         "d": st.debits, "u": uploaded_by, "src": source, "snd": (sender or "")[:254] or None,
         "ok": verified})).scalar_one()
    new = 0
    for ln in st.lines:
        r = await db.execute(text(
            "INSERT INTO bank_lines (org_id, venture_id, statement_id, line_date, narration, reference, amount_paise,"
            " balance_paise, fingerprint) VALUES (:o, :v, :s, :d, :n, :r, :a, :b, :f)"
            " ON CONFLICT (venture_id, fingerprint) DO NOTHING"),
            {"o": org, "v": venture_id, "s": sid, "d": ln.day, "n": ln.narration, "r": ln.reference,
             "a": ln.amount_paise, "b": ln.balance_paise, "f": ln.fingerprint})
        new += r.rowcount or 0
    sure, likely = await rematch(db, venture_id)
    row = (await db.execute(text("SELECT * FROM bank_statements WHERE id = :s"), {"s": sid})).first()
    return UploadOut(statement=_statement(row), new_lines=new, already_seen=len(st.lines) - new, sure=sure,
                     likely=likely)


@router.post("/ventures/{venture_id}/bank/statements", response_model=UploadOut, status_code=201)
async def upload_statement(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc,
                           file: UploadFile = File(...),
                           account_label: str | None = Form(default=None, max_length=80)) -> UploadOut:
    from kritvia_api.services.crypto import EnvelopeCrypto
    org = await venture_org(db, venture_id)
    await can_write(db, venture_id)
    data, mime = await read_checked(file, "statement", max_mb=15)
    password = await statement_password(db, EnvelopeCrypto(db, svc.keys), venture_id) \
        if mime == "application/pdf" and bank.pdf_encrypted(data) else None
    try:
        return await import_statement(db, org=org, venture_id=venture_id, data=data, filename=file.filename or "",
                                      mime=mime, account_label=account_label, uploaded_by=user_id, password=password)
    except ImportProblem as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/ventures/{venture_id}/bank/statements", response_model=list[StatementOut])
async def list_statements(venture_id: uuid.UUID, db: TenantDB) -> list[StatementOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT * FROM bank_statements WHERE venture_id = :v ORDER BY created_at DESC"
                                  " LIMIT 100"), {"v": venture_id})).all()
    return [_statement(r) for r in rows]


@router.delete("/ventures/{venture_id}/bank/statements/{statement_id}", status_code=204)
async def delete_statement(venture_id: uuid.UUID, statement_id: uuid.UUID, db: TenantDB) -> None:
    await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can remove a statement")
    r = await db.execute(text("DELETE FROM bank_statements WHERE id = :s AND venture_id = :v"),
                         {"s": statement_id, "v": venture_id})
    if not r.rowcount:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "statement not found")


LINE_SQL = (
    "SELECT l.id, l.line_date, l.narration, l.reference, l.amount_paise, l.state, l.match_kind, l.match_id,"
    " l.confidence, coalesce(i.customer_name, b.vendor) AS party, coalesce(i.number, b.number, '') AS number,"
    " coalesce(i.amount_paise - i.paid_paise, b.amount_paise - b.paid_paise, 0) AS balance,"
    " NOT st.verified AS unverified"
    " FROM bank_lines l JOIN bank_statements st ON st.id = l.statement_id"
    " LEFT JOIN invoices i ON l.match_kind = 'invoice' AND i.id = l.match_id"
    " LEFT JOIN bills b ON l.match_kind = 'bill' AND b.id = l.match_id")


def _line(r) -> LineOut:
    m = None
    if r.match_kind and r.party is not None:
        m = MatchOut(kind=r.match_kind, id=r.match_id, party=r.party, number=r.number, balance_paise=r.balance,
                     confidence=r.confidence)
    return LineOut(id=r.id, line_date=r.line_date, narration=r.narration, reference=r.reference,
                   amount_paise=r.amount_paise, state=r.state, match=m, unverified=bool(r.unverified))


@router.get("/ventures/{venture_id}/bank/lines", response_model=LinesOut)
async def list_lines(venture_id: uuid.UUID, db: TenantDB,
                     state: Literal["unmatched", "suggested", "confirmed", "ignored", "all"] = "suggested",
                     limit: int = Query(default=200, ge=1, le=1000)) -> LinesOut:
    await venture_org(db, venture_id)
    where = "" if state == "all" else " AND l.state = :s"
    rows = (await db.execute(text(f"{LINE_SQL} WHERE l.venture_id = :v{where}"
                                  " ORDER BY l.line_date DESC, l.created_at DESC LIMIT :n"),
                             {"v": venture_id, "s": state, "n": limit})).all()
    counts = {r.state: r.n for r in (await db.execute(text(
        "SELECT state, count(*) AS n FROM bank_lines WHERE venture_id = :v GROUP BY state"), {"v": venture_id})).all()}
    sure = (await db.execute(text("SELECT count(*) FROM bank_lines WHERE venture_id = :v AND state = 'suggested'"
                                  " AND confidence = 'sure'"), {"v": venture_id})).scalar()
    return LinesOut(lines=[_line(r) for r in rows], counts=counts, sure=int(sure or 0))


class ConfirmIn(BaseModel):
    match_kind: Literal["invoice", "bill"] | None = Field(default=None, description="to choose another match")
    match_id: uuid.UUID | None = None


async def _get_line(db, venture_id: uuid.UUID, line_id: uuid.UUID):
    r = (await db.execute(text("SELECT * FROM bank_lines WHERE id = :id AND venture_id = :v FOR UPDATE"),
                          {"id": line_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "line not found")
    return r


async def record(db, venture_id: uuid.UUID, line, kind: str, target: uuid.UUID, user_id: uuid.UUID) -> None:
    """Records the payment a bank line shows, against an invoice (credit) or a bill (debit)."""
    if line.state == "confirmed":
        raise HTTPException(status.HTTP_409_CONFLICT, "this line is already recorded")
    if (kind == "invoice") != (line.amount_paise > 0):
        raise HTTPException(422, "a credit pays an invoice; a debit pays a bill")
    amount = abs(line.amount_paise)
    ref = (line.reference or line.narration)[:80]
    if kind == "invoice":
        inv = (await db.execute(text("SELECT amount_paise - paid_paise AS bal, status FROM invoices"
                                     " WHERE id = :i AND venture_id = :v FOR UPDATE"),
                                {"i": target, "v": venture_id})).first()
        if inv is None or inv.status != "open" or inv.bal <= 0:
            raise HTTPException(status.HTTP_409_CONFLICT, "that invoice isn't open any more")
        paid = min(amount, inv.bal)
        await db.execute(text(
            "UPDATE invoices SET paid_paise = paid_paise + :a, status = CASE WHEN paid_paise + :a >= amount_paise"
            " THEN 'paid' ELSE status END, paid_on = :d, customer_says_paid_at = NULL, updated_at = now()"
            " WHERE id = :i"), {"a": paid, "d": line.line_date, "i": target})
        await db.execute(text(
            "INSERT INTO invoice_payments (org_id, venture_id, invoice_id, amount_paise, paid_on, method, reference,"
            " recorded_by, bank_line_id) VALUES (:o, :v, :i, :a, :d, 'bank', :r, :u, :l)"),
            {"o": line.org_id, "v": venture_id, "i": target, "a": paid, "d": line.line_date, "r": ref, "u": user_id,
             "l": line.id})
    else:
        b = (await db.execute(text("SELECT amount_paise - paid_paise AS bal, status FROM bills"
                                   " WHERE id = :i AND venture_id = :v FOR UPDATE"),
                              {"i": target, "v": venture_id})).first()
        if b is None or b.status != "open" or b.bal <= 0:
            raise HTTPException(status.HTTP_409_CONFLICT, "that bill isn't open any more")
        paid = min(amount, b.bal)
        await db.execute(text(
            "UPDATE bills SET paid_paise = paid_paise + :a, status = CASE WHEN paid_paise + :a >= amount_paise"
            " THEN 'paid' ELSE status END, paid_on = :d, paid_ref = :r, bank_line_id = :l, updated_at = now()"
            " WHERE id = :i"), {"a": paid, "d": line.line_date, "r": ref, "l": line.id, "i": target})
    await db.execute(text(
        "UPDATE bank_lines SET state = 'confirmed', match_kind = :k, match_id = :m, decided_by = :u, decided_at = now()"
        " WHERE id = :id"), {"k": kind, "m": target, "u": user_id, "id": line.id})


@router.post("/ventures/{venture_id}/bank/lines/{line_id}/confirm", response_model=LineOut)
async def confirm_line(venture_id: uuid.UUID, line_id: uuid.UUID, body: ConfirmIn, user_id: UserId,
                       db: TenantDB) -> LineOut:
    await venture_org(db, venture_id)
    await can_write(db, venture_id)
    line = await _get_line(db, venture_id, line_id)
    kind, target = (body.match_kind, body.match_id) if body.match_id else (line.match_kind, line.match_id)
    if not kind or not target:
        raise HTTPException(422, "choose the invoice or bill this line pays")
    await record(db, venture_id, line, kind, target, user_id)
    await rematch(db, venture_id)
    return _line((await db.execute(text(f"{LINE_SQL} WHERE l.id = :id"), {"id": line_id})).first())


@router.post("/ventures/{venture_id}/bank/lines/{line_id}/ignore", response_model=LineOut)
async def ignore_line(venture_id: uuid.UUID, line_id: uuid.UUID, user_id: UserId, db: TenantDB) -> LineOut:
    await venture_org(db, venture_id)
    await can_write(db, venture_id)
    line = await _get_line(db, venture_id, line_id)
    if line.state == "confirmed":
        raise HTTPException(status.HTTP_409_CONFLICT, "this line is already recorded")
    await db.execute(text("UPDATE bank_lines SET state = 'ignored', match_kind = NULL, match_id = NULL,"
                          " confidence = NULL, decided_by = :u, decided_at = now() WHERE id = :id"),
                     {"u": user_id, "id": line_id})
    await rematch(db, venture_id)
    return _line((await db.execute(text(f"{LINE_SQL} WHERE l.id = :id"), {"id": line_id})).first())


@router.post("/ventures/{venture_id}/bank/lines/{line_id}/reset", response_model=LineOut)
async def reset_line(venture_id: uuid.UUID, line_id: uuid.UUID, db: TenantDB) -> LineOut:
    await venture_org(db, venture_id)
    await can_write(db, venture_id)
    line = await _get_line(db, venture_id, line_id)
    if line.state != "ignored":
        raise HTTPException(status.HTTP_409_CONFLICT, "only an ignored line can be brought back")
    await db.execute(text("UPDATE bank_lines SET state = 'unmatched', decided_by = NULL, decided_at = NULL"
                          " WHERE id = :id"), {"id": line_id})
    await rematch(db, venture_id)
    return _line((await db.execute(text(f"{LINE_SQL} WHERE l.id = :id"), {"id": line_id})).first())


class ConfirmSureOut(BaseModel):
    confirmed: int
    paid_invoices: int
    paid_bills: int


@router.post("/ventures/{venture_id}/bank/confirm-sure", response_model=ConfirmSureOut)
async def confirm_sure(venture_id: uuid.UUID, user_id: UserId, db: TenantDB) -> ConfirmSureOut:
    await venture_org(db, venture_id)
    await can_write(db, venture_id)
    ids = (await db.execute(text("SELECT id FROM bank_lines WHERE venture_id = :v AND state = 'suggested'"
                                 " AND confidence = 'sure' ORDER BY line_date"), {"v": venture_id})).scalars().all()
    n = inv = bl = 0
    for lid in ids:
        line = await _get_line(db, venture_id, lid)
        if line.state != "suggested" or line.confidence != "sure":
            continue
        try:
            await record(db, venture_id, line, line.match_kind, line.match_id, user_id)
        except HTTPException:
            continue
        n += 1
        inv += line.match_kind == "invoice"
        bl += line.match_kind == "bill"
    await rematch(db, venture_id)
    return ConfirmSureOut(confirmed=n, paid_invoices=inv, paid_bills=bl)


class RematchOut(BaseModel):
    sure: int
    likely: int


@router.post("/ventures/{venture_id}/bank/rematch", response_model=RematchOut)
async def rematch_lines(venture_id: uuid.UUID, db: TenantDB) -> RematchOut:
    await venture_org(db, venture_id)
    await can_write(db, venture_id)
    sure, likely = await rematch(db, venture_id)
    return RematchOut(sure=sure, likely=likely)
