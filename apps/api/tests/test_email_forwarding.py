"""Email forwarding: a business's own Kritvia address instead of Gmail read access (migration 0031)."""
from __future__ import annotations

import time
import uuid
from email.message import EmailMessage

import pytest

from conftest import make_actor
from kritvia_api.config import get_settings
from kritvia_api.services import email_in
from kritvia_api.services.google import DEFAULT_SCOPES, SCOPES, SEND_ONLY_SCOPES

pytestmark = pytest.mark.asyncio
SECRET = "test-inbound-secret-0123456789abcdef"
DOMAIN = "in.example.com"


def mail(*, frm="Rahul <rahul@example.com>", subject="Delivery time?", body="How long to Pune? Rahul",
         message_id=None, attachment: bytes | None = None) -> bytes:
    m = EmailMessage()
    m["From"], m["To"], m["Subject"] = frm, "owner@gmail.com", subject
    m["Message-ID"] = message_id or f"<{uuid.uuid4().hex}@mail.example.com>"
    m.set_content(body)
    if attachment:
        m.add_attachment(attachment, maintype="application", subtype="pdf", filename="pan.pdf")
    return m.as_bytes()


def signed(raw: bytes, to: str, *, secret=SECRET, ts=None):
    ts = str(int(ts or time.time()))
    return {"X-Kritvia-To": to, "X-Kritvia-Timestamp": ts, "X-Kritvia-Signature": email_in.sign(secret, ts, raw),
            "Content-Type": "message/rfc822"}


@pytest.fixture
def inbound(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "inbound_email_domain", DOMAIN)
    monkeypatch.setattr(s, "inbound_email_secret", SECRET)


@pytest.fixture
async def shop(world):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Shop", "slug": f"shop-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Mehta Stores", "city": "Pune"})
    r = await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    assert r.status_code == 200, r.text
    return {**world, "v": v}


def script_inbox(fake):
    fake.on("You sort the business's incoming messages", {
        "category": "support", "summary": "Rahul asks about delivery.", "needs_reply": True, "language": "en",
        "urgency": "medium"})
    fake.on("You answer the business's", {"subject": "Re: Delivery time?", "body": "3-5 days.",
                                          "used_sources": [], "unsure": False})


async def test_off_until_the_server_is_set_up(shop):
    r = await shop["mayank"].post(f"/ventures/{shop['v']}/connectors/email-forwarding")
    assert r.status_code == 503


async def test_forwarded_mail_reaches_the_inbox_assistant(shop, inbound, client, fake_llm):
    mayank, v = shop["mayank"], shop["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/email-forwarding")
    assert r.status_code == 201, r.text
    address = r.json()["address"]
    assert address.endswith("@" + DOMAIN) and address.startswith("shop-")
    assert (await mayank.get(f"/ventures/{v}/connectors/email-forwarding")).json()["address"] == address

    script_inbox(fake_llm)
    raw = mail(message_id="<m1@example.com>")
    res = await client.post("/public/email-in", content=raw, headers=signed(raw, address))
    assert res.status_code == 200 and res.json()["started"] == {"inbox_assistant": 1}, res.text
    # the same message again (a retry) starts nothing new
    again = await client.post("/public/email-in", content=raw, headers=signed(raw, address))
    assert again.json()["started"] == {"inbox_assistant": 0}
    runs = (await mayank.get(f"/ventures/{v}/runs", params={"workflow": "inbox_assistant"})).json()
    assert any(x["trigger_kind"] == "email" for x in runs)


async def test_unsigned_stale_or_unknown_mail_is_refused(shop, inbound, client):
    address = (await shop["mayank"].post(f"/ventures/{shop['v']}/connectors/email-forwarding")).json()["address"]
    raw = mail()
    assert (await client.post("/public/email-in", content=raw, headers={"X-Kritvia-To": address})).status_code == 401
    bad = signed(raw, address, secret="wrong-secret-wrong-secret-wrong!!")
    assert (await client.post("/public/email-in", content=raw, headers=bad)).status_code == 401
    old = signed(raw, address, ts=time.time() - 3600)
    assert (await client.post("/public/email-in", content=raw, headers=old)).status_code == 401
    other = f"nobody-0000000000@{DOMAIN}"
    assert (await client.post("/public/email-in", content=raw, headers=signed(raw, other))).status_code == 404
    elsewhere = address.replace(DOMAIN, "evil.example.com")
    assert (await client.post("/public/email-in", content=raw, headers=signed(raw, elsewhere))).status_code == 404


