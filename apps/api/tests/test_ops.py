"""Connectors (Google OAuth + Gmail polling, signed webhooks), DPDP requests,
dashboard, session security and the worker's scheduled jobs."""
from __future__ import annotations

import base64
import io
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN

from kritvia_api.services.google import GoogleClient
from kritvia_api.routers.connectors import sign

IST = timezone(timedelta(hours=5, minutes=30))


# ------------------------------------------------------------------ webhooks --
async def test_signed_webhook_starts_lead_triage(world, client, fake_llm):
    mayank, v = world["mayank"], world["site"]
    fake_llm.on("You triage inbound inquiries", {"summary": "wants VAPT", "requirements": ["VAPT"],
                                                  "scope": [], "urgency": "medium"})
    fake_llm.on("proposal writer", {"subject": "s", "email_body": "b", "proposal": "p", "used_sources": []})
    hook = (await mayank.post(f"/ventures/{v}/connectors/webhook")).json()
    assert hook["secret"].startswith("whsec_")
    assert (await world["alice"].post(f"/ventures/{v}/connectors/webhook")).status_code == 404  # admins only
    path = urlparse(hook["url"]).path
    body = json.dumps({"name": "Kiran", "email": "kiran@bank.example", "company": "Bank", "message": "Need VAPT"}).encode()
    ts = str(int(time.time()))
    ok = await client.post(path, content=body, headers={"X-Kritvia-Timestamp": ts,
                                                        "X-Kritvia-Signature": sign(hook["secret"], ts, body)})
    assert ok.status_code == 202 and ok.json()["run_id"], ok.text
    dup = await client.post(path, content=body, headers={"X-Kritvia-Timestamp": ts,
                                                         "X-Kritvia-Signature": sign(hook["secret"], ts, body)})
    assert dup.json()["duplicate"] is True
    bad = await client.post(path, content=body, headers={"X-Kritvia-Timestamp": ts, "X-Kritvia-Signature": "sha256=00"})
    assert bad.status_code == 401
    old = str(int(time.time()) - 600)
    stale = await client.post(path, content=body, headers={"X-Kritvia-Timestamp": old,
                                                           "X-Kritvia-Signature": sign(hook["secret"], old, body)})
    assert stale.status_code == 401
    assert (await client.post(path, content=body)).status_code == 401
    keyed = await client.post(path, content=body.replace(b"Kiran", b"Kiran2"), headers={"X-Kritvia-Key": hook["secret"]})
    assert keyed.status_code == 202
    assert (await client.post(f"/hooks/{uuid.uuid4()}", content=body)).status_code == 404
    run = (await mayank.get(f"/ventures/{v}/runs/{ok.json()['run_id']}")).json()
    assert run["trigger_kind"] == "webhook"


# -------------------------------------------------------------------- Google --
class FakeGoogle:
    def __init__(self):
        self.sent: list[dict] = []
        self.messages = {
            "m1": self._msg("m1", "Neha <neha@retail.example>", "Website for 12 stores",
                            "We need an ecommerce site and inventory automation."),
        }

    @staticmethod
    def _msg(mid, sender, subject, body):
        return {"id": mid, "threadId": "t-" + mid, "snippet": body[:50], "payload": {
            "headers": [{"name": "From", "value": sender}, {"name": "Subject", "value": subject},
                        {"name": "To", "value": "hello@sitelytc.com"}],
            "mimeType": "text/plain", "body": {"data": base64.urlsafe_b64encode(body.encode()).decode()}}}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://oauth2.googleapis.com/token"):
            form = parse_qs(request.content.decode())
            if form["grant_type"] == ["authorization_code"]:
                return httpx.Response(200, json={"access_token": "at", "refresh_token": "rt-123", "expires_in": 3600,
                                                 "scope": "openid email https://www.googleapis.com/auth/gmail.readonly "
                                                          "https://www.googleapis.com/auth/gmail.send "
                                                          "https://www.googleapis.com/auth/calendar.events"})
            assert form["refresh_token"] == ["rt-123"]
            return httpx.Response(200, json={"access_token": "at2", "expires_in": 3600})
        if "userinfo" in url:
            return httpx.Response(200, json={"email": "hello@sitelytc.com"})
        if url.endswith("/messages/send"):
            self.sent.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "sent-1"})
        if "/messages?" in url:
            return httpx.Response(200, json={"messages": [{"id": k} for k in self.messages]})
        if "/messages/" in url:
            mid = url.split("/messages/")[1].split("?")[0]
            return httpx.Response(200, json=self.messages[mid])
        if "calendar/v3" in url:
            return httpx.Response(200, json={"id": "ev1", "htmlLink": "https://cal/ev1"})
        return httpx.Response(404)


