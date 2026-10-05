"""Self-signup: email codes, Google sign-in, signup switch, pre-hijacking protection."""
from __future__ import annotations

import asyncio
import re
import uuid
from urllib.parse import parse_qs, urlparse

import asyncpg
import httpx

from conftest import ADMIN_DSN
from kritvia_api.config import get_settings
from kritvia_api.services.google import GoogleClient
from kritvia_api.ratelimit import signin_guard
from kritvia_api.services.mailer import get_mailer


def _email() -> str:
    return f"new-{uuid.uuid4().hex[:8]}@example.com"


def _last_code(to: str) -> str:
    msgs = [m for m in get_mailer().outbox if m["To"] == to.lower()]
    assert msgs, f"no email to {to}"
    return re.search(r"\b(\d{6})\b", msgs[-1].get_content()).group(1)


async def _sign_in(client, email: str, name: str = "") -> httpx.Response:
    r = await client.post("/auth/email/start", json={"email": email})
    assert r.status_code == 202, r.text
    return await client.post("/auth/email/verify", json={"email": email, "code": _last_code(email), "full_name": name})


async def test_email_code_creates_verified_account_then_signs_in(client):
    email = _email()
    r = await _sign_in(client, email, "Asha")
    assert r.status_code == 200, r.text
    me = (await client.get("/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})).json()
    assert me["email"] == email and me["full_name"] == "Asha"
    # second time: same account, name not overwritten
    r2 = await _sign_in(client, email.upper(), "Someone Else")
    me2 = (await client.get("/auth/me", headers={"Authorization": f"Bearer {r2.json()['access_token']}"})).json()
    assert me2["id"] == me["id"] and me2["full_name"] == "Asha"
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        row = await conn.fetchrow("SELECT email_verified_at, password_hash FROM users WHERE id = $1",
                                  uuid.UUID(me["id"]))
        hashes = await conn.fetch("SELECT code_hash FROM email_codes WHERE email = $1", email)
    finally:
        await conn.close()
    assert row["email_verified_at"] is not None and row["password_hash"] is None
    assert hashes and all(not re.fullmatch(r"\d{6}", h["code_hash"]) for h in hashes)   # never stored in clear


async def test_code_is_single_use_and_burns_after_five_wrong_tries(client):
    email = _email()
    await client.post("/auth/email/start", json={"email": email})
    code = _last_code(email)
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        r = await client.post("/auth/email/verify", json={"email": email, "code": wrong})
        assert r.status_code == 401
    r = await client.post("/auth/email/verify", json={"email": email, "code": code})
    assert r.status_code == 429                       # five failures: attempts paused for a minute
    signin_guard._mem.clear()                         # ... a minute later
    r = await client.post("/auth/email/verify", json={"email": email, "code": code})
    assert r.status_code == 401                       # and the code was burnt by the wrong guesses

    await client.post("/auth/email/start", json={"email": email})
    code = _last_code(email)
    assert (await client.post("/auth/email/verify", json={"email": email, "code": code})).status_code == 200
    assert (await client.post("/auth/email/verify", json={"email": email, "code": code})).status_code == 401


async def test_new_code_replaces_old_one(client):
    email = _email()
    await client.post("/auth/email/start", json={"email": email})
    first = _last_code(email)
    await client.post("/auth/email/start", json={"email": email})
    second = _last_code(email)
    if first != second:
        assert (await client.post("/auth/email/verify", json={"email": email, "code": first})).status_code == 401
    assert (await client.post("/auth/email/verify", json={"email": email, "code": second})).status_code == 200


async def test_code_bad_format_rejected(client):
    r = await client.post("/auth/email/verify", json={"email": _email(), "code": "12ab56"})
    assert r.status_code == 422


async def test_unverified_password_account_is_reclaimed_by_address_owner(client):
    """Someone registers the victim's address with a password first. When the real owner
    signs in with an email code, the squatter's password and sessions stop working."""
    email = _email()
    r = await client.post("/auth/register", json={"email": email, "full_name": "Squatter",
                                                  "password": "squatter password 1"})
    assert r.status_code == 201
    squat = r.json()
    await asyncio.sleep(2.1)          # access tokens carry whole seconds; the check allows 1s of skew
    owner = await _sign_in(client, email, "Owner")
    assert owner.status_code == 200
    assert (await client.post("/auth/login", json={"email": email, "password": "squatter password 1"})).status_code == 401
    assert (await client.post("/auth/refresh", json={"refresh_token": squat["refresh_token"]})).status_code == 401
    assert (await client.get("/auth/me", headers={"Authorization": f"Bearer {squat['access_token']}"})).status_code == 401
    assert (await client.get("/auth/me", headers={"Authorization": f"Bearer {owner.json()['access_token']}"})).status_code == 200


async def test_verified_account_keeps_password(client):
    email = _email()
    await _sign_in(client, email, "Ravi")
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        # set a password the normal way would need a session; set the hash directly for the test
        from kritvia_api.security import hash_password
        await conn.execute("UPDATE users SET password_hash = $1 WHERE lower(email) = $2",
                           hash_password("ravi long password"), email)
    finally:
        await conn.close()
    await _sign_in(client, email)
    assert (await client.post("/auth/login", json={"email": email, "password": "ravi long password"})).status_code == 200


async def test_signup_closed(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "signup_open", False)
    email = _email()
    r = await client.post("/auth/email/start", json={"email": email})
    assert r.status_code == 202                                   # same answer, but no email goes out
    assert not [m for m in get_mailer().outbox if m["To"] == email]
    r = await client.post("/auth/register", json={"email": email, "full_name": "X", "password": "a long password 1"})
    assert r.status_code == 403


# ------------------------------------------------------------------ Google sign-in --
class FakeGoogleSignin:
    def __init__(self, sub="g-1", email="g@example.com", verified=True, name="Gita"):
        self.profile = {"sub": sub, "email": email, "email_verified": verified, "name": name}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://oauth2.googleapis.com/token"):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600, "id_token": "x"})
        if "userinfo" in url:
            return httpx.Response(200, json=self.profile)
        return httpx.Response(404)


async def _google_flow(client, nonce="n" * 40, complete_nonce=None):
    r = await client.post("/auth/google/start", json={"nonce": nonce})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    q = parse_qs(urlparse(url).query)
    assert q["scope"] == ["openid email profile"] and "access_type" not in q
    return await client.post("/auth/google/complete",
                             json={"code": "c", "state": q["state"][0], "nonce": complete_nonce or nonce})


async def test_google_signin_creates_then_links(client, services, monkeypatch):
    email = _email()
    fake = FakeGoogleSignin(sub="sub-" + uuid.uuid4().hex, email=email)
    monkeypatch.setattr(services, "google", GoogleClient("cid", "cs", "http://test/cb", transport=httpx.MockTransport(fake)))
    r = await _google_flow(client)
    assert r.status_code == 200, r.text
    me = (await client.get("/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})).json()
    assert me["email"] == email and me["full_name"] == "Gita"
    # the same address via email code is the same account
    r2 = await _sign_in(client, email)
    me2 = (await client.get("/auth/me", headers={"Authorization": f"Bearer {r2.json()['access_token']}"})).json()
    assert me2["id"] == me["id"]


async def test_google_signin_links_existing_email_account(client, services, monkeypatch):
    email = _email()
    first = await _sign_in(client, email, "Existing")
    uid = (await client.get("/auth/me", headers={"Authorization": f"Bearer {first.json()['access_token']}"})).json()["id"]
    fake = FakeGoogleSignin(sub="sub-" + uuid.uuid4().hex, email=email)
    monkeypatch.setattr(services, "google", GoogleClient("cid", "cs", "http://test/cb", transport=httpx.MockTransport(fake)))
    r = await _google_flow(client)
    me = (await client.get("/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})).json()
    assert me["id"] == uid
    # another Google account claiming the same email cannot take it over
    fake.profile["sub"] = "different-" + uuid.uuid4().hex
    assert (await _google_flow(client)).status_code == 403


async def test_google_signin_refuses_unverified_email_and_wrong_browser(client, services, monkeypatch):
    fake = FakeGoogleSignin(sub="sub-" + uuid.uuid4().hex, email=_email(), verified=False)
    monkeypatch.setattr(services, "google", GoogleClient("cid", "cs", "http://test/cb", transport=httpx.MockTransport(fake)))
    assert (await _google_flow(client)).status_code == 502
    fake.profile["email_verified"] = True
    assert (await _google_flow(client, complete_nonce="x" * 40)).status_code == 400
    r = await client.post("/auth/google/complete", json={"code": "c", "state": "forged", "nonce": "n" * 40})
    assert r.status_code == 400


async def test_google_signin_unconfigured(client, services, monkeypatch):
    monkeypatch.setattr(services, "google", GoogleClient("", "", "http://test/cb"))
    assert (await client.post("/auth/google/start", json={"nonce": "n" * 40})).status_code == 503


async def test_forgot_password_resets_and_signs_other_sessions_out(client):
    email = _email()
    r = await client.post("/auth/register", json={"email": email, "full_name": "Pat", "password": "old-password-123"})
    assert r.status_code == 201, r.text
    old_refresh = r.json()["refresh_token"]
    # the code proves the address; a wrong code is refused
    await client.post("/auth/email/start", json={"email": email})
    code = _last_code(email)
    bad = await client.post("/auth/password/reset", json={"email": email, "code": "000000" if code != "000000" else "111111",
                                                          "new_password": "brand-new-password-9"})
    assert bad.status_code == 401
    ok = await client.post("/auth/password/reset", json={"email": email, "code": code, "new_password": "brand-new-password-9"})
    assert ok.status_code == 200, ok.text
    assert (await client.post("/auth/login", json={"email": email, "password": "old-password-123"})).status_code == 401
    assert (await client.post("/auth/login", json={"email": email, "password": "brand-new-password-9"})).status_code == 200
    # the earlier session is gone
    assert (await client.post("/auth/refresh", json={"refresh_token": old_refresh})).status_code == 401
    # codes are single use, and unknown addresses are not created by a reset
    again = await client.post("/auth/password/reset", json={"email": email, "code": code, "new_password": "brand-new-password-9"})
    assert again.status_code == 401
    ghost = _email()
    await client.post("/auth/email/start", json={"email": ghost})
    r = await client.post("/auth/password/reset", json={"email": ghost, "code": _last_code(ghost), "new_password": "brand-new-password-9"})
    assert r.status_code == 404
