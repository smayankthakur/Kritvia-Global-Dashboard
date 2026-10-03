"""Knowledge base: documents, cited Q&A, facts (decisions/tasks), entities,
in-app voice input and meeting recordings."""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.services import memory
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.model_router import QuotaExceeded, RouterError
from kritvia_api.services.textextract import ExtractionError

router = APIRouter(tags=["knowledge"])

DocKind = Literal["upload", "note", "proposal", "report", "drive", "email"]
ROLE_NAMES = {"venture_admin", "operator", "approver", "viewer", "kitchen_manager", "loan_officer"}


async def read_upload(file: UploadFile) -> bytes:
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"file larger than {limit // 1048576} MB")
    if not data:
        raise HTTPException(422, "empty file")
    return data


async def _actor(user_id: uuid.UUID, venture_id: uuid.UUID, svc) -> memory.UserActor:
    async with tenant_tx(user_id) as conn:
        org = await venture_org(conn, venture_id)
        can_write = (await conn.execute(text("SELECT :v = ANY (private.writable_ventures())"),
                                        {"v": venture_id})).scalar()
    return memory.UserActor(user_id, org, venture_id, svc.router, svc.keys), bool(can_write)


class DocumentOut(BaseModel):
    id: uuid.UUID
    title: str
    kind: str
    mime: str | None
    size_bytes: int
    status: str
    sensitive: bool
    pii_tags: list[str]
    access_roles: list[str] | None
    meta: dict[str, Any]
    error: str | None
    source_uri: str | None
    delete_after: datetime | None
    created_at: datetime
    facts: int = 0


class IngestOut(BaseModel):
    document_id: uuid.UUID
    duplicate: bool
    chunks: int
    sensitive: bool
    pii_tags: list[str]
    embedded: bool
    entities: int
    facts: int
    warnings: list[str]


def _ingest_out(r: memory.IngestResult) -> IngestOut:
    return IngestOut(document_id=r.document_id, duplicate=r.duplicate, chunks=r.chunks, sensitive=r.sensitive,
                     pii_tags=r.pii_tags, embedded=r.embedded, entities=r.entities, facts=r.facts,
                     warnings=r.warnings)


@router.post("/ventures/{venture_id}/documents", response_model=IngestOut, status_code=201)
async def upload_document(venture_id: uuid.UUID, user_id: UserId, svc: Svc, file: UploadFile = File(...),
                          title: str | None = Form(default=None), kind: DocKind = Form(default="upload"),
                          restricted_to: str | None = Form(default=None, description="comma-separated roles"),
                          sensitive: bool = Form(default=False), extract: bool = Form(default=True)) -> IngestOut:
    actor, can_write = await _actor(user_id, venture_id, svc)
    if not can_write:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    roles = sorted({r.strip() for r in (restricted_to or "").split(",") if r.strip()}) or None
    if roles and not set(roles) <= ROLE_NAMES:
        raise HTTPException(422, "unknown role in restricted_to")
    data = await read_upload(file)
    try:
        res = await memory.ingest(actor, title=title or file.filename or "document", kind=kind, data=data,
                                  filename=file.filename or "document", mime=file.content_type, access_roles=roles,
                                  sensitive=sensitive or bool(roles), created_by=user_id, extract_knowledge=extract,
                                  extraction_focus="proposal" if kind == "proposal" else "general")
    except ExtractionError as exc:
        raise HTTPException(422, str(exc)) from None
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return _ingest_out(res)


class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=200_000)
    kind: Literal["note", "proposal"] = "note"


@router.post("/ventures/{venture_id}/notes", response_model=IngestOut, status_code=201)
async def add_note(venture_id: uuid.UUID, body: NoteIn, user_id: UserId, svc: Svc) -> IngestOut:
    actor, can_write = await _actor(user_id, venture_id, svc)
    if not can_write:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    try:
        res = await memory.ingest(actor, title=body.title, kind=body.kind, text_override=body.text,
                                  created_by=user_id, extraction_focus="proposal" if body.kind == "proposal" else "general")
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return _ingest_out(res)


