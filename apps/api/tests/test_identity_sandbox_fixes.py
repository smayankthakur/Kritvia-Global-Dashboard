"""Test report round 2, identity and sandbox findings: spoofable Gmail sender checks (S4), the remaining outbound
address checks (S8), QR sign-in location and number matching (S13), call-stream links that expire (S14), mail
sent straight to a forwarding address (S15), no log-only mail in production (S17), Kritvia staff as a database
role (S18), coupon industries fixed at setup (S19), and hosted-app approvals pinned to what was reviewed (S6)."""
from __future__ import annotations

import json
import logging
import uuid

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, make_actor
from kritvia_api.config import get_settings
from kritvia_api.services import email_in
from kritvia_api.services.google import sender_authenticated

pytestmark = pytest.mark.asyncio


async def sql(q: str, *args):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(q, *args)
    finally:
        await conn.close()


# --------------------------------------------------------------------------- S4: Gmail's verdict --
async def test_only_gmails_own_header_about_the_from_domain_counts():
    gmail = "mx.google.com; dkim=pass header.i=@hdfcbank.net; spf=pass; dmarc=pass (p=REJECT) header.from=hdfcbank.net"
    assert sender_authenticated([gmail], "alerts@hdfcbank.net")
    # a sender's own Authentication-Results further down is ignored: Gmail's (on top) says it failed
    forged = "mx.google.com; dkim=pass header.i=@hdfcbank.net; dmarc=pass header.from=hdfcbank.net"
    top = "mx.google.com; dkim=none; spf=softfail; dmarc=fail (p=NONE) header.from=hdfcbank.net"
    assert not sender_authenticated([top, forged], "alerts@hdfcbank.net")
    # signed by the attacker's own domain while From shows a bank: not about the From domain
    own = "mx.google.com; dkim=pass header.i=@cheap-mailer.biz; spf=pass smtp.mailfrom=cheap-mailer.biz"
    assert not sender_authenticated([own], "alerts@hdfcbank.net")
    # a header some other server wrote isn't Gmail's
    assert not sender_authenticated(["mx.evil.example; dmarc=pass header.from=hdfcbank.net"], "alerts@hdfcbank.net")
    # subdomain alignment (relaxed), as DMARC allows
    assert sender_authenticated(["mx.google.com; dkim=pass header.d=mail.hdfcbank.net"], "alerts@hdfcbank.net")


# ----------------------------------------------------------------------------- S8: speech servers --
async def test_a_speech_server_address_is_judged_like_every_other_outbound_address():
    from pydantic import ValidationError

    from kritvia_api.routers.calls import KeyIn
    for bad in ("https://[64:ff9b::a9fe:a9fe]/v1", "https://[::ffff:10.0.0.1]/v1", "https://169.254.169.254/v1",
                "https://printer.local/v1"):
        with pytest.raises(ValidationError):
            KeyIn(key="sk-12345678", base_url=bad)
    assert KeyIn(key="sk-12345678", base_url="https://speech.example.com/v1").base_url == "https://speech.example.com/v1"


async def test_a_speech_server_name_that_points_inside_is_refused_when_connecting(monkeypatch):
    from kritvia_api.services import mcp, voice_speech as vs

    async def inside(host):
        return ["64:ff9b::a00:5"]                 # NAT64 form of 10.0.0.5
    monkeypatch.setattr(mcp, "resolve", inside)
    stack = vs.Stack(stt="openai", tts="openai", keys={"openai": ("sk-x", "https://speech.example.com/v1")})
    with pytest.raises(vs.SpeechError) as e:
        await vs.synthesize(stack, "Namaste", 16000)
    assert "public internet" in str(e.value)


async def test_the_contact_email_finder_never_reaches_inside(monkeypatch):
    from kritvia_api.services import contact_email as ce

    async def nat64(host):
        return ["64:ff9b::7f00:1"]                # NAT64 form of 127.0.0.1
    monkeypatch.setattr(ce, "resolve", nat64)
    assert await ce.public("https://shop.example.com/") is False
    assert await ce.find("shop.example.com") is None


# ------------------------------------------------------------------------------ S13: QR sign-in --
PHONE = {"user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36"}