async def test_google_oauth_gmail_poll_and_real_send(world, client, services, fake_llm, monkeypatch):
    mayank, v = world["mayank"], world["site"]
    fake = FakeGoogle()
    g = GoogleClient("cid", "csecret", "http://test/connectors/google/callback", transport=httpx.MockTransport(fake))
    monkeypatch.setattr(services, "google", g)
    monkeypatch.setattr(services.messaging, "google", g)

    nonce = "n" * 40
    url = (await mayank.post(f"/ventures/{v}/connectors/google/start", json={"nonce": nonce})).json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    assert "access_type=offline" in url
    # a victim (or anyone else) completing the attacker's link is refused: wrong user / no nonce
    victim = world["alice"]
    r = await victim.post("/connectors/google/complete", json={"code": "abc", "state": state, "nonce": nonce})
    assert r.status_code == 403
    r = await mayank.post("/connectors/google/complete", json={"code": "abc", "state": state, "nonce": "x" * 40})
    assert r.status_code == 403
    r = await mayank.post("/connectors/google/complete", json={"code": "abc", "state": "forged", "nonce": nonce})
    assert r.status_code == 400
    r = await mayank.post("/connectors/google/complete", json={"code": "abc", "state": state, "nonce": nonce})
    assert r.status_code == 200 and r.json()["account_email"] == "hello@sitelytc.com", r.text
    conns = (await mayank.get(f"/ventures/{v}/connectors")).json()
    gconn = [c for c in conns if c["provider"] == "google"][0]
    assert gconn["account_email"] == "hello@sitelytc.com"
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        stored = await conn.fetchval("SELECT secret_enc FROM connector_tokens WHERE connector_id = $1",
                                     uuid.UUID(gconn["id"]))
    finally:
        await conn.close()
    assert b"rt-123" not in stored

    await mayank.put(f"/ventures/{v}/workflow-configs/lead_triage", json={"enabled": True})
    fake_llm.on("You triage inbound inquiries", {"summary": "ecommerce", "requirements": ["site"], "scope": [],
                                                  "urgency": "high", "company": "Retail Co"})
    fake_llm.on("proposal writer", {"subject": "Proposal", "email_body": "Hi Neha", "proposal": "Plan",
                                    "used_sources": []})
    synced = (await mayank.post(f"/ventures/{v}/connectors/google/sync")).json()
    assert synced["started"] == {"lead_triage": 1}
    again = (await mayank.post(f"/ventures/{v}/connectors/google/sync")).json()
    assert again["started"] == {}                                 # same message is never processed twice

    pending = [a for a in (await mayank.get("/approvals/inbox")).json()
               if a["payload"].get("to") == "neha@retail.example"]
    assert pending and pending[0]["payload"]["thread_id"] == "t-m1"
    assert (await mayank.post(f"/ventures/{v}/approvals/{pending[0]['id']}/decision",
                              json={"decision": "approve"})).status_code == 200
    assert len(fake.sent) == 1 and fake.sent[0]["threadId"] == "t-m1"   # really sent through Gmail, in-thread
    raw = base64.urlsafe_b64decode(fake.sent[0]["raw"]).decode()
    assert "To: neha@retail.example" in raw and "From: hello@sitelytc.com" in raw