DOC_COLS = ("d.id, d.title, d.kind, d.mime, d.size_bytes, d.status, d.sensitive, d.pii_tags, d.access_roles, d.meta,"
            " d.error, d.source_uri, d.delete_after, d.created_at,"
            " (SELECT count(*) FROM facts f JOIN chunks c ON c.id = f.source_chunk_id WHERE c.document_id = d.id)"
            " AS facts")


@router.get("/ventures/{venture_id}/documents", response_model=list[DocumentOut])
async def list_documents(venture_id: uuid.UUID, db: TenantDB, kind: str | None = None,
                         limit: int = 100) -> list[DocumentOut]:
    q = f"SELECT {DOC_COLS} FROM documents d WHERE d.venture_id = :v"
    params: dict[str, Any] = {"v": venture_id, "l": min(max(limit, 1), 500)}
    if kind:
        q += " AND d.kind = :k"
        params["k"] = kind
    rows = (await db.execute(text(q + " ORDER BY d.created_at DESC LIMIT :l"), params)).all()
    return [DocumentOut(**r._mapping) for r in rows]


class ChunkOut(BaseModel):
    id: uuid.UUID
    ord: int
    text: str
    page: int | None
    start_s: float | None
    end_s: float | None
    speaker: str | None


class DocumentDetailOut(DocumentOut):
    chunks: list[ChunkOut]


