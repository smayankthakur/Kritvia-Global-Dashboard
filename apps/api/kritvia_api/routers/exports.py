"""Organisation export: everything an organisation keeps in Kritvia, for its owners (test report round 2, P14).

  GET /orgs/{org_id}/export     a ZIP, streamed as it is built (Terms 6.9 and 18.2): for each business, one
                                CSV per kind of record (leads, invoices, payments, bills, bank lines, bookings,
                                chats, cards, runs…), the readable text of encrypted records, and the documents
                                as files. Owners only. Works while the organisation is read-only (a trial that
                                ended) or closed, until it is deleted.

What is left out: secrets (connection tokens, API keys' hashes, statement passwords, encryption keys) and
internal bookkeeping hashes. Each business's rows are read as the owner, through the same row-level
security as the app, so nothing outside the organisation can appear. Built while it streams (no copy kept
on the server), so it starts at once however large the organisation is.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import re
import uuid
import zipfile
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, UserId
from kritvia_api.services.crypto import EnvelopeCrypto

router = APIRouter(prefix="/orgs", tags=["orgs"])
log = logging.getLogger("kritvia.export")

# Never exported: secrets and key material, whatever columns they have.
SKIP_TABLES = {"connector_tokens", "tenant_keys", "voice_keys", "app_oauth_pending", "idempotency_keys"}
SKIP_COLUMN = re.compile(r"(hash|secret|token|password|wrapped|_enc$)", re.I)
# Encrypted columns exported as readable text: (table, column) -> purpose.
READABLE = {
    ("leads", "details_enc"): "leads.details",
    ("leads", "outreach_draft_enc"): "leads.outreach",
    ("outbox_messages", "body_enc"): "outbox.body",
    ("proposals", "content_enc"): "proposals.content",
    ("wa_messages", "body_enc"): "whatsapp.message",
    ("task_cards", "title_enc"): "task_cards.title",
    ("approvals", "final_payload_enc"): "approvals.payload",
    ("automation_results", "body_enc"): "automation.result",
    ("facts", "statement_enc"): "facts.statement",
    ("candidates", "cv_enc"): "hiring.cv",
    ("loan_applications", "applicant_enc"): "loan_applications.applicant",
    ("loan_documents", "fields_enc"): "loan_documents.fields",
}
BATCH = 500


class _Sink(io.RawIOBase):
    """Where the ZIP is written; the response takes what has accumulated after each piece."""

    def __init__(self) -> None:
        self.parts: list[bytes] = []

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:  # type: ignore[override]
        self.parts.append(bytes(b))
        return len(b)

    def take(self) -> bytes:
        out, self.parts = b"".join(self.parts), []
        return out


def _cell(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, datetime | date):
        return v.isoformat()
    if isinstance(v, uuid.UUID | Decimal):
        return str(v)
    if isinstance(v, dict | list):
        return json.dumps(v, ensure_ascii=False, default=str)
    if isinstance(v, bytes | memoryview):
        return ""
    return v


def _safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-")[:80] or "item"


async def _is_owner(user_id: uuid.UUID, org_id: uuid.UUID) -> bool | None:
    """True for an owner, False for another member, None for someone outside the organisation."""
    async with tenant_tx(user_id) as conn:
        roles = (await conn.execute(text(
            "SELECT role, venture_id FROM memberships WHERE user_id = :u AND org_id = :o"), {"u": user_id, "o": org_id})).all()
    if not roles:
        return None
    return any(r.role == "org_owner" and r.venture_id is None for r in roles)


async def _tables(conn) -> dict[str, list[tuple[str, str]]]:
    """Public tables with a venture_id that the app may read, and their readable columns (column grants
    apply: information_schema shows only what this role may select)."""
    rows = (await conn.execute(text(
        "SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c"
        " WHERE c.table_schema = 'public' AND c.table_name IN (SELECT table_name FROM information_schema.columns"
        "   WHERE table_schema = 'public' AND column_name = 'venture_id')"
        "  AND c.table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        "   AND table_type = 'BASE TABLE')"
        " ORDER BY c.table_name, c.ordinal_position"))).all()
    out: dict[str, list[tuple[str, str]]] = {}
    for r in rows:
        if r.table_name not in SKIP_TABLES:
            out.setdefault(r.table_name, []).append((r.column_name, r.data_type))
    return out


async def build(user_id: uuid.UUID, org_id: uuid.UUID, keys) -> AsyncIterator[bytes]:
    sink = _Sink()
    zf = zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED, allowZip64=True)
    async with tenant_tx(user_id) as conn:
        org = (await conn.execute(text("SELECT id, name, created_at FROM organisations WHERE id = :o"), {"o": org_id})).first()
        ventures = (await conn.execute(text(
            "SELECT id, name, slug FROM ventures WHERE org_id = :o AND id = ANY ((SELECT private.readable_ventures())::uuid[])"
            " ORDER BY created_at"), {"o": org_id})).all()
        tables = await _tables(conn)
    members: list = []
    try:
        async with tenant_tx(user_id) as conn:
            members = (await conn.execute(text(
                "SELECT u.email, u.full_name, m.role, v.name AS business, m.created_at FROM memberships m"
                " JOIN users u ON u.id = m.user_id LEFT JOIN ventures v ON v.id = m.venture_id WHERE m.org_id = :o"
                " ORDER BY m.created_at"), {"o": org_id})).all()
    except Exception:  # noqa: BLE001 - the people list is a nicety; the export goes on without it
        log.info("export: members not readable", exc_info=True)
    zf.writestr("README.txt", (
        f"Kritvia export of {org.name if org else org_id}, made {datetime.now(UTC):%Y-%m-%d %H:%M} UTC.\n\n"
        "One folder per business. Each CSV is one kind of record, as Kritvia keeps it; columns ending _text hold\n"
        "the readable text of encrypted records. documents/ holds the uploaded files. Secrets (connection tokens,\n"
        "keys, passwords) are never exported.\n"))
    zf.writestr("organisation.json", json.dumps({
        "id": str(org_id), "name": org.name if org else None, "created_at": _cell(org.created_at) if org else None,
        "members": [{k: _cell(v) for k, v in m._mapping.items()} for m in members],
        "businesses": [{"id": str(v.id), "name": v.name, "slug": v.slug} for v in ventures]},
        ensure_ascii=False, indent=1))
    yield sink.take()

    for v in ventures:
        folder = f"{_safe_name(v.slug or v.name)}-{str(v.id)[:8]}"
        for table, cols in tables.items():
            plain = [c for c, t in cols if t != "bytea" and not SKIP_COLUMN.search(c)]
            readable = [c for c, t in cols if (table, c) in READABLE]
            if not plain:
                continue
            select = ", ".join(f'"{c}"' for c in plain + readable)
            wrote_header = False
            handle = text_out = writer = None
            try:
                async with tenant_tx(user_id) as conn:
                    crypto = EnvelopeCrypto(conn, keys)
                    result = await conn.stream(text(f'SELECT {select} FROM "{table}" WHERE venture_id = :v'), {"v": v.id})
                    async for part in result.partitions(BATCH):
                        if not wrote_header:
                            handle = zf.open(f"{folder}/{table}.csv", "w", force_zip64=True)
                            text_out = io.TextIOWrapper(handle, encoding="utf-8", newline="")
                            writer = csv.writer(text_out)
                            writer.writerow(plain + [c.removesuffix("_enc") + "_text" for c in readable])
                            wrote_header = True
                        for row in part:
                            m = row._mapping
                            extra = []
                            for c in readable:
                                raw = m[c]
                                if raw is None:
                                    extra.append("")
                                    continue
                                try:
                                    extra.append((await crypto.decrypt(v.id, READABLE[(table, c)], bytes(raw))).decode("utf-8", "replace"))
                                except Exception:  # noqa: BLE001 - kept in the export as a marker
                                    extra.append("[could not decrypt]")
                            writer.writerow([_cell(m[c]) for c in plain] + extra)
                        text_out.flush()
                        yield sink.take()
            except Exception:  # noqa: BLE001 - a table this person may not read is left out, not the export
                log.info("export: %s skipped", table, exc_info=True)
            finally:
                if text_out is not None:
                    text_out.close()          # finishes this file in the ZIP
            yield sink.take()

        # The documents themselves.
        async with tenant_tx(user_id) as conn:
            docs = (await conn.execute(text(
                "SELECT id, title FROM documents WHERE venture_id = :v AND raw_enc IS NOT NULL ORDER BY created_at"),
                {"v": v.id})).all()
        for d in docs:
            try:
                async with tenant_tx(user_id) as conn:
                    raw = (await conn.execute(text("SELECT raw_enc FROM documents WHERE id = :d"), {"d": d.id})).scalar()
                    data = await EnvelopeCrypto(conn, keys).decrypt(v.id, "documents.raw", bytes(raw)) if raw else b""
                with zf.open(f"{folder}/documents/{str(d.id)[:8]}-{_safe_name(d.title or 'document')}", "w",
                             force_zip64=True) as f:
                    f.write(data)
            except Exception:  # noqa: BLE001
                log.info("export: a document was skipped", exc_info=True)
            yield sink.take()
    zf.close()
    yield sink.take()


@router.get("/{org_id}/export")
async def export_org(org_id: uuid.UUID, user_id: UserId, svc: Svc) -> StreamingResponse:
    """Everything this organisation keeps in Kritvia, as a ZIP (owners only)."""
    owner = await _is_owner(user_id, org_id)
    if owner is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
    if not owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the organisation's owners can export it")
    name = f"kritvia-export-{datetime.now(UTC):%Y%m%d}.zip"
    return StreamingResponse(build(user_id, org_id, svc.keys), media_type="application/zip",
                             headers={"content-disposition": f'attachment; filename="{name}"',
                                      "cache-control": "no-store", "x-content-type-options": "nosniff"})
