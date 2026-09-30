"""Knowledge ingestion, retrieval and cited Q&A.

Ingestion:  bytes -> text (extract/OCR) -> PII masking -> chunks -> embeddings
            -> pgvector, then an extraction pass writes entities / edges / facts,
            each fact pinned to the chunk it came from.
Retrieval:  vector similarity + facts attached to the hit chunks + facts about
            entities named in the question, all filtered by RLS.
Answering:  numbered sources in, answer with [n] citations out. Citations are
            validated; an answer that cites nothing is flagged as unsupported.

Works for both humans (API, `UserActor`) and agents (`RunContext`): both expose
tx(), crypto(), call_ctx(), org_id, venture_id.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid
from datetime import date
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.services import llm, pii
from kritvia_api.services.crypto import EnvelopeCrypto, KeyProvider
from kritvia_api.services.model_router import CallContext, ModelRouter, RouterError, embed
from kritvia_api.services.textextract import extract_text

CHUNK_CHARS = 1200
CHUNK_OVERLAP = 150
EXTRACT_BATCH_CHARS = 7000
TEXT_PURPOSE = "chunks.text"
RAW_PURPOSE = "documents.raw"
FACT_PURPOSE = "facts.statement"


class Actor(Protocol):
    org_id: uuid.UUID
    venture_id: uuid.UUID

    def tx(self, agent: str | None = None): ...
    def crypto(self, conn) -> EnvelopeCrypto: ...
    def call_ctx(self, agent: str | None = None) -> CallContext: ...


@dataclass
class UserActor:
    """A human acting through the API (RLS as that user)."""
    user_id: uuid.UUID
    org_id: uuid.UUID
    venture_id: uuid.UUID
    router: ModelRouter
    keys: KeyProvider
    workflow: str | None = None

    @asynccontextmanager
    async def tx(self, agent: str | None = None):
        async with tenant_tx(self.user_id) as conn:
            yield conn

    def crypto(self, conn) -> EnvelopeCrypto:
        return EnvelopeCrypto(conn, self.keys)

    def call_ctx(self, agent: str | None = None) -> CallContext:
        return CallContext(org_id=self.org_id, venture_id=self.venture_id, user_id=self.user_id,
                           workflow=self.workflow or "knowledge")

    @property
    def services_router(self) -> ModelRouter:
        return self.router


def _router(actor: Any) -> ModelRouter:
    if hasattr(actor, "services"):
        return actor.services.router
    return actor.router


def _vec(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def canonical(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s&.-]", "", name.lower())).strip()[:200]


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------
@dataclass
class Chunk:
    text: str
    page: int | None = None
    start_s: float | None = None
    end_s: float | None = None
    speaker: str | None = None


def chunk_text(text_: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[Chunk]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text_) if p.strip()]
    chunks: list[str] = []
    cur = ""
    for p in paras:
        while len(p) > size:  # hard-split very long paragraphs at sentence/space boundaries
            cut = max(p.rfind(". ", 0, size), p.rfind(" ", 0, size))
            cut = cut + 1 if cut > size // 2 else size
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(p[:cut].strip())
            p = p[max(cut - overlap, 1):].strip()
        if len(cur) + len(p) + 2 <= size:
            cur = f"{cur}\n\n{p}" if cur else p
        else:
            if cur:
                chunks.append(cur)
            tail = cur[-overlap:] if cur else ""
            cur = (tail + "\n\n" + p).strip() if tail and len(tail) + len(p) + 2 <= size else p
    if cur:
        chunks.append(cur)
    return [Chunk(c) for c in chunks if c.strip()]


def chunk_segments(segments: list[dict[str, Any]], window_s: float = 60.0) -> list[Chunk]:
    """Group transcript segments into ~1-minute chunks, splitting on speaker change."""
    out: list[Chunk] = []
    cur: list[dict] = []
    for seg in segments:
        if cur and (seg["end"] - cur[0]["start"] > window_s or seg.get("speaker") != cur[-1].get("speaker")):
            out.append(_seg_chunk(cur))
            cur = []
        cur.append(seg)
    if cur:
        out.append(_seg_chunk(cur))
    return out


def _seg_chunk(segs: list[dict]) -> Chunk:
    speaker = segs[0].get("speaker")
    body = " ".join(s["text"] for s in segs if s.get("text"))
    stamp = f"[{_ts(segs[0]['start'])}–{_ts(segs[-1]['end'])}]"
    label = f"{speaker}: " if speaker else ""
    return Chunk(f"{stamp} {label}{body}".strip(), start_s=segs[0]["start"], end_s=segs[-1]["end"],
                 speaker=speaker)


def _ts(s: float) -> str:
    s = int(s)
    return f"{s // 3600:d}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:d}:{s % 60:02d}"


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------
@dataclass
class IngestResult:
    document_id: uuid.UUID
    duplicate: bool
    chunks: int
    sensitive: bool
    pii_tags: list[str]
    embedded: bool
    facts: int = 0
    entities: int = 0
    warnings: list[str] = field(default_factory=list)


async def ingest(
    actor: Any,
    *,
    title: str,
    kind: str,
    data: bytes | None = None,
    filename: str = "document.txt",
    mime: str | None = None,
    text_override: str | None = None,
    segments: list[dict[str, Any]] | None = None,
    source_uri: str | None = None,
    external_id: str | None = None,
    access_roles: list[str] | None = None,
    sensitive: bool = False,
    data_principal: str | None = None,
    meta: dict[str, Any] | None = None,
    created_by: uuid.UUID | None = None,
    extract_knowledge: bool = True,
    extraction_focus: str = "general",
) -> IngestResult:
    raw = data if data is not None else (text_override or "").encode()
    sha = hashlib.sha256(raw).hexdigest()
    async with actor.tx() as conn:
        existing = (await conn.execute(
            text("SELECT id, sensitive, pii_tags FROM documents WHERE venture_id = :v AND sha256 = :h AND kind = :k"),
            {"v": actor.venture_id, "h": sha, "k": kind})).first()
    if existing:
        return IngestResult(existing.id, True, 0, existing.sensitive, list(existing.pii_tags), True)

    warnings: list[str] = []
    method = "provided"
    if text_override is not None:
        body = text_override
    else:
        ex = await asyncio.to_thread(extract_text, raw, filename, mime)
        body, method = ex.text, ex.method
        meta = {**(meta or {}), "pages": ex.pages}
    if not body.strip():
        warnings.append("no text could be extracted")

    masked = pii.mask(body)
    is_sensitive = sensitive or masked.sensitive
    if segments:
        chunks = chunk_segments([{**s, "text": pii.mask(s.get("text", "")).text} for s in segments])
    else:
        chunks = chunk_text(masked.text)

    vectors: list[list[float] | None] = [None] * len(chunks)
    embedded = True
    if chunks:
        try:
            got = await embed(_router(actor), actor.call_ctx("ingestion"), [c.text for c in chunks],
                              sensitive=is_sensitive)
            vectors = list(got)
        except RouterError as exc:
            embedded = False
            warnings.append(f"embedding deferred: {exc}"[:200])

    doc_id = uuid.uuid4()
    async with actor.tx("ingestion") as conn:
        crypto = actor.crypto(conn)
        raw_enc = await crypto.encrypt(actor.venture_id, RAW_PURPOSE, raw) if data is not None else None
        await conn.execute(
            text("INSERT INTO documents (id, org_id, venture_id, title, kind, source_uri, external_id, mime, sha256,"
                 " size_bytes, raw_enc, text_method, pii_tags, sensitive, access_roles, status, meta,"
                 " data_principal, created_by, error)"
                 " VALUES (:id, :o, :v, :t, :k, :su, :x, :m, :h, :sz, :raw, :tm, :tags, :se, :ar, 'ready',"
                 " CAST(:meta AS jsonb), :dp, :cb, :err)"),
            {"id": doc_id, "o": actor.org_id, "v": actor.venture_id, "t": title[:300], "k": kind,
             "su": source_uri, "x": external_id, "m": mime, "h": sha, "sz": len(raw), "raw": raw_enc,
             "tm": method, "tags": masked.tags, "se": is_sensitive, "ar": access_roles,
             "meta": json.dumps({**(meta or {}), "embedded": embedded, "chunks": len(chunks)}),
             "dp": data_principal, "cb": created_by, "err": "; ".join(warnings) or None})
        chunk_ids = []
        for i, (c, vec) in enumerate(zip(chunks, vectors, strict=True)):
            cid = uuid.uuid4()
            chunk_ids.append(cid)
            await conn.execute(
                text("INSERT INTO chunks (id, org_id, venture_id, document_id, ord, text_enc, char_count, page,"
                     " start_s, end_s, speaker, embedding, sensitive, access_roles)"
                     " VALUES (:id, :o, :v, :d, :ord, :t, :n, :p, :ss, :es, :sp, CAST(:e AS vector), :se, :ar)"),
                {"id": cid, "o": actor.org_id, "v": actor.venture_id, "d": doc_id, "ord": i,
                 "t": await crypto.encrypt(actor.venture_id, TEXT_PURPOSE, c.text), "n": len(c.text),
                 "p": c.page, "ss": c.start_s, "es": c.end_s, "sp": c.speaker,
                 "e": _vec(vec) if vec else None, "se": is_sensitive, "ar": access_roles})

    result = IngestResult(doc_id, False, len(chunks), is_sensitive, masked.tags, embedded, warnings=warnings)
    if extract_knowledge and chunks:
        try:
            n_e, n_f = await extract_knowledge_from(actor, doc_id, list(zip(chunk_ids, chunks, strict=True)),
                                                    sensitive=is_sensitive, access_roles=access_roles,
                                                    focus=extraction_focus)
            result.entities, result.facts = n_e, n_f
        except (RouterError, llm.LLMOutputError) as exc:
            result.warnings.append(f"knowledge extraction skipped: {exc}"[:200])
    return result


# ---------------------------------------------------------------------------
# Knowledge extraction
# ---------------------------------------------------------------------------
EntityType = Literal["person", "company", "project", "property", "vendor", "sku", "loan", "product",
                     "place", "other"]


class XEntity(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: EntityType = "other"


class XEdge(BaseModel):
    src: str
    dst: str
    type: str = Field(description="UPPER_SNAKE relationship, e.g. CLIENT_OF, OWNS, SUPPLIES, BLOCKED_BY")
    source: int = Field(description="index of the source passage")


class XFact(BaseModel):
    statement: str = Field(min_length=3, max_length=600)
    kind: Literal["fact", "decision", "task", "commitment"] = "fact"
    subject: str | None = None
    owner: str | None = None
    due_date: str | None = Field(default=None, description="YYYY-MM-DD if stated")
    source: int = Field(description="index of the passage the statement comes from")
    confidence: float = Field(default=0.8, ge=0, le=1)


class XOut(BaseModel):
    entities: list[XEntity] = Field(default_factory=list)
    edges: list[XEdge] = Field(default_factory=list)
    facts: list[XFact] = Field(default_factory=list)


FOCUS = {
    "general": "Extract durable business facts: who, what, amounts, dates, commitments.",
    "meeting": "This is a meeting transcript. Extract every DECISION, every TASK (with owner and due date "
               "if said) and every COMMITMENT. Owners are speaker names or people mentioned.",
    "proposal": "Extract the client, scope items, technologies, price quoted, timeline and outcome.",
}


async def extract_knowledge_from(actor: Any, document_id: uuid.UUID, items: list[tuple[uuid.UUID, Chunk]], *,
                                 sensitive: bool, access_roles: list[str] | None,
                                 focus: str = "general") -> tuple[int, int]:
    tier = "private" if sensitive else "extract"
    total_e = total_f = 0
    batch: list[tuple[uuid.UUID, Chunk]] = []
    size = 0
    batches = []
    for it in items:
        if batch and size + len(it[1].text) > EXTRACT_BATCH_CHARS:
            batches.append(batch)
            batch, size = [], 0
        batch.append(it)
        size += len(it[1].text)
    if batch:
        batches.append(batch)

    for b in batches:
        passages = "\n\n".join(f"<passage index={i}>\n{c.text}\n</passage>" for i, (_, c) in enumerate(b))
        out = await llm.complete_json(
            _router(actor), actor.call_ctx("extraction"), tier=tier, sensitive=sensitive, schema=XOut,
            system=("You build a company knowledge graph. Only state what the passages say. "
                    "Every fact and edge must reference the passage index it came from. "
                    + FOCUS.get(focus, FOCUS["general"])),
            prompt=passages)
        e, f = await _store_knowledge(actor, b, out, access_roles)
        total_e, total_f = total_e + e, total_f + f
    return total_e, total_f


async def _store_knowledge(actor: Any, batch: list[tuple[uuid.UUID, Chunk]], out: XOut,
                           access_roles: list[str] | None) -> tuple[int, int]:
    ids: dict[str, uuid.UUID] = {}
    async with actor.tx("extraction") as conn:
        crypto = actor.crypto(conn)

        async def entity(name: str, etype: str = "other") -> uuid.UUID | None:
            key = canonical(name)
            if not key:
                return None
            if key in ids:
                return ids[key]
            row = (await conn.execute(
                text("INSERT INTO entities (org_id, venture_id, type, name, canonical, access_roles)"
                     " VALUES (:o, :v, :t, :n, :c, :ar)"
                     " ON CONFLICT (venture_id, type, canonical, (private.roles_key(access_roles)))"
                     " DO UPDATE SET name = entities.name"
                     " RETURNING id"),
                {"o": actor.org_id, "v": actor.venture_id, "t": etype, "n": name[:200], "c": key,
                 "ar": access_roles})).first()
            if row is None:
                return None
            ids[key] = row.id
            return row.id

        for ent in out.entities:
            await entity(ent.name, ent.type)
        for ed in out.edges:
            if not (0 <= ed.source < len(batch)):
                continue
            etype = re.sub(r"[^A-Z_]", "", ed.type.upper().replace(" ", "_"))[:40]
            if len(etype) < 2 or not etype[0].isalpha():
                continue
            s, d = await entity(ed.src), await entity(ed.dst)
            if s and d and s != d:
                await conn.execute(
                    text("INSERT INTO edges (org_id, venture_id, src_id, dst_id, type, source_chunk_id, access_roles)"
                         " VALUES (:o, :v, :s, :d, :t, :c, :ar) ON CONFLICT DO NOTHING"),
                    {"o": actor.org_id, "v": actor.venture_id, "s": s, "d": d, "t": etype,
                     "c": batch[ed.source][0], "ar": access_roles})
        n_f = 0
        for f in out.facts:
            if not (0 <= f.source < len(batch)):
                continue  # uncited -> discarded: every fact must point at a source
            chunk_id, chunk = batch[f.source]
            subject = await entity(f.subject) if f.subject else None
            due = None
            if f.due_date and re.fullmatch(r"\d{4}-\d{2}-\d{2}", f.due_date):
                try:
                    due = date.fromisoformat(f.due_date)
                except ValueError:
                    due = None
            await conn.execute(
                text("INSERT INTO facts (org_id, venture_id, kind, subject_id, statement_enc, owner, due_date,"
                     " status, confidence, source_chunk_id, source_start_s, access_roles)"
                     " VALUES (:o, :v, :k, :s, :st, :ow, :due, :status, :cf, :c, :ss, :ar)"),
                {"o": actor.org_id, "v": actor.venture_id, "k": f.kind, "s": subject,
                 "st": await crypto.encrypt(actor.venture_id, FACT_PURPOSE, pii.mask(f.statement).text),
                 "ow": (f.owner or None) and f.owner[:120], "due": due,
                 "status": "open" if f.kind in ("task", "commitment") else None, "cf": f.confidence,
                 "c": chunk_id, "ss": chunk.start_s, "ar": access_roles})
            n_f += 1
    return len(ids), n_f


# ---------------------------------------------------------------------------
# Retrieval and cited answers
# ---------------------------------------------------------------------------
@dataclass
class Hit:
    chunk_id: uuid.UUID
    document_id: uuid.UUID
    venture_id: uuid.UUID
    title: str
    kind: str
    text: str
    score: float
    sensitive: bool
    page: int | None = None
    start_s: float | None = None
    source_uri: str | None = None
    facts: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return {"chunk_id": str(self.chunk_id), "document_id": str(self.document_id),
                "venture_id": str(self.venture_id), "title": self.title, "kind": self.kind,
                "excerpt": self.text[:600], "score": round(self.score, 4), "page": self.page,
                "start_s": self.start_s, "source_uri": self.source_uri}


async def search(actor: Any, query: str, *, k: int = 8, venture_ids: list[uuid.UUID] | None = None,
                 kinds: list[str] | None = None, include_restricted: bool = True,
                 include_sensitive: bool = True) -> list[Hit]:
    """RLS already limits rows to what the actor may see. Agents additionally pass
    include_restricted/include_sensitive=False so role-restricted or sensitive
    knowledge never flows into drafts other people read, or to non-local models."""
    [qv] = await embed(_router(actor), actor.call_ctx("retrieval"), [query])
    ventures = venture_ids or [actor.venture_id]
    sql = ("SELECT c.id, c.document_id, c.venture_id, c.text_enc, c.page, c.start_s, c.sensitive,"
           " d.title, d.kind, d.source_uri, 1 - (c.embedding <=> CAST(:q AS vector)) AS score"
           " FROM chunks c JOIN documents d ON d.id = c.document_id"
           " WHERE c.embedding IS NOT NULL AND c.venture_id = ANY(:vs)")
    params: dict[str, Any] = {"q": _vec(qv), "vs": ventures, "k": max(1, min(k, 30))}
    if kinds:
        sql += " AND d.kind = ANY(:kinds)"
        params["kinds"] = kinds
    if not include_restricted:
        sql += " AND c.access_roles IS NULL"
    if not include_sensitive:
        sql += " AND NOT c.sensitive"
    sql += " ORDER BY c.embedding <=> CAST(:q AS vector) LIMIT :k"
    async with actor.tx("retrieval") as conn:
        rows = (await conn.execute(text(sql), params)).all()
        crypto = actor.crypto(conn)
        hits = [Hit(r.id, r.document_id, r.venture_id, r.title, r.kind,
                    (await crypto.decrypt(r.venture_id, TEXT_PURPOSE, r.text_enc)).decode(),
                    float(r.score), r.sensitive, r.page, r.start_s, r.source_uri) for r in rows]
        if hits:
            facts = (await conn.execute(
                text("SELECT source_chunk_id, venture_id, statement_enc, kind FROM facts"
                     " WHERE source_chunk_id = ANY(:ids) ORDER BY created_at LIMIT 60"),
                {"ids": [h.chunk_id for h in hits]})).all()
            by_chunk: dict[uuid.UUID, list[str]] = {}
            for f in facts:
                stmt = (await crypto.decrypt(f.venture_id, FACT_PURPOSE, f.statement_enc)).decode()
                by_chunk.setdefault(f.source_chunk_id, []).append(f"{f.kind}: {stmt}")
            for h in hits:
                h.facts = by_chunk.get(h.chunk_id, [])[:6]
            # Graph hop: facts about entities named in the question, from chunks not already hit.
            names = [w for w in re.findall(r"[A-Za-z][\w&.-]{2,}", query)]
            if names and include_restricted and include_sensitive:
                extra = (await conn.execute(
                    text("SELECT DISTINCT c.id FROM entities e JOIN facts f ON f.subject_id = e.id"
                         " JOIN chunks c ON c.id = f.source_chunk_id"
                         " WHERE e.venture_id = ANY(:vs) AND e.canonical = ANY(:names)"
                         " AND NOT (c.id = ANY(:ids)) LIMIT 4"),
                    {"vs": ventures, "names": [canonical(n) for n in names],
                     "ids": [h.chunk_id for h in hits]})).all()
                for x in extra:
                    r = (await conn.execute(
                        text("SELECT c.id, c.document_id, c.venture_id, c.text_enc, c.page, c.start_s, c.sensitive,"
                             " d.title, d.kind, d.source_uri FROM chunks c JOIN documents d ON d.id = c.document_id"
                             " WHERE c.id = :id"), {"id": x.id})).first()
                    if r:
                        hits.append(Hit(r.id, r.document_id, r.venture_id, r.title, r.kind,
                                        (await crypto.decrypt(r.venture_id, TEXT_PURPOSE, r.text_enc)).decode(),
                                        0.0, r.sensitive, r.page, r.start_s, r.source_uri))
    return hits


async def search_as_agent(ctx: Any, query: str, *, k: int = 6, kinds: list[str] | None = None,
                          sensitive: bool = False) -> list[dict[str, Any]]:
    """Agent retrieval. Unless the calling workflow declares it handles sensitive data
    (and therefore uses the private tier and sensitive approvals), restricted and
    sensitive chunks are excluded."""
    hits = await search(ctx, query, k=k, kinds=kinds, include_restricted=sensitive, include_sensitive=sensitive)
    return [{**h.public(), "text": h.text, "facts": h.facts, "sensitive": h.sensitive} for h in hits]


@dataclass
class Answer:
    answer: str
    citations: list[dict[str, Any]]
    supported: bool
    tier: str


_CITE = re.compile(r"\[(\d{1,2})\]")


async def ask(actor: Any, question: str, *, venture_ids: list[uuid.UUID] | None = None, k: int = 8) -> Answer:
    hits = await search(actor, question, k=k, venture_ids=venture_ids)
    if not hits:
        return Answer("I couldn't find anything in the knowledge base about that.", [], False, "none")
    sensitive = any(h.sensitive for h in hits)
    tier = "private" if sensitive else "reason"
    blocks = []
    for i, h in enumerate(hits, start=1):
        facts = ("\nKnown facts: " + "; ".join(h.facts)) if h.facts else ""
        blocks.append(f"[{i}] {h.title} ({h.kind})\n{h.text}{facts}")
    system = ("You answer questions for a business owner using ONLY the numbered sources. "
              "Cite every claim with its source number in square brackets, e.g. [2]. "
              "If the sources do not answer the question, say exactly what is missing. "
              "Never invent numbers, names or dates. Be concise.")
    content = await llm.complete_text(_router(actor), actor.call_ctx("qa"), tier=tier, system=system,
                                      prompt="Sources:\n\n" + "\n\n".join(blocks) + f"\n\nQuestion: {question}",
                                      sensitive=sensitive, temperature=0.1)
    used = sorted({int(n) for n in _CITE.findall(content) if 1 <= int(n) <= len(hits)})
    content = _CITE.sub(lambda m: m.group(0) if 1 <= int(m.group(1)) <= len(hits) else "", content)
    citations = [{"n": n, **hits[n - 1].public()} for n in used]
    async with actor.tx("qa") as conn:
        await conn.execute(text("SELECT audit_event(:o, :v, 'knowledge.ask', 'chunks', NULL, CAST(:d AS jsonb))"),
                           {"o": actor.org_id, "v": actor.venture_id,
                            "d": json.dumps({"sources": len(hits), "cited": used, "tier": tier})})
    return Answer(content, citations, bool(used), tier)


async def reembed_pending(actor: Any, limit: int = 200) -> int:
    """Embed chunks whose embedding was deferred (e.g. Ollama was down at ingest)."""
    async with actor.tx("ingestion") as conn:
        rows = (await conn.execute(
            text("SELECT id, venture_id, text_enc, sensitive FROM chunks"
                 " WHERE venture_id = :v AND embedding IS NULL ORDER BY created_at LIMIT :l"),
            {"v": actor.venture_id, "l": limit})).all()
        texts = [(await actor.crypto(conn).decrypt(r.venture_id, TEXT_PURPOSE, r.text_enc)).decode() for r in rows]
    if not rows:
        return 0
    vecs = await embed(_router(actor), actor.call_ctx("ingestion"), texts, sensitive=any(r.sensitive for r in rows))
    async with actor.tx("ingestion") as conn:
        for r, v in zip(rows, vecs, strict=True):
            await conn.execute(text("UPDATE chunks SET embedding = CAST(:e AS vector) WHERE id = :id"),
                               {"e": _vec(v), "id": r.id})
    return len(rows)