@router.get("/ventures/{venture_id}/documents/{document_id}", response_model=DocumentDetailOut)
async def get_document(venture_id: uuid.UUID, document_id: uuid.UUID, db: TenantDB, svc: Svc,
                       chunk_id: uuid.UUID | None = None) -> DocumentDetailOut:
    r = (await db.execute(text(f"SELECT {DOC_COLS} FROM documents d WHERE d.venture_id = :v AND d.id = :id"),
                          {"v": venture_id, "id": document_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    crypto = EnvelopeCrypto(db, svc.keys)
    rows = (await db.execute(text("SELECT id, ord, text_enc, page, start_s, end_s, speaker FROM chunks"
                                  " WHERE document_id = :d ORDER BY ord LIMIT 400"), {"d": document_id})).all()
    chunks = [ChunkOut(id=c.id, ord=c.ord, page=c.page, start_s=c.start_s, end_s=c.end_s, speaker=c.speaker,
                       text=(await crypto.decrypt(venture_id, memory.TEXT_PURPOSE, c.text_enc)).decode())
              for c in rows]
    org = await venture_org(db, venture_id)
    await db.execute(text("SELECT audit_event(:o, :v, 'document.viewed', 'documents', :id, CAST(:d AS jsonb))"),
                     {"o": org, "v": venture_id, "id": str(document_id),
                      "d": json.dumps({"sensitive": r.sensitive, "chunk": str(chunk_id) if chunk_id else None})})
    return DocumentDetailOut(**r._mapping, chunks=chunks)


@router.get("/ventures/{venture_id}/documents/{document_id}/raw")
async def download_raw(venture_id: uuid.UUID, document_id: uuid.UUID, db: TenantDB, svc: Svc) -> Response:
    """Original file. Every download is written to the audit log."""
    r = (await db.execute(text("SELECT org_id, title, mime, raw_enc, sensitive, meta FROM documents"
                               " WHERE venture_id = :v AND id = :id"), {"v": venture_id, "id": document_id})).first()
    if r is None or r.raw_enc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    data = await EnvelopeCrypto(db, svc.keys).decrypt(venture_id, memory.RAW_PURPOSE, r.raw_enc)
    await db.execute(text("SELECT audit_event(:o, :v, 'document.downloaded', 'documents', :id, CAST(:d AS jsonb))"),
                     {"o": r.org_id, "v": venture_id, "id": str(document_id),
                      "d": json.dumps({"sensitive": r.sensitive, "bytes": len(data)})})
    filename = (r.meta or {}).get("filename") or r.title
    safe = "".join(ch for ch in filename if ch.isalnum() or ch in "._- ")[:120] or "document"
    return Response(content=data, media_type=r.mime or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{safe}"',
                             "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.delete("/ventures/{venture_id}/documents/{document_id}", status_code=204)
async def delete_document(venture_id: uuid.UUID, document_id: uuid.UUID, db: TenantDB) -> None:
    try:
        async with db.begin_nested():
            res = await db.execute(text("DELETE FROM documents WHERE venture_id = :v AND id = :id"),
                                   {"v": venture_id, "id": document_id})
    except DBAPIError as exc:
        raise_for_db(exc, "document not found")
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")


# ---------------------------------------------------------------- Q&A --
class AskIn(BaseModel):
    question: str = Field(min_length=3, max_length=2000)


class Citation(BaseModel):
    n: int
    chunk_id: uuid.UUID
    document_id: uuid.UUID
    venture_id: uuid.UUID
    title: str
    kind: str
    excerpt: str
    score: float
    page: int | None
    start_s: float | None
    source_uri: str | None


class AnswerOut(BaseModel):
    answer: str
    citations: list[Citation]
    supported: bool
    tier: str


@router.post("/ventures/{venture_id}/ask", response_model=AnswerOut)
async def ask(venture_id: uuid.UUID, body: AskIn, user_id: UserId, svc: Svc) -> AnswerOut:
    actor, _ = await _actor(user_id, venture_id, svc)
    try:
        a = await memory.ask(actor, body.question)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    except RouterError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"model unavailable: {exc}") from None
    return AnswerOut(answer=a.answer, citations=[Citation(**c) for c in a.citations], supported=a.supported, tier=a.tier)


@router.post("/orgs/{org_id}/ask", response_model=AnswerOut)
async def ask_org(org_id: uuid.UUID, body: AskIn, user_id: UserId, svc: Svc) -> AnswerOut:
    """Executive question across every venture of the org the caller can read (RLS decides which)."""
    async with tenant_tx(user_id) as conn:
        ventures = [r.id for r in (await conn.execute(text("SELECT id FROM ventures WHERE org_id = :o ORDER BY name"),
                                                      {"o": org_id})).all()]
    if not ventures:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    actor = memory.UserActor(user_id, org_id, ventures[0], svc.router, svc.keys)
    try:
        a = await memory.ask(actor, body.question, venture_ids=ventures)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    except RouterError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"model unavailable: {exc}") from None
    return AnswerOut(answer=a.answer, citations=[Citation(**c) for c in a.citations], supported=a.supported, tier=a.tier)


# ------------------------------------------------------- facts & entities --
class FactOut(BaseModel):
    id: uuid.UUID
    kind: str
    statement: str
    owner: str | None
    due_date: date | None
    status: str | None
    confidence: float | None
    subject: str | None
    document_id: uuid.UUID
    document_title: str
    chunk_id: uuid.UUID
    source_start_s: float | None
    created_at: datetime


FACT_SQL = ("SELECT f.id, f.venture_id, f.kind, f.statement_enc, f.owner, f.due_date, f.status, f.confidence,"
            " e.name AS subject, c.document_id, d.title AS document_title, f.source_chunk_id AS chunk_id,"
            " f.source_start_s, f.created_at FROM facts f JOIN chunks c ON c.id = f.source_chunk_id"
            " JOIN documents d ON d.id = c.document_id LEFT JOIN entities e ON e.id = f.subject_id")


async def _facts(db, svc, rows) -> list[FactOut]:
    crypto = EnvelopeCrypto(db, svc.keys)
    out = []
    for r in rows:
        stmt = (await crypto.decrypt(r.venture_id, memory.FACT_PURPOSE, r.statement_enc)).decode()
        out.append(FactOut(**{k: v for k, v in r._mapping.items() if k not in ("statement_enc", "venture_id")},
                           statement=stmt))
    return out


@router.get("/ventures/{venture_id}/facts", response_model=list[FactOut])
async def list_facts(venture_id: uuid.UUID, db: TenantDB, svc: Svc,
                     kind: Literal["fact", "decision", "task", "commitment"] | None = None,
                     status_: Literal["open", "done", "dropped"] | None = Query(default=None, alias="status"),
                     document_id: uuid.UUID | None = None, limit: int = 200) -> list[FactOut]:
    q, params = FACT_SQL + " WHERE f.venture_id = :v", {"v": venture_id, "l": min(max(limit, 1), 500)}
    if kind:
        q += " AND f.kind = :k"
        params["k"] = kind
    if status_:
        q += " AND f.status = :s"
        params["s"] = status_
    if document_id:
        q += " AND c.document_id = :d"
        params["d"] = document_id
    rows = (await db.execute(text(q + " ORDER BY f.due_date NULLS LAST, f.created_at DESC LIMIT :l"), params)).all()
    return await _facts(db, svc, rows)


class FactPatch(BaseModel):
    status: Literal["open", "done", "dropped"]


@router.patch("/ventures/{venture_id}/facts/{fact_id}", response_model=FactOut)
async def update_fact(venture_id: uuid.UUID, fact_id: uuid.UUID, body: FactPatch, db: TenantDB, svc: Svc) -> FactOut:
    try:
        async with db.begin_nested():
            res = await db.execute(text("UPDATE facts SET status = :s WHERE venture_id = :v AND id = :id"
                                        " AND kind IN ('task', 'commitment')"),
                                   {"s": body.status, "v": venture_id, "id": fact_id})
    except DBAPIError as exc:
        raise_for_db(exc, "fact not found")
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    rows = (await db.execute(text(FACT_SQL + " WHERE f.id = :id"), {"id": fact_id})).all()
    return (await _facts(db, svc, rows))[0]


class EntityOut(BaseModel):
    id: uuid.UUID
    type: str
    name: str
    facts: int
    edges: int


@router.get("/ventures/{venture_id}/entities", response_model=list[EntityOut])
async def list_entities(venture_id: uuid.UUID, db: TenantDB, q: str | None = None,
                        type_: str | None = Query(default=None, alias="type"), limit: int = 200) -> list[EntityOut]:
    sql = ("SELECT e.id, e.type, e.name, (SELECT count(*) FROM facts f WHERE f.subject_id = e.id) AS facts,"
           " (SELECT count(*) FROM edges x WHERE x.src_id = e.id OR x.dst_id = e.id) AS edges"
           " FROM entities e WHERE e.venture_id = :v")
    params: dict[str, Any] = {"v": venture_id, "l": min(max(limit, 1), 500)}
    if q:
        sql += " AND e.canonical LIKE :q"
        params["q"] = f"%{memory.canonical(q)}%"
    if type_:
        sql += " AND e.type = :t"
        params["t"] = type_
    rows = (await db.execute(text(sql + " ORDER BY facts DESC, e.name LIMIT :l"), params)).all()
    return [EntityOut(**r._mapping) for r in rows]


class EdgeOut(BaseModel):
    type: str
    direction: Literal["out", "in"]
    other_id: uuid.UUID
    other_name: str
    other_type: str
    chunk_id: uuid.UUID
    document_id: uuid.UUID


class EntityDetailOut(BaseModel):
    id: uuid.UUID
    type: str
    name: str
    edges: list[EdgeOut]
    facts: list[FactOut]


@router.get("/ventures/{venture_id}/entities/{entity_id}", response_model=EntityDetailOut)
async def get_entity(venture_id: uuid.UUID, entity_id: uuid.UUID, db: TenantDB, svc: Svc) -> EntityDetailOut:
    e = (await db.execute(text("SELECT id, type, name FROM entities WHERE venture_id = :v AND id = :id"),
                          {"v": venture_id, "id": entity_id})).first()
    if e is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "entity not found")
    edges = (await db.execute(text(
        "SELECT x.type, CASE WHEN x.src_id = :id THEN 'out' ELSE 'in' END AS direction, o.id AS other_id,"
        " o.name AS other_name, o.type AS other_type, x.source_chunk_id AS chunk_id, c.document_id"
        " FROM edges x JOIN entities o ON o.id = CASE WHEN x.src_id = :id THEN x.dst_id ELSE x.src_id END"
        " JOIN chunks c ON c.id = x.source_chunk_id WHERE x.src_id = :id OR x.dst_id = :id LIMIT 200"),
        {"id": entity_id})).all()
    facts = (await db.execute(text(FACT_SQL + " WHERE f.subject_id = :id ORDER BY f.created_at DESC LIMIT 100"),
                              {"id": entity_id})).all()
    return EntityDetailOut(id=e.id, type=e.type, name=e.name, edges=[EdgeOut(**x._mapping) for x in edges],
                           facts=await _facts(db, svc, facts))


# ------------------------------------------------------------------ mind map --
class GraphNode(BaseModel):
    id: uuid.UUID
    type: str
    name: str
    degree: int
    facts: int


class GraphLink(BaseModel):
    source: uuid.UUID
    target: uuid.UUID
    type: str
    count: int = Field(description="how many sources state this link")


class GraphOut(BaseModel):
    nodes: list[GraphNode]
    links: list[GraphLink]
    total_entities: int
    truncated: bool


@router.get("/ventures/{venture_id}/graph", response_model=GraphOut)
async def graph(venture_id: uuid.UUID, db: TenantDB, focus: uuid.UUID | None = None,
                q: str | None = None, limit: int = 120) -> GraphOut:
    """The knowledge graph for the mind map. Without `focus`: the best-connected entities
    (optionally matching `q`) and the links between them. With `focus`: that entity and
    everything within two links of it. RLS hides restricted entities and links."""
    await venture_org(db, venture_id)
    lim = min(max(limit, 10), 300)
    total = (await db.execute(text("SELECT count(*) FROM entities WHERE venture_id = :v"),
                              {"v": venture_id})).scalar_one()
    deg = ("(SELECT count(*) FROM edges x WHERE x.src_id = e.id OR x.dst_id = e.id)")
    if focus is not None:
        ids_sql = ("WITH h1 AS (SELECT CASE WHEN src_id = :f THEN dst_id ELSE src_id END AS id FROM edges"
                   " WHERE venture_id = :v AND (src_id = :f OR dst_id = :f)),"
                   " h2 AS (SELECT CASE WHEN x.src_id = h1.id THEN x.dst_id ELSE x.src_id END AS id FROM edges x"
                   " JOIN h1 ON x.src_id = h1.id OR x.dst_id = h1.id WHERE x.venture_id = :v)"
                   " SELECT :f AS id UNION SELECT id FROM h1 UNION SELECT id FROM h2")
        params: dict[str, Any] = {"v": venture_id, "f": focus}
        rows = (await db.execute(text(
            f"SELECT e.id, e.type, e.name, {deg} AS degree,"
            " (SELECT count(*) FROM facts f WHERE f.subject_id = e.id) AS facts"
            f" FROM entities e WHERE e.venture_id = :v AND e.id IN ({ids_sql})"
            f" ORDER BY (e.id = :f) DESC, {deg} DESC LIMIT :l"), {**params, "l": lim})).all()
    else:
        params = {"v": venture_id, "l": lim}
        where = "e.venture_id = :v"
        if q:
            where += " AND e.canonical LIKE :q"
            params["q"] = f"%{memory.canonical(q)}%"
        rows = (await db.execute(text(
            f"SELECT e.id, e.type, e.name, {deg} AS degree,"
            " (SELECT count(*) FROM facts f WHERE f.subject_id = e.id) AS facts"
            f" FROM entities e WHERE {where} ORDER BY {deg} DESC, e.name LIMIT :l"), params)).all()
    nodes = [GraphNode(**r._mapping) for r in rows]
    ids = [n.id for n in nodes]
    links: list[GraphLink] = []
    if ids:
        lrows = (await db.execute(text(
            "SELECT src_id AS source, dst_id AS target, type, count(*) AS count FROM edges"
            " WHERE venture_id = :v AND src_id = ANY(:ids) AND dst_id = ANY(:ids) AND src_id <> dst_id"
            " GROUP BY src_id, dst_id, type ORDER BY count(*) DESC LIMIT 1000"),
            {"v": venture_id, "ids": ids})).all()
        links = [GraphLink(**r._mapping) for r in lrows]
    return GraphOut(nodes=nodes, links=links, total_entities=total,
                    truncated=focus is None and not q and total > len(nodes))


# ------------------------------------------------------------ voice & meetings --
class TranscriptOut(BaseModel):
    text: str
    language: str | None
    deployment: str


@router.post("/ventures/{venture_id}/transcribe", response_model=TranscriptOut)
async def voice_input(venture_id: uuid.UUID, user_id: UserId, svc: Svc, file: UploadFile = File(...),
                      sensitive: bool = Form(default=False)) -> TranscriptOut:
    """In-app voice (kept for older clients): same pipeline as /voice/dictate in 'type' mode."""
    from kritvia_api.routers.voice import dictate, read_dictation
    data = await read_dictation(file)
    out = await dictate(venture_id=venture_id, user_id=user_id, svc=svc, data=data,
                        filename=file.filename or "voice.webm", sensitive=sensitive, language=None, engine=None,
                        mode="type", surface="web", duration_ms=None)
    return TranscriptOut(text=out.text, language=out.language, deployment=out.deployment)


class MeetingOut(BaseModel):
    document_id: uuid.UUID
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/meetings", response_model=MeetingOut, status_code=202)
async def upload_meeting(venture_id: uuid.UUID, user_id: UserId, svc: Svc, file: UploadFile = File(...),
                         title: str = Form(...), sensitive: bool = Form(default=False),
                         speaker_names: str | None = Form(default=None,
                                                          description='JSON map, e.g. {"SPEAKER_00": "Mayank"}')
                         ) -> MeetingOut:
    names = {}
    if speaker_names:
        try:
            names = {str(k): str(v)[:80] for k, v in json.loads(speaker_names).items()}
        except (ValueError, AttributeError):
            raise HTTPException(422, "speaker_names must be a JSON object") from None
    data = await read_upload(file)
    doc_id = uuid.uuid4()
    async with tenant_tx(user_id) as conn:
        org = await venture_org(conn, venture_id)
        try:
            async with conn.begin_nested():
                raw = await EnvelopeCrypto(conn, svc.keys).encrypt(venture_id, memory.RAW_PURPOSE, data)
                await conn.execute(text(
                    "INSERT INTO documents (id, org_id, venture_id, title, kind, mime, sha256, size_bytes, raw_enc,"
                    " sensitive, status, meta, created_by) VALUES (:id, :o, :v, :t, 'meeting', :m, :h, :sz, :raw,"
                    " :se, 'pending', CAST(:meta AS jsonb), :u)"),
                    {"id": doc_id, "o": org, "v": venture_id, "t": title[:300], "m": file.content_type,
                     "h": hashlib.sha256(data).hexdigest(), "sz": len(data), "raw": raw, "se": sensitive,
                     "meta": json.dumps({"filename": file.filename}), "u": user_id})
        except DBAPIError as exc:
            raise_for_db(exc, "venture not found")
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="meeting_digest",
                                 input={"document_id": str(doc_id), "speaker_names": names},
                                 title=f"Meeting: {title[:120]}", trigger_kind="upload")
    except (LookupError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from None
    async with tenant_tx(user_id) as conn:
        await conn.execute(text("UPDATE documents SET meta = meta || CAST(:m AS jsonb) WHERE id = :id"),
                           {"m": json.dumps({"run_id": str(run_id)}), "id": doc_id})
    return MeetingOut(document_id=doc_id, run_id=run_id)