async def test_a_new_address_retires_the_old_one(shop, inbound, client):
    m = shop["mayank"]
    first = (await m.post(f"/ventures/{shop['v']}/connectors/email-forwarding")).json()["address"]
    second = (await m.post(f"/ventures/{shop['v']}/connectors/email-forwarding")).json()["address"]
    assert first != second
    raw = mail()
    assert (await client.post("/public/email-in", content=raw, headers=signed(raw, first))).status_code == 404


async def test_gmail_confirmation_code_is_shown_to_the_owner(shop, inbound, client):
    m = shop["mayank"]
    address = (await m.post(f"/ventures/{shop['v']}/connectors/email-forwarding")).json()["address"]
    raw = mail(frm="Gmail Team <forwarding-noreply@google.com>",
               subject="(#481516234) Gmail Forwarding Confirmation - Receive Mail from owner@gmail.com",
               body="owner@gmail.com has requested to automatically forward mail to your email address.\n"
                    "Confirmation code: 481516234\n")
    res = await client.post("/public/email-in", content=raw, headers=signed(raw, address))
    assert res.json()["confirmation"] is True and res.json()["started"] == {}
    got = (await m.get(f"/ventures/{shop['v']}/connectors/email-forwarding")).json()
    assert got["gmail_code"] == "481516234" and got["gmail_mailbox"] == "owner@gmail.com"


async def test_only_an_admin_sets_up_forwarding(shop, inbound):
    r = await shop["vera"].post(f"/ventures/{shop['site']}/connectors/email-forwarding")
    assert r.status_code == 404


async def test_parse_reads_text_html_and_attachments():
    raw = mail(body="Hello there", attachment=b"%PDF-1.4 fake")
    m = email_in.parse(raw)
    assert m.sender_email == "rahul@example.com" and m.body.strip() == "Hello there"
    assert m.attachments[0]["filename"] == "pan.pdf" and m.attachments[0]["data"].startswith(b"%PDF")
    assert m.authenticated is False and m.thread_id == ""
    h = EmailMessage()
    h["From"], h["Subject"] = "a@b.co", "x"
    h.set_content("<p>Hi<br>there</p><script>alert(1)</script>", subtype="html")
    assert email_in.parse(h.as_bytes()).body.replace("\n", " ").split() == ["Hi", "there"]


async def test_scopes_by_plan():
    assert SCOPES["gmail.readonly"] not in SEND_ONLY_SCOPES and SCOPES["drive.readonly"] not in SEND_ONLY_SCOPES
    assert SCOPES["gmail.send"] in SEND_ONLY_SCOPES and SCOPES["drive.file"] in SEND_ONLY_SCOPES
    assert SCOPES["gmail.readonly"] in DEFAULT_SCOPES


async def test_customers_connect_google_without_read_access(client, monkeypatch, services):
    """Only plans in GOOGLE_READ_PLANS ask Google for Gmail read access."""
    import asyncpg
    from conftest import ADMIN_DSN
    from kritvia_api.services.google import GoogleClient
    monkeypatch.setattr(services, "google", GoogleClient("cid", "secret", "http://web/cb"))
    owner = await make_actor(client, "scopes")
    org = (await owner.post("/orgs", json={"name": "Scopes Co", "slug": "sc-" + uuid.uuid4().hex[:8]})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "One", "slug": "one"})).json()["id"]
    url = (await owner.post(f"/ventures/{v}/connectors/google/start", json={"nonce": "n" * 40})).json()["url"]
    assert "gmail.readonly" in url      # internal (the default in tests) keeps read access
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, 'growth', now() + interval '30 days')", uuid.UUID(org))
    finally:
        await conn.close()
    url = (await owner.post(f"/ventures/{v}/connectors/google/start", json={"nonce": "n" * 40})).json()["url"]
    assert "gmail.readonly" not in url and "drive.readonly" not in url and "gmail.send" in url and "drive.file" in url


