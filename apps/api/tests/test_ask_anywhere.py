"""Ask Kritvia from anywhere: the email and Slack doors of the owner-side front door (services/ask_anywhere.py,
migration 0076). Mail to a person's private ask address is answered only when Cloudflare verified the sender
and the sender is that person's own account email; the answer goes to the account email. A Slack DM (or a
mention) from a linked member asks the business; others get a hint. Both run the assistant as that person."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from email.message import EmailMessage
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from conftest import join, make_actor
from kritvia_api.config import get_settings
from kritvia_api.services import ask_anywhere, email_in

pytestmark = pytest.mark.asyncio
SECRET = "test-inbound-secret-ask-0123456789ab"
DOMAIN = "in.ask.example.com"
SIGNING = "k" * 32
TEAM = "T0ASKTEAM9"
BOT = "xoxb-" + "9" * 20
MARK = "You are the business's assistant"


def script(fake_llm, *steps):
    calls = {"n": 0}

    def reply(messages):
        i = min(calls["n"], len(steps) - 1)
        calls["n"] += 1
        return steps[i](messages) if callable(steps[i]) else steps[i]
    fake_llm.on(MARK, reply)


def cf(domain: str, ok: bool = True) -> str:
    v = "pass" if ok else "fail"
    return f"i=1; mx.cloudflare.net; dkim={v} header.d={domain}; spf={v} smtp.mailfrom={domain}; dmarc={v} header.from={domain}"


def mail(frm: str, *, subject="Kitna paisa aaya?", body="Is hafte kitna paisa aaya?", auth: str | None = "pass",
         message_id: str | None = None, attachment: bool = False) -> bytes:
    m = EmailMessage()
    if auth:
        m["ARC-Authentication-Results"] = cf(frm.rsplit("@", 1)[1], auth == "pass")
    m["From"], m["To"], m["Subject"] = frm, "someone@in.ask.example.com", subject
    m["Message-ID"] = message_id or f"<{uuid.uuid4().hex}@mail.example.com>"
    m.set_content(body)
    if attachment:
        m.add_attachment(b"%PDF-1.4", maintype="application", subtype="pdf", filename="x.pdf")
    return m.as_bytes()


def signed_mail(raw: bytes, to: str) -> dict:
    ts = str(int(time.time()))
    return {"X-Kritvia-To": to, "X-Kritvia-Timestamp": ts, "X-Kritvia-Signature": email_in.sign(SECRET, ts, raw),
            "Content-Type": "message/rfc822"}


@pytest.fixture
def inbound(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "inbound_email_domain", DOMAIN)
    monkeypatch.setattr(s, "inbound_email_secret", SECRET)
    monkeypatch.setattr(s, "public_web_url", "https://app.example.test")


@pytest.fixture
async def biz(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Ask Salon", "slug": f"ask-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Ask Salon", "city": "Pune"})
    owner = await make_actor(client, "ask-owner")
    await join(mayank, owner, world["org"], v, "venture_admin")
    approver = await make_actor(client, "ask-approver")
    await join(mayank, approver, world["org"], v, "approver")
    return {**world, "v": v, "owner": owner, "approver": approver}


def outbox():
    from kritvia_api.services.mailer import get_mailer
    return get_mailer().outbox


# ----------------------------------------------------------------------------- email --
async def test_request_cleaning():
    assert ask_anywhere.email_request("Re: Re: /today", "") == "/today"
    assert ask_anywhere.email_request("Hi", "/week\nthanks") == "/week"
    body = "Kitne leads aaye?\n\nOn Mon, 3 Nov 2026 at 10:00, Kritvia <no-reply@x> wrote:\n> old answer"
    assert ask_anywhere.email_request("Re: Leads", body) == "Kitne leads aaye?"      # the subject is in the body
    assert ask_anywhere.email_request("Fwd: Dues", "Kaun baaki hai?") == "Dues\n\nKaun baaki hai?"
    assert ask_anywhere.clean_body("Dues?\n-- \nMayank\nSitelytc") == "Dues?"
    assert len(ask_anywhere.new_local()) == len("ask-") + 26 and ask_anywhere.is_ask_local(ask_anywhere.new_local())


async def test_ask_by_email_answers_only_the_owner_at_their_own_address(biz, client, fake_llm, inbound):
    owner, approver, v = biz["owner"], biz["approver"], biz["v"]
    assert (await owner.get(f"/ventures/{v}/ask-address")).json() == {
        "available": True, "exists": False, "address": None, "hint": None, "created_at": None,
        "last_used_at": None, "your_email": owner.email}
    # asking needs write access, as on the Assistant page
    assert (await approver.post(f"/ventures/{v}/ask-address")).status_code == 403
    r = await owner.post(f"/ventures/{v}/ask-address")
    assert r.status_code == 201, r.text
    address = r.json()["address"]
    assert address.startswith("ask-") and address.endswith("@" + DOMAIN)
    shown = (await owner.get(f"/ventures/{v}/ask-address")).json()
    assert shown["exists"] and shown["address"] is None and address.split("@")[0].endswith(shown["hint"])

    # the owner's own verified mail: the assistant runs as them; the answer goes to their account email
    script(fake_llm, {"tool": "business.numbers", "args": {"period": "last_7_days"}},
           {"answer": "Is hafte ₹12,400 aaya: Asha ₹8,000, Ravi ₹4,400."})
    before = len(outbox())
    raw = mail(owner.email, message_id="<q1@mail.example.com>", attachment=True)
    res = await client.post("/public/email-in", content=raw, headers=signed_mail(raw, address))
    assert res.status_code == 200 and res.json()["accepted"] is True, res.text
    sent = outbox()[before:]
    assert len(sent) == 1, [m["Subject"] for m in sent]           # one answer by email, no "On it."
    m = sent[0]
    assert m["To"] == owner.email and m["Subject"] == "Re: Kitna paisa aaya?"
    assert m["In-Reply-To"] == "<q1@mail.example.com>" and m["Reply-To"] == address
    text_ = m.get_content()
    assert "₹12,400" in text_ and "attachments" in text_ and "remove that address" in text_
    mine = (await owner.get(f"/ventures/{v}/assistant")).json()
    assert mine[0]["request"].endswith("Is hafte kitna paisa aaya?")
    assert (await owner.get(f"/ventures/{v}/ask-address")).json()["last_used_at"] is not None

    # the same mail again (a redelivery) is taken once
    await client.post("/public/email-in", content=raw, headers=signed_mail(raw, address))
    assert len(outbox()) == before + 1

    # someone else's verified mail, the owner's address without Cloudflare's pass, or a failing verdict: nothing
    script(fake_llm, {"answer": "SHOULD NOT BE SENT"})
    for bad in (mail("stranger@evil.example.org"), mail(owner.email, auth=None), mail(owner.email, auth="fail"),
                mail(owner.email.upper().replace("@EXAMPLE.COM", "@example.org"))):
        r = await client.post("/public/email-in", content=bad, headers=signed_mail(bad, address))
        assert r.status_code == 200 and r.json()["accepted"] is True     # dropped silently, no bounce
    assert len(outbox()) == before + 1
    assert all("SHOULD NOT" not in x.get_content() for x in outbox())

    # commands work by email, without an AI call
    calls = len(fake_llm.chat_calls())
    raw = mail(owner.email, subject="/today", body="")
    await client.post("/public/email-in", content=raw, headers=signed_mail(raw, address))
    assert outbox()[-1].get_content().startswith("Today:") and len(fake_llm.chat_calls()) == calls
    assert outbox()[-1]["To"] == owner.email

    # a new address replaces the old one: the old one is unknown (404, the worker bounces it)
    new = (await owner.post(f"/ventures/{v}/ask-address")).json()["address"]
    assert new != address
    raw = mail(owner.email)
    assert (await client.post("/public/email-in", content=raw, headers=signed_mail(raw, address))).status_code == 404
    assert (await owner.delete(f"/ventures/{v}/ask-address")).status_code == 204
    assert (await owner.get(f"/ventures/{v}/ask-address")).json()["exists"] is False
    assert (await client.post("/public/email-in", content=raw, headers=signed_mail(raw, new))).status_code == 404


async def test_an_answer_is_only_mailed_while_the_address_is_still_theirs(biz, inbound):
    from kritvia_api.services import front_door
    owner, v = biz["owner"], biz["v"]
    before = len(outbox())
    await front_door.reply(uuid.UUID(v), {"channel": "email", "chat": str(uuid.uuid4()), "user": str(owner.id)},
                           "an answer")
    assert len(outbox()) == before


async def test_off_until_the_server_receives_email(biz):
    r = await biz["owner"].post(f"/ventures/{biz['v']}/ask-address")
    assert r.status_code == 503
    assert (await biz["owner"].get(f"/ventures/{biz['v']}/ask-address")).json()["available"] is False


# ----------------------------------------------------------------------------- Slack --
class FakeSlack:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.ts = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method = request.url.path.rsplit("/", 1)[-1]
        ctype = request.headers.get("content-type", "")
        body = json.loads(request.content) if "json" in ctype else {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        self.calls.append((method, body))
        if method == "oauth.v2.access":
            return httpx.Response(200, json={
                "ok": True, "access_token": BOT, "scope": "chat:write,im:write,incoming-webhook",
                "team": {"id": TEAM, "name": "Ask Team"}, "authed_user": {"id": "U0ASKOWNER"}, "incoming_webhook": {
                    "url": "https://" + "hooks.slack." + "com/services/" + "/".join((TEAM, "B0ASKHOOK9", "p" * 24)),
                    "channel": "#desk"}})
        if request.headers.get("authorization") != f"Bearer {BOT}":
            return httpx.Response(200, json={"ok": False, "error": "invalid_auth"})
        if method == "chat.postMessage":
            self.ts += 1
            return httpx.Response(200, json={"ok": True, "channel": body["channel"], "ts": f"18000.{self.ts}"})
        return httpx.Response(200, json={"ok": True})

    def posts(self, channel: str) -> list[dict]:
        return [b for m, b in self.calls if m == "chat.postMessage" and b.get("channel") == channel]


@pytest.fixture
def slack(services, monkeypatch):
    from kritvia_api.services.slack import SlackClient
    s = get_settings()
    for k, val in (("slack_client_id", "999.111"), ("slack_client_secret", "c" * 32), ("slack_signing_secret", SIGNING),
                   ("public_web_url", "https://app.example.test")):
        monkeypatch.setattr(s, k, val)
    fake = FakeSlack()
    old = services.slack
    services.slack = SlackClient(transport=httpx.MockTransport(fake))
    yield fake
    services.slack = old


def sig(body: bytes, *, ts: int | None = None, secret: str = SIGNING) -> dict:
    ts = ts or int(time.time())
    mac = hmac.new(secret.encode(), f"v0:{ts}:".encode() + body, hashlib.sha256).hexdigest()
    return {"x-slack-request-timestamp": str(ts), "x-slack-signature": "v0=" + mac, "content-type": "application/json"}


async def event(client, ev: dict, *, event_id: str, headers: dict | None = None, **kw) -> httpx.Response:
    body = json.dumps({"type": "event_callback", "team_id": TEAM, "event_id": event_id, "event": ev}).encode()
    return await client.post("/hooks/slack/events", content=body, headers={**sig(body, **kw), **(headers or {})})


def dm(user: str, text: str, ts: str = "1.1") -> dict:
    return {"type": "message", "channel_type": "im", "channel": "D" + user[1:], "user": user, "text": text, "ts": ts}


async def test_ask_by_slack_dm_or_mention(biz, client, fake_llm, slack):
    mayank, v = biz["mayank"], biz["v"]
    nonce = "a" * 40
    state = parse_qs(urlsplit((await mayank.post(f"/ventures/{v}/connectors/slack/install",
                                                 json={"nonce": nonce})).json()["url"]).query)["state"][0]
    r = await mayank.post("/connectors/slack/complete", json={"code": "c", "state": state, "nonce": nonce})
    assert r.status_code == 200, r.text                        # the installer is linked as U0ASKOWNER

    # signed requests only; url_verification is answered
    body = json.dumps({"type": "url_verification", "challenge": "ch-123"}).encode()
    assert (await client.post("/hooks/slack/events", content=body, headers={"content-type": "application/json"})).status_code == 401
    assert (await client.post("/hooks/slack/events", content=body, headers=sig(body, secret="w" * 32))).status_code == 401
    assert (await client.post("/hooks/slack/events", content=body, headers=sig(body, ts=int(time.time()) - 900))).status_code == 401
    r = await client.post("/hooks/slack/events", content=body, headers=sig(body))
    assert r.status_code == 200 and r.json() == {"challenge": "ch-123"}

    # a DM from the linked owner: the assistant runs as them; "On it." then the answer, in the DM
    script(fake_llm, {"tool": "business.numbers", "args": {"period": "today"}}, {"answer": "Aaj ₹3,000 aaya: Asha."})
    assert (await event(client, dm("U0ASKOWNER", "Aaj kitna paisa aaya?"), event_id="Ev1")).status_code == 200
    said = [p["text"] for p in slack.posts("D0ASKOWNER")]
    assert set(said[-2:]) == {"On it.", "Aaj ₹3,000 aaya: Asha."}, said     # tests run the assistant inline
    assert (await mayank.get(f"/ventures/{v}/assistant")).json()[0]["request"] == "Aaj kitna paisa aaya?"

    # Slack's retry, and the same event again, are taken once
    n = len(slack.posts("D0ASKOWNER"))
    await event(client, dm("U0ASKOWNER", "Aaj kitna paisa aaya?"), event_id="Ev1", headers={"x-slack-retry-num": "1"})
    await event(client, dm("U0ASKOWNER", "Aaj kitna paisa aaya?"), event_id="Ev1")
    assert len(slack.posts("D0ASKOWNER")) == n

    # commands without an AI call
    calls = len(fake_llm.chat_calls())
    await event(client, dm("U0ASKOWNER", "/today"), event_id="Ev2")
    assert slack.posts("D0ASKOWNER")[-1]["text"].startswith("Today:") and len(fake_llm.chat_calls()) == calls

    # a mention in a channel: answered in that message's thread, the mention itself stripped
    script(fake_llm, {"answer": "2 naye leads."})
    mention = {"type": "app_mention", "channel": "C0DESK", "user": "U0ASKOWNER", "text": "<@U0BOTID> aaj ke leads?",
               "ts": "1700.5"}
    await event(client, mention, event_id="Ev3")
    posts = slack.posts("C0DESK")
    assert {p["text"] for p in posts} == {"On it.", "2 naye leads."} and all(p["thread_ts"] == "1700.5" for p in posts)
    assert (await mayank.get(f"/ventures/{v}/assistant")).json()[0]["request"] == "aaj ke leads?"

    # someone who isn't linked gets a hint and nothing of the business; the app's own posts are ignored
    script(fake_llm, {"answer": "SHOULD NOT BE SENT"})
    await event(client, dm("U0STRANGER", "Aaj kitna paisa aaya?"), event_id="Ev4")
    assert "Link your Slack in Kritvia first" in slack.posts("D0STRANGER")[-1]["text"]
    await event(client, {**dm("U0ASKOWNER", "bot echo"), "bot_id": "B1"}, event_id="Ev5")
    await event(client, {"type": "message", "channel_type": "channel", "channel": "C0DESK", "user": "U0ASKOWNER",
                         "text": "chatting", "ts": "2.2"}, event_id="Ev6")
    assert all("SHOULD NOT" not in p["text"] for _, p in [(m, b) for m, b in slack.calls if m == "chat.postMessage"])


async def test_slack_answers_only_while_still_linked(biz, slack):
    from kritvia_api.services import front_door
    await front_door.reply(uuid.UUID(biz["v"]), {"channel": "slack", "chat": "U0GONE", "user": str(biz["owner"].id),
                                                 "team": TEAM, "slack_channel": "D0GONE"}, "an answer")
    assert slack.posts("D0GONE") == []


# ---------------------------------------------------------------- answers with data --
async def test_who_paid_and_new_leads_today_come_back_with_names_and_amounts(biz, fake_llm):
    owner, v = biz["owner"], biz["v"]
    inv = (await owner.post(f"/ventures/{v}/invoices", json={"customer_name": "Asha Caterers", "amount_paise": 1000000,
                                                             "due_on": "2026-12-31"})).json()
    assert (await owner.post(f"/ventures/{v}/invoices/{inv['id']}/payment", json={"amount_paise": 400000})).status_code == 200
    assert (await owner.post(f"/ventures/{v}/leads", json={"name": "Ravi Kumar", "source": "manual"})).status_code == 201
    seen: dict[str, str] = {}

    def answer(messages):
        seen["prompt"] = messages[-1]["content"]
        return {"answer": "done"}
    script(fake_llm, {"tool": "payments.received", "args": {"period": "today"}},
           {"tool": "leads.search", "args": {"query": "", "since": "today"}}, answer)
    r = await owner.post(f"/ventures/{v}/assistant", json={"request": "Aaj kisne pay kiya, aur naye leads?"})
    assert r.status_code == 201, r.text
    assert "Asha Caterers" in seen["prompt"] and "4,000" in seen["prompt"] and "Ravi Kumar" in seen["prompt"]