async def test_a_login_page_qr_shows_where_it_is_and_a_wrong_number_refuses_it(client):
    me = await make_actor(client, "qr-match")
    away = {"cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "NG", "cf-ipcity": "Lagos"}
    req = (await client.post("/auth/link/request", headers=away)).json()
    assert len(req["match"]) == 2
    home = {**me.h, **PHONE, "cf-connecting-ip": "49.36.10.20"}
    peek = (await client.post("/auth/link/peek", json={"token": req["token"]}, headers=home)).json()
    assert peek["place"] == "Lagos, NG" and peek["ip"] == "203.0.113.9" and peek["same_network"] is False
    assert req["match"] in peek["options"] and len(set(peek["options"])) == 3
    wrong = next(o for o in peek["options"] if o != req["match"])
    r = await client.post("/auth/link/answer", json={"token": req["token"], "approve": True, "match": wrong}, headers=home)
    assert r.status_code == 409 and "number" in r.text
    # the link is refused for good: the right number afterwards doesn't help, and nobody gets signed in
    r = await client.post("/auth/link/answer", json={"token": req["token"], "approve": True, "match": req["match"]},
                          headers=home)
    assert r.status_code == 410
    assert (await client.post("/auth/link/redeem", json={"token": req["token"], "secret": req["secret"]})).status_code == 403


async def test_the_same_network_is_told_apart_from_another():
    from kritvia_api.routers.device_link import _options, _same_network
    assert _same_network("49.36.10.20", "49.36.10.99") is True
    assert _same_network("49.36.10.20", "49.36.11.20") is False
    assert _same_network(None, "49.36.10.20") is None
    assert _options("47", "tok") == _options("47", "tok") and "47" in _options("47", "tok")


# ---------------------------------------------------------------------------- S14: stream links --
async def test_a_stream_link_expires_and_is_bound_to_its_call():
    from kritvia_api.services import voice_calls as vc
    c, call = uuid.uuid4(), uuid.uuid4()
    sig = vc.stream_link_sig(c, call, now=1_000_000)
    assert vc.stream_link_ok(c, call, sig, now=1_000_100)
    assert not vc.stream_link_ok(c, call, sig, now=1_000_000 + vc.STREAM_LINK_S + 1)     # expired
    assert not vc.stream_link_ok(c, uuid.uuid4(), sig, now=1_000_100)                     # another call
    assert not vc.stream_link_ok(c, call, sig.split(".")[1], now=1_000_100)               # no expiry in it
    far = vc.stream_link_sig(c, call, now=2_000_000)
    assert not vc.stream_link_ok(c, call, far, now=1_000_100)                             # too far ahead


async def test_secrets_in_request_addresses_never_reach_the_logs():
    from kritvia_api import logredact
    rec = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/1.1" %d',
                            ("1.2.3.4", "GET", "/hooks/voice/stream/exotel/abc?k=SUPERSECRET&sample-rate=16000", 101),
                            None)
    logredact.RedactFilter().filter(rec)
    assert "SUPERSECRET" not in rec.getMessage() and "sample-rate=16000" in rec.getMessage()
    assert "s1g" not in logredact.redact("/hooks/voice/exotel/x/status?call=1&sig=s1g")


# ---------------------------------------------------------------------- S15: mail straight in --
CF_PASS = ("i=1; mx.cloudflare.net; dkim=pass header.d=google.com; spf=pass smtp.mailfrom=google.com;"
           " dmarc=pass header.from=google.com")


async def test_cloudflares_verdict_is_read_from_its_own_topmost_header():
    assert email_in.cloudflare_auth([CF_PASS], "forwarding-noreply@google.com") == "pass"
    fail = "i=1; mx.cloudflare.net; dkim=none; spf=fail; dmarc=fail header.from=google.com"
    assert email_in.cloudflare_auth([fail, CF_PASS], "forwarding-noreply@google.com") == "fail"
    assert email_in.cloudflare_auth([], "forwarding-noreply@google.com") == "unknown"


def _confirmation(code: str, mailbox: str, auth: str | None) -> bytes:
    from email.message import EmailMessage
    m = EmailMessage()
    if auth:
        m["ARC-Authentication-Results"] = auth
    m["From"], m["To"] = "Gmail Team <forwarding-noreply@google.com>", "x@in.example.com"
    m["Subject"] = f"(#{code}) Gmail Forwarding Confirmation - Receive Mail from {mailbox}"
    m["Message-ID"] = f"<{uuid.uuid4().hex}@google.com>"
    m.set_content(f"{mailbox} has requested to automatically forward mail to your email address.\n"
                  f"Confirmation code: {code}\n")
    return m.as_bytes()


