"""Keyset pagination for lists the developer API reads (test report round 2, P16).

A list endpoint takes `cursor` (opaque) and, when there may be more, answers with the header
`X-Next-Cursor: <cursor>` for the next page; existing callers that don't send a cursor get exactly
what they got before. Rows are ordered by (created_at, id), so a page never repeats or skips a row
when new rows arrive between requests.
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime
from typing import Any

from fastapi import HTTPException, Response

HEADER = "X-Next-Cursor"


def encode(ts: datetime, row_id: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(f"{ts.isoformat()}|{row_id}".encode()).decode().rstrip("=")


def decode(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        ts, rid = raw.split("|", 1)
        return datetime.fromisoformat(ts), uuid.UUID(rid)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(422, "cursor is not valid; use the X-Next-Cursor value as it came") from None


def where(cursor: str | None, *, descending: bool = True, alias: str = "") -> tuple[str, dict[str, Any]]:
    """An SQL condition (with its parameters) for rows after the cursor, or ("true", {})."""
    if not cursor:
        return "true", {}
    ts, rid = decode(cursor)
    p = f"{alias}." if alias else ""
    op = "<" if descending else ">"
    return f"({p}created_at, {p}id) {op} (:cursor_ts, :cursor_id)", {"cursor_ts": ts, "cursor_id": rid}


def order(*, descending: bool = True, alias: str = "") -> str:
    p = f"{alias}." if alias else ""
    d = "DESC" if descending else "ASC"
    return f"{p}created_at {d}, {p}id {d}"


def set_next(response: Response, rows: list[Any], limit: int) -> None:
    """Adds X-Next-Cursor when the page is full (there may be more)."""
    if rows and len(rows) >= limit:
        last = rows[-1]
        m = last._mapping if hasattr(last, "_mapping") else last
        response.headers[HEADER] = encode(m["created_at"], m["id"])