# ---------------------------------------------------------------- DPDP --
async def test_dpdp_access_and_erasure(world, fake_llm):
    mayank, bob, tru = world["mayank"], world["bob"], world["tru"]
    app = (await bob.post(f"/ventures/{tru}/loan-applications", json={
        "loan_type": "home_loan", "applicant": {"name": "Meera Iyer", "email": "meera@example.in"},
        "consent": {"notice_version": "v2"}})).json()
    files = [("files", ("id.txt", io.BytesIO(b"Name Meera Iyer PAN ABCPI1234K"), "text/plain"))]
    await bob.post(f"/ventures/{tru}/loan-applications/{app['id']}/documents?verify=false", files=files)

    req = (await bob.post(f"/ventures/{tru}/dpdp-requests", json={"identifier": "Meera@Example.in", "kind": "access"})).json()
    assert req["principal_label"] == "m***@example.in" and not req["overdue"]
    assert (await bob.post(f"/ventures/{tru}/dpdp-requests/{req['id']}/execute")).status_code == 404  # admin only
    out = (await mayank.post(f"/ventures/{tru}/dpdp-requests/{req['id']}/execute")).json()
    assert out["request"]["status"] == "completed"
    # the owner is not a loan officer: loan files are counted, never exported to them
    assert out["export"]["loan_applications"] == [] and "Meera" not in json.dumps(out)
    assert out["request"]["result"] == {"documents": 0, "loan_applications": 0, "leads": 0, "consents": 1,
                                        "restricted_not_exported": 2}

    er = (await bob.post(f"/ventures/{tru}/dpdp-requests", json={"identifier": "meera@example.in",
                                                                  "kind": "erasure"})).json()
    done = (await mayank.post(f"/ventures/{tru}/dpdp-requests/{er['id']}/execute")).json()
    assert done["request"]["result"]["documents"] == 1 and done["request"]["result"]["loan_applications"] == 1
    assert app["id"] not in [a["id"] for a in (await bob.get(f"/ventures/{tru}/loan-applications")).json()]
    again = await mayank.post(f"/ventures/{tru}/dpdp-requests/{er['id']}/execute")
    assert again.status_code == 409
    consents = (await bob.get(f"/ventures/{tru}/consents?identifier=meera@example.in")).json()
    assert consents and all(c["withdrawn_at"] for c in consents)     # kept as evidence, withdrawn


async def test_retention_policy_and_purge(world):
    mayank, alice, v = world["mayank"], world["alice"], world["site"]
    r = await mayank.put(f"/ventures/{v}/retention", json={"data_class": "note", "retain_days": 1})
    assert r.status_code == 200
    doc = (await alice.post(f"/ventures/{v}/notes", json={"title": "temp", "text": "short lived note abc"})).json()
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        dl = await conn.fetchval("SELECT delete_after FROM documents WHERE id = $1", uuid.UUID(doc["document_id"]))
        assert dl is not None
        await conn.execute("UPDATE documents SET delete_after = now() - interval '1 minute' WHERE id = $1",
                           uuid.UUID(doc["document_id"]))
    finally:
        await conn.close()
    from kritvia_worker.main import purge_expired
    assert await purge_expired({}) >= 1
    assert (await alice.get(f"/ventures/{v}/documents/{doc['document_id']}")).status_code == 404
    await mayank.put(f"/ventures/{v}/retention", json={"data_class": "note", "retain_days": 3650})


# ------------------------------------------------------------- dashboard --
async def test_dashboard_and_usage(world):
    mayank, alice, org = world["mayank"], world["alice"], world["org"]
    d = (await mayank.get(f"/orgs/{org}/dashboard")).json()
    names = {c["name"] for c in d["ventures"]}
    assert {"Sitelytc", "Truhome"} <= names
    site = [c for c in d["ventures"] if c["name"] == "Sitelytc"][0]
    assert "leads" in site["metrics"] and site["model_calls_7d"]["calls"] >= 1
    # Alice's dashboard shows only what she can read
    assert {c["name"] for c in (await alice.get(f"/orgs/{org}/dashboard")).json()["ventures"]} == {"Sitelytc"}
    assert (await world["mallory"].get(f"/orgs/{org}/dashboard")).status_code == 404
    usage = (await alice.get(f"/ventures/{world['site']}/usage")).json()
    assert usage and {"tier", "calls", "rate_limited"} <= set(usage[0])
    tiers = {t["tier"]: t for t in (await alice.get("/tiers")).json()}
    assert all(c["sensitive_allowed"] == "true" for c in tiers["private"]["chain"])