async def test_a_fake_gmail_confirmation_cant_replace_a_waiting_one(world, client, monkeypatch):
    from test_email_forwarding import DOMAIN, SECRET, signed
    s = get_settings()
    monkeypatch.setattr(s, "inbound_email_domain", DOMAIN)
    monkeypatch.setattr(s, "inbound_email_secret", SECRET)
    m = world["mayank"]
    v = (await m.post(f"/orgs/{world['org']}/ventures", json={"name": "Mail", "slug": f"m-{uuid.uuid4().hex[:6]}"})).json()["id"]
    address = (await m.post(f"/ventures/{v}/connectors/email-forwarding")).json()["address"]
    assert len(address.split("@")[0].rsplit("-", 1)[1]) == 32               # 128 random bits in new addresses
    real = _confirmation("481516234", "owner@gmail.com", CF_PASS)
    assert (await client.post("/public/email-in", content=real, headers=signed(real, address))).json()["confirmation"]
    # sent straight to the address with no Cloudflare verdict: it doesn't replace the waiting code
    fake = _confirmation("999999999", "attacker@gmail.com", None)
    r = await client.post("/public/email-in", content=fake, headers=signed(fake, address))
    assert r.json()["confirmation"] is False
    # and with a failing verdict it isn't even treated as a confirmation
    failing = _confirmation("888888888", "attacker@gmail.com",
                            "i=1; mx.cloudflare.net; dkim=none; spf=fail; dmarc=fail header.from=google.com")
    assert email_in.gmail_confirmation(email_in.parse(failing)) is None
    got = (await m.get(f"/ventures/{v}/connectors/email-forwarding")).json()
    assert got["gmail_code"] == "481516234" and got["gmail_mailbox"] == "owner@gmail.com"


async def test_a_bill_sent_straight_to_the_address_is_marked_unverified():
    from kritvia_api.services.pollers import _sender_checked
    raw = _confirmation("1", "a@b.in", None)
    msg = email_in.parse(raw)
    assert _sender_checked(msg) is False
    msg.headers["x-forwarded-for"] = "owner@gmail.com x@in.example.com"
    msg.authenticated = True
    assert _sender_checked(msg) is True


# --------------------------------------------------------------------------- S17: no log mail --
async def test_production_never_writes_mail_to_the_logs(monkeypatch):
    from kritvia_api.main import check_production_config
    s = get_settings()
    monkeypatch.setattr(s, "environment", "production")
    monkeypatch.setattr(s, "mail_transport", "log")
    monkeypatch.setattr(s, "signup_open", False)                 # even with sign-up closed
    with pytest.raises(RuntimeError) as e:
        check_production_config()
    assert "MAIL_TRANSPORT=log" in str(e.value)


async def test_log_mail_hides_codes_and_token_links():
    from kritvia_api.services.mailer import _mask
    out = _mask("Your code is 481516.\nOr open https://app.example.com/reset?token=abc123 to reset.")
    assert "481516" not in out and "abc123" not in out


# ----------------------------------------------------------------------- S18: staff in the DB --
async def test_staff_functions_check_the_caller_themselves(client, monkeypatch):
    who = await make_actor(client, "not-staff")
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SET ROLE kritvia_app")
        await conn.execute("SELECT set_config('app.user_id', $1, false)", str(who.id))
        for q in ("SELECT * FROM private.staff_coupons()", "SELECT * FROM private.catalog_all()",
                  "SELECT * FROM private.pilot_health()", "SELECT * FROM private.staff_partners()"):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.fetch(q)
        # the bodies under their new names can't be called by the app at all
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.fetch("SELECT * FROM private.staff_coupons_unchecked()")
        # and the app can only record the signed-in person, never someone else
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.fetch("SELECT private.staff_sync($1, true)", uuid.uuid4())
    finally:
        await conn.close()


async def test_a_staff_account_needs_a_verified_email(client, monkeypatch):
    who = await make_actor(client, "staff-unverified")
    await sql("UPDATE users SET email_verified_at = NULL WHERE id = $1", who.id)
    monkeypatch.setattr(get_settings(), "staff_emails", who.email)
    assert (await who.get("/staff/coupons")).status_code == 404
    await sql("UPDATE users SET email_verified_at = now() WHERE id = $1", who.id)
    assert (await who.get("/staff/coupons")).status_code == 200
    monkeypatch.setattr(get_settings(), "staff_emails", "someone-else@example.com")
    assert (await who.get("/staff/coupons")).status_code == 404       # taken off STAFF_EMAILS: no longer staff
    assert not (await sql("SELECT 1 FROM private.kritvia_staff WHERE user_id = $1", who.id))


