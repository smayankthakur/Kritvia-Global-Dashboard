"""Translate database permission failures into HTTP responses.

An RLS rejection returns 404, not 403: telling a caller "forbidden" confirms
that the venture or record exists.
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.exc import DBAPIError, IntegrityError

PERMISSION_SQLSTATES = {"42501"}  # insufficient_privilege (incl. RLS WITH CHECK)


def sqlstate(exc: DBAPIError) -> str | None:
    orig = getattr(exc, "orig", None)
    return getattr(orig, "sqlstate", None) or getattr(getattr(orig, "__cause__", None), "sqlstate", None)


def raise_for_db(exc: DBAPIError, not_found: str = "not found") -> None:
    code = sqlstate(exc)
    if code in PERMISSION_SQLSTATES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, not_found) from None
    if isinstance(exc, IntegrityError):
        if code == "23505":
            raise HTTPException(status.HTTP_409_CONFLICT, "already exists") from None
        if code == "23503":
            raise HTTPException(status.HTTP_404_NOT_FOUND, not_found) from None
        raise HTTPException(422, "constraint violated") from None
    if code == "KV409":  # state conflicts raised by our functions (already decided, not earned, ...)
        msg = str(getattr(exc, "orig", exc)).split("\n")[0]
        msg = msg.split(": ", 1)[-1] if ": " in msg else msg
        raise HTTPException(status.HTTP_409_CONFLICT, msg[:300]) from None
    if code == "P0001":  # RAISE EXCEPTION in our functions
        raise HTTPException(422, "rejected by policy") from None
    raise exc