# --------------------------------------------------------------- sessions --
async def test_refresh_rotation_and_reuse_detection(client):
    email = f"sess-{uuid.uuid4().hex[:6]}@example.com"
    t = (await client.post("/auth/register", json={"email": email, "full_name": "S",
                                                   "password": "correct horse battery"})).json()
    r1 = t["refresh_token"]
    t2 = (await client.post("/auth/refresh", json={"refresh_token": r1})).json()
    assert t2["refresh_token"] != r1 and t2["access_token"]
    # replaying the used token revokes the whole family, including the new one
    assert (await client.post("/auth/refresh", json={"refresh_token": r1})).status_code == 401
    assert (await client.post("/auth/refresh", json={"refresh_token": t2["refresh_token"]})).status_code == 401
    # logout revokes
    t3 = (await client.post("/auth/login", json={"email": email, "password": "correct horse battery"})).json()
    await client.post("/auth/logout", json={"refresh_token": t3["refresh_token"]})
    assert (await client.post("/auth/refresh", json={"refresh_token": t3["refresh_token"]})).status_code == 401
    # password change signs out other sessions
    t4 = (await client.post("/auth/login", json={"email": email, "password": "correct horse battery"})).json()
    h = {"Authorization": f"Bearer {t4['access_token']}"}
    assert (await client.post("/auth/password", headers=h, json={"current_password": "wrong", "new_password":
                                                                 "another long passphrase"})).status_code == 401
    assert (await client.post("/auth/password", headers=h, json={"current_password": "correct horse battery",
                                                                 "new_password": "another long passphrase"})
            ).status_code == 200
    assert (await client.post("/auth/refresh", json={"refresh_token": t4["refresh_token"]})).status_code == 401
    assert (await client.post("/auth/login", json={"email": email, "password": "another long passphrase"})
            ).status_code == 200


async def test_service_accounts_cannot_log_in(world):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        email = await conn.fetchval("SELECT email FROM users WHERE is_service LIMIT 1")
    finally:
        await conn.close()
    app_conn = await asyncpg.connect(ADMIN_DSN.replace("postgres:postgres", "kritvia_app:app"))
    try:
        row = await app_conn.fetchrow("SELECT * FROM auth_lookup($1)", email)
    finally:
        await app_conn.close()
    assert row["password_hash"] is None and row["is_active"] is False


async def test_login_rate_limit(client, monkeypatch):
    from kritvia_api.config import get_settings
    monkeypatch.setattr(get_settings(), "auth_rate_limit_per_minute", 3)
    email = f"rl-{uuid.uuid4().hex[:6]}@example.com"
    ip = {"cf-connecting-ip": f"203.0.113.{uuid.uuid4().int % 250}"}
    codes = [(await client.post("/auth/login", headers=ip,
                                json={"email": email, "password": "nope nope nope"})).status_code for _ in range(5)]
    assert codes[:3] == [401, 401, 401] and codes[-1] == 429


async def test_security_headers(client):
    r = await client.get("/healthz")
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"
    assert (await client.get("/readyz")).json()["migrations"] >= 5