# -------------------------------------------------------------------- S6: hosted-app approvals --
async def test_a_resubmission_cant_rewrite_a_waiting_or_approved_app():
    cid = f"github:acme/tools-{uuid.uuid4().hex[:6]}"
    a, b = (await make_actor_ids())
    base = {"id": cid, "source": "github", "kind": "hosted", "title": "tools", "status": "pending",
            "package": {"registryType": "npm", "identifier": "@acme/tools", "version": "1.0.0", "env": []}}
    await sql("SELECT private.catalog_upsert($1::jsonb)", json.dumps({**base, "submitted_by": str(a)}))
    swap = {**base, "title": "tools (new)", "submitted_by": str(b),
            "package": {"registryType": "npm", "identifier": "@evil/tools", "version": "6.6.6", "env": []}}
    await sql("SELECT private.catalog_upsert($1::jsonb)", json.dumps(swap))
    row = (await sql("SELECT title, package->>'identifier' AS ident FROM app_catalog WHERE id = $1", cid))[0]
    assert (row["title"], row["ident"]) == ("tools", "@acme/tools")
    # the first submitter can still refresh it while it waits
    await sql("SELECT private.catalog_upsert($1::jsonb)", json.dumps({**base, "submitted_by": str(a),
              "package": {**base["package"], "version": "1.0.1"}}))
    assert (await sql("SELECT package->>'version' AS v FROM app_catalog WHERE id = $1", cid))[0]["v"] == "1.0.1"


async def make_actor_ids() -> tuple[uuid.UUID, uuid.UUID]:
    rows = await sql("SELECT id FROM users WHERE NOT is_service ORDER BY created_at LIMIT 2")
    return rows[0]["id"], rows[1]["id"]


async def test_an_approval_is_pinned_to_the_registrys_fingerprint(monkeypatch):
    from kritvia_api.services import github_install as gi
    from kritvia_api.services.mcp import McpError
    sri = "sha512-" + "B" * 86 + "=="

    def registry(request: httpx.Request) -> httpx.Response:
        if request.url.host == "registry.npmjs.org":
            return httpx.Response(200, json={"versions": {"1.4.0": {"dist": {"integrity": sri}}}})
        if request.url.host == "pypi.org":
            return httpx.Response(200, json={"urls": [
                {"filename": "acme_mcp-2.0.tar.gz", "packagetype": "sdist", "digests": {"sha256": "c" * 64}},
                {"filename": "acme_mcp-2.0-py3-none-any.whl", "packagetype": "bdist_wheel",
                 "digests": {"sha256": "d" * 64}}]})
        return httpx.Response(404)
    monkeypatch.setattr(gi, "transport", httpx.MockTransport(registry))
    npm = await gi.pin({"registryType": "npm", "identifier": "@acme/crm", "version": "1.4.0", "env": []})
    assert npm["integrity"] == sri
    py = await gi.pin({"registryType": "pypi", "identifier": "acme-mcp", "version": "2.0", "env": []})
    assert py["integrity"] == "sha256:" + "d" * 64 and py["file"].endswith("none-any.whl")
    with pytest.raises(McpError):                                     # "latest" is never approved
        await gi.pin({"registryType": "npm", "identifier": "@acme/crm", "version": "latest", "env": []})
    with pytest.raises(McpError):                                     # an image only by digest
        await gi.pin({"registryType": "oci", "identifier": "ghcr.io/acme/mcp", "version": "1.0", "env": []})
    oci = await gi.pin({"registryType": "oci", "identifier": "ghcr.io/acme/mcp", "version": "sha256:" + "e" * 64,
                        "env": []})
    assert oci["integrity"] == "sha256:" + "e" * 64
    assert gi.package_hash(npm) != gi.package_hash({**npm, "version": "1.4.1"})


# ------------------------------------------------------------------- S19: coupon industry fixed --
async def test_the_industry_a_business_chose_first_is_what_coupons_see(world):
    m = world["mayank"]
    v = (await m.post(f"/orgs/{world['org']}/ventures", json={"name": "Agency", "slug": f"ag-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await m.put(f"/ventures/{v}/settings", json={"kind": "software", "industry": "agency"})
    await m.put(f"/ventures/{v}/settings", json={"kind": "kitchen", "industry": "kitchen"})
    row = (await sql("SELECT industry, coupon_industry FROM venture_settings WHERE venture_id = $1", uuid.UUID(v)))[0]
    assert (row["industry"], row["coupon_industry"]) == ("kitchen", "agency")