# ------------------------------------------------------------------- Drive picker (drive.file) --
class SendOnlyGoogle:
    """Google granting only send + calendar + drive.file, with two Drive files the person picked."""

    def __init__(self):
        self.downloads: list[str] = []

    def __call__(self, request):
        import httpx
        from urllib.parse import parse_qs
        url = str(request.url)
        if url.startswith("https://oauth2.googleapis.com/token"):
            form = parse_qs(request.content.decode())
            if form["grant_type"] == ["authorization_code"]:
                return httpx.Response(200, json={"access_token": "at", "refresh_token": "rt-9", "expires_in": 3600,
                                                 "scope": " ".join(SEND_ONLY_SCOPES)})
            return httpx.Response(200, json={"access_token": "at2", "expires_in": 3600})
        if "userinfo" in url:
            return httpx.Response(200, json={"email": "owner@shop.example"})
        if "/drive/v3/files/" in url:
            fid = url.split("/files/")[1].split("?")[0].split("/")[0]
            if fid not in ("pickedFileAAAA1", "pickedFileBBBB2"):
                return httpx.Response(404)
            if "alt=media" in url:
                self.downloads.append(fid)
                return httpx.Response(200, content=f"Rate card {fid}: website 9999, app 49999".encode())
            return httpx.Response(200, json={"id": fid, "name": f"Rates {fid[-1]}", "mimeType": "text/plain",
                                             "webViewLink": f"https://drive/{fid}"})
        if "gmail" in url:
            raise AssertionError("a send-only connection must never read Gmail")
        return httpx.Response(404)


async def test_send_only_google_never_reads_gmail_and_imports_picked_files(client, monkeypatch, services, fake_llm):
    import asyncpg
    import httpx
    from urllib.parse import parse_qs, urlparse
    from conftest import ADMIN_DSN
    from kritvia_api.services.google import GoogleClient
    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "cid")
    monkeypatch.setattr(s, "google_picker_api_key", "AIzaPicker")
    monkeypatch.setattr(s, "google_app_id", "123456789012")
    fake = SendOnlyGoogle()
    g = GoogleClient("cid", "secret", "http://web/cb", transport=httpx.MockTransport(fake))
    monkeypatch.setattr(services, "google", g)
    monkeypatch.setattr(services.messaging, "google", g)
    owner = await make_actor(client, "picker")
    org = (await owner.post("/orgs", json={"name": "Picker Co", "slug": "pc-" + uuid.uuid4().hex[:8]})).json()["id"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, 'growth', now() + interval '30 days')", uuid.UUID(org))
    finally:
        await conn.close()
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "One", "slug": "one"})).json()["id"]
    await owner.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    nonce = "p" * 40
    url = (await owner.post(f"/ventures/{v}/connectors/google/start", json={"nonce": nonce})).json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]
    done = await owner.post("/connectors/google/complete", json={"code": "c", "state": state, "nonce": nonce})
    assert done.status_code == 200, done.text

    # Gmail is never polled for a send-only connection (its mail comes by forwarding)
    assert (await owner.post(f"/ventures/{v}/connectors/google/sync")).json()["started"] == {}

    cfg = (await owner.get(f"/ventures/{v}/connectors/google/picker")).json()
    assert cfg == {"ready": True, "client_id": "cid", "api_key": "AIzaPicker", "app_id": "123456789012",
                   "account_email": "owner@shop.example", "full_drive": False}
    r = await owner.post(f"/ventures/{v}/connectors/google/drive-picked",
                         json={"file_ids": ["pickedFileAAAA1", "pickedFileBBBB2", "pickedFileAAAA1"]})
    assert r.status_code == 200 and r.json()["imported"] == 2, r.text
    assert fake.downloads == ["pickedFileAAAA1", "pickedFileBBBB2"]
    bad = await owner.post(f"/ventures/{v}/connectors/google/drive-picked", json={"file_ids": ["../etc/passwd"]})
    assert bad.status_code == 422