# ----------------------------------------------------------------- worker --
async def test_scheduled_kitchen_run_fires_once(world, services):
    from kritvia_worker.main import fire_schedules, morning_check
    mayank, org = world["mayank"], world["org"]
    v = (await mayank.post(f"/orgs/{org}/ventures", json={"name": "Kitchen 2", "slug": "kitchen-two"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "kitchen"})
    await mayank.put(f"/ventures/{v}/workflow-configs/kitchen_daily", json={"enabled": True, "schedule": "23:30"})
    at = datetime(2026, 10, 1, 23, 30, tzinfo=IST)
    ctx = {"services": services}
    assert await fire_schedules(ctx, at) >= 1
    assert await fire_schedules(ctx, at) == 0                       # idempotent within the minute
    runs = (await mayank.get(f"/ventures/{v}/runs?workflow=kitchen_daily")).json()
    assert runs[0]["trigger_kind"] == "schedule" and runs[0]["outcome"] == "no_reference_data"
    assert not [a for a in await morning_check(ctx) if v in a]      # the overnight run exists
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE workflow_runs SET status = 'failed' WHERE id = $1", uuid.UUID(runs[0]["id"]))
    finally:
        await conn.close()
    alerts = await morning_check(ctx)
    assert any(v in a and "failed" in a for a in alerts)


async def test_expired_approval_wakes_run(world, services):
    from kritvia_worker.main import expire_approvals
    from kritvia_api.engine.runner import start_run
    import tests_support_flow  # noqa: F401  (registers test_flow if the engine tests did not)
    run_id = await start_run(services, actor_user_id=world["alice"].id, venture_id=uuid.UUID(world["site"]),
                             workflow="test_flow", input={})
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE approvals SET expires_at = now() - interval '1 minute' WHERE run_id = $1", run_id)
        assert await expire_approvals({"services": services}) >= 1
        row = await conn.fetchrow("SELECT status, outcome FROM workflow_runs WHERE id = $1", run_id)
    finally:
        await conn.close()
    assert row["status"] == "completed" and row["outcome"] == "expired"


async def test_owner_cannot_lock_themselves_out(world):
    mayank, org = world["mayank"], world["org"]
    grants = [g for g in (await mayank.get(f"/orgs/{org}/grants")).json()
              if g["email"] == mayank.email and g["venture_id"] == world["site"]]
    r = await mayank.delete(f"/orgs/{org}/grants/{grants[0]['id']}")
    assert r.status_code == 409 and "your own access" in r.json()["detail"]


async def test_cli_bootstrap_is_idempotent():
    from kritvia_api.cli import bootstrap
    email = f"owner-{uuid.uuid4().hex[:6]}@sitelytc.example"
    slug = f"grp-{uuid.uuid4().hex[:6]}"
    a = await bootstrap(email, "Owner", "Group", slug, "a very long passphrase")
    b = await bootstrap(email, "Owner", "Group", slug, "a very long passphrase")
    assert a == b and set(a["ventures"]) == {"sitelytc", "truhome", "kitchen"}
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        roles = {r["role"] for r in await conn.fetch(
            "SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1", email)}
        sched = await conn.fetchval("SELECT schedule FROM workflow_configs WHERE venture_id = $1",
                                    uuid.UUID(a["ventures"]["kitchen"]))
    finally:
        await conn.close()
    assert roles == {"org_owner", "approver", "loan_officer", "kitchen_manager"} and sched == "23:30"


def test_sender_authentication_comes_from_gmails_own_check():
    from kritvia_api.services.google import sender_authenticated
    assert sender_authenticated(["mx.google.com; dkim=pass header.i=@x.in; spf=pass smtp.mailfrom=x.in; dmarc=pass"])
    assert sender_authenticated(["mx.google.com; dkim=pass header.i=@x.in; spf=pass smtp.mailfrom=x.in"])
    assert not sender_authenticated(["mx.google.com; dkim=none; spf=softfail; dmarc=fail (p=NONE)"])
    assert not sender_authenticated(["mx.google.com; spf=pass smtp.mailfrom=x.in"])
    assert not sender_authenticated([])


def test_docx_zip_bomb_is_refused_before_unpacking():
    import io
    import zipfile

    from kritvia_api.services.textextract import ExtractionError, extract_text
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", "<w:p>" + "a" * 5_000_000 + "</w:p>")   # 5 MB of one letter: ratio ~1000x
    with pytest.raises(ExtractionError):
        extract_text(buf.getvalue(), "bomb.docx")
    ok = io.BytesIO()
    with zipfile.ZipFile(ok, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", "<w:p><w:t>Rate card for Mehta Stores</w:t></w:p>")
    assert "Rate card" in extract_text(ok.getvalue(), "fine.docx").text
