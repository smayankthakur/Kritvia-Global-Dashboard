"""Phase 2 hardening: sign-in lock-out without enumeration, upload allowlists with magic-number
checks, bad text refused, production surface (no schema, no password sign-up, CORS), short
code lifetimes, and the database role's least privilege."""
from __future__ import annotations

import io
import uuid

import asyncpg
import pytest
from pydantic import ValidationError

from conftest import ADMIN_DSN, make_actor

from kritvia_api.config import Settings, get_settings
from kritvia_api.ratelimit import signin_guard
from kritvia_api.services.mailer import get_mailer
from kritvia_api.services.uploads import check_upload

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PDF = b"%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"


@pytest.mark.asyncio
async def test_failed_sign_ins_lock_progressively_and_identically_for_unknown_addresses(client):
    who = await make_actor(client, "lockme")
    unknown = f"nobody-{uuid.uuid4().hex[:8]}@example.com"
    for email in (who.email, unknown):
        for _ in range(signin_guard.FREE_TRIES):
            r = await client.post("/auth/login", json={"email": email, "password": "wrong password!!"})
            assert r.status_code == 401 and r.json()["detail"] == "invalid credentials"
        # locked now — even the right password waits, and the answer is the same for both addresses
        r = await client.post("/auth/login", json={"email": email, "password": "correct horse battery"})
        assert r.status_code == 429 and "try again in 1 minute" in r.json()["detail"] and r.headers["retry-after"]
    # the real owner is told; nobody is emailed about the unknown address
    notices = [m for m in get_mailer().outbox if "failed sign-in attempts" in m["Subject"]]
    assert any(m["To"] == who.email for m in notices) and not any(m["To"] == unknown for m in notices)
    # the lock doubles with each further failure, up to an hour
    assert [signin_guard.lock_seconds(n) for n in (4, 5, 6, 7, 30)] == [0, 60, 120, 240, 3600]
    # once it expires, the right password works and clears the count
    signin_guard._mem.pop(signin_guard._key(who.email))
    assert (await client.post("/auth/login", json={"email": who.email, "password": "correct horse battery"})).status_code == 200


@pytest.mark.asyncio
async def test_wrong_current_password_counts_too(client):
    who = await make_actor(client, "pwchange")
    for _ in range(signin_guard.FREE_TRIES):
        r = await who.post("/auth/password", json={"current_password": "not it at all", "new_password": "another good passphrase"})
        assert r.status_code == 401
    r = await who.post("/auth/password", json={"current_password": "correct horse battery", "new_password": "another good passphrase"})
    assert r.status_code == 429


def test_uploads_must_really_be_the_type_they_claim():
    assert check_upload("scan.png", PNG, "image_or_pdf") == "image/png"
    assert check_upload("loan.PDF", PDF, "document") == "application/pdf"
    assert check_upload("notes.txt", "नमस्ते, hello".encode(), "document") == "text/plain"
    assert check_upload("call.webm", b"\x1aE\xdf\xa3audio", "audio") == "audio/webm"
    for name, data, kind in [
        ("invoice.pdf", b"<html><script>alert(1)</script></html>", "document"),   # HTML renamed .pdf
        ("photo.png", b"MZ\x90\x00 this is a windows exe", "image_or_pdf"),       # executable renamed .png
        ("run.exe", b"MZ\x90\x00", "document"),                                   # not on any list
        ("page.html", b"<html></html>", "image_or_pdf"),                         # not for this upload
        ("data.txt", b"\x00\x01\x02binary", "document"),                         # binary posing as text
        ("song.mp3", b"not audio", "audio"),
    ]:
        with pytest.raises(Exception) as exc:
            check_upload(name, data, kind)
        assert getattr(exc.value, "status_code", None) == 415, name


@pytest.mark.asyncio
async def test_upload_endpoint_refuses_disguised_files(world):
    alice, v = world["alice"], world["site"]
    files = {"file": ("quote.pdf", io.BytesIO(b"<html><body>not a pdf</body></html>"), "application/pdf")}
    r = await alice.post(f"/ventures/{v}/documents", files=files, data={"title": "Fake", "extract": "false"})
    assert r.status_code == 415
    files = {"file": ("standup.webm", io.BytesIO(b"plain text, not audio"), "audio/webm")}
    assert (await alice.post(f"/ventures/{v}/meetings", files=files, data={"title": "x"})).status_code == 415


@pytest.mark.asyncio
async def test_text_with_nul_bytes_is_refused_not_a_500(world):
    alice, v = world["alice"], world["site"]
    r = await alice.post(f"/ventures/{v}/leads", json={"name": "Acme\u0000Corp", "notes": "x"})
    assert r.status_code == 422


def test_codes_cannot_be_configured_to_last_longer_than_15_minutes():
    with pytest.raises(ValidationError):
        Settings(email_code_minutes=30)
    assert get_settings().email_code_minutes <= 15


@pytest.mark.asyncio
async def test_production_hides_schema_and_password_signup(client, monkeypatch):
    from kritvia_api.main import create_app
    monkeypatch.setattr(get_settings(), "environment", "production")
    monkeypatch.setattr(get_settings(), "allowed_origins", ["https://app.sitelytc.com", "http://localhost:3000", "*"])
    app = create_app()
    assert app.openapi_url is None and app.docs_url is None and app.redoc_url is None
    cors = next(m for m in app.user_middleware if m.cls.__name__ == "CORSMiddleware")
    assert cors.kwargs["allow_origins"] == ["https://app.sitelytc.com"]
    r = await client.post("/auth/register", json={"email": f"p-{uuid.uuid4().hex[:6]}@example.com",
                                                  "full_name": "P", "password": "correct horse battery"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_app_database_role_has_least_privilege():
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        role = await conn.fetchrow("SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles"
                                   " WHERE rolname = 'kritvia_app'")
        assert not any(role.values())
        assert not await conn.fetchval("SELECT has_schema_privilege('kritvia_app', 'public', 'CREATE')")
        owned = await conn.fetchval("SELECT count(*) FROM pg_tables t JOIN pg_roles r ON r.rolname = t.tableowner"
                                    " WHERE r.rolname = 'kritvia_app'")
        assert owned == 0
        # every table holding a tenant's data has row-level security switched on and forced
        unprotected = await conn.fetch(
            "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
            " JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped"
            " WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")
        assert [r["relname"] for r in unprotected] == []
    finally:
        await conn.close()
