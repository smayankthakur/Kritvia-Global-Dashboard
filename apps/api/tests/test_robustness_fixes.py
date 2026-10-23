"""Pre-launch test report, technical-user findings T1–T11: failures at the edges (network errors,
races, retries, large bodies) that now fail safely."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
import uuid
from types import SimpleNamespace
from urllib.parse import urlparse

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, make_actor
from test_payments import KEY_SECRET, inv, paid, rzp, signed  # noqa: F401  (fixture)
from test_voice_calls import connect, hook, twilio  # noqa: F401  (fixture)

from kritvia_api.bodylimit import DEFAULT_LIMIT, UPLOAD_LIMIT, limit_for
from kritvia_api.config import get_settings
from kritvia_api.plans import plan as plan_of
from kritvia_api.routers.connectors import LEAD_DEDUPE_WINDOW_S, lead_dedupe_key, sign
from kritvia_api.services import quota
from kritvia_api.services.whatsapp import WhatsAppClient, WhatsAppConn, WhatsAppError

pytestmark = pytest.mark.asyncio


async def _free_org(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, "t-owner")
    org = (await owner.post("/orgs", json={"name": "Edge Co", "slug": "edge-" + uuid.uuid4().hex[:8]})).json()["id"]
    return owner, org


# --------------------------------------------------------------------------- T1 WhatsApp network --
async def test_whatsapp_network_errors_become_whatsapp_errors():
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)
    wa = WhatsAppClient("secret", "verify", transport=httpx.MockTransport(down))
    conn = WhatsAppConn(id=uuid.uuid4(), phone_number_id="123", display=None, access_token="t")
    with pytest.raises(WhatsAppError, match="couldn't reach WhatsApp"):
        await wa.send_text(conn, to="919811122233", body="hello")
    with pytest.raises(WhatsAppError):
        await wa.send_template(conn, to="919811122233", name="hello", language="en", params=[])
    with pytest.raises(WhatsAppError):
        await wa.list_templates("waba", "t")
    with pytest.raises(WhatsAppError):
        await wa.exchange_code("app", "code")
    await wa.mark_read(conn, "wamid.1")      # best effort: never raises


# --------------------------------------------------------------------------- T2 token gate --
async def test_token_gate_rechecks_near_the_cap(monkeypatch):
    calls = {"n": 0}
    used = {"tokens": 0}
    p = plan_of("free")

    async def usage(conn, org_id, local):
        calls["n"] += 1
        return quota.Usage(p, used["tokens"], 1, 1)
    monkeypatch.setattr(quota, "org_usage", usage)
    gate, org = quota.TokenGate(ttl_s=60), uuid.uuid4()
    cap = p.monthly_tokens

    used["tokens"] = cap // 10                    # comfortably inside: one read, then cached
    assert await gate.over_limit(None, org, []) is False
    assert await gate.over_limit(None, org, []) is False
    assert calls["n"] == 1

    gate.forget(org)
    used["tokens"] = int(cap * 0.95)              # nearly used up: every call asks again
    for _ in range(3):
        assert await gate.over_limit(None, org, []) is False
    assert calls["n"] == 4

    used["tokens"] = cap                          # used up: refused, and not cached
    assert await gate.over_limit(None, org, []) is True
    used["tokens"] = cap // 10                    # a top-up applies at once
    assert await gate.over_limit(None, org, []) is False


# --------------------------------------------------------------------------- T3 plan limits --
async def test_two_businesses_at_once_cannot_pass_the_plan(client, monkeypatch):
    owner, org = await _free_org(client, monkeypatch)
    r = await asyncio.gather(*[owner.post(f"/orgs/{org}/ventures", json={"name": f"B{i}", "slug": f"b{i}"})
                               for i in range(3)])
    assert sorted(x.status_code for x in r) == [201, 402, 402], [x.text for x in r]


async def test_accepting_an_invitation_respects_the_people_limit(client, monkeypatch):
    owner, org = await _free_org(client, monkeypatch)
    vid = (await owner.post(f"/orgs/{org}/ventures", json={"name": "One", "slug": "one"})).json()["id"]
    a, b = await make_actor(client, "t-a"), await make_actor(client, "t-b")
    # both invitations go out while there is room for one more person
    ia = await owner.post(f"/orgs/{org}/invitations", json={"email": a.email, "role": "operator", "venture_id": vid})
    ib = await owner.post(f"/orgs/{org}/invitations", json={"email": b.email, "role": "operator", "venture_id": vid})
    assert ia.status_code == 201 and ib.status_code == 201
    assert (await a.post("/invitations/accept", json={"token": ia.json()["token"]})).status_code == 200
    late = await b.post("/invitations/accept", json={"token": ib.json()["token"]})
    assert late.status_code == 402 and "upgrade" in late.text
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["members"] == 2
    # the refused acceptance was undone: after an upgrade the same invitation still works
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, 'growth', now() + interval '30 days')", uuid.UUID(org))
    finally:
        await conn.close()
    assert (await b.post("/invitations/accept", json={"token": ib.json()["token"]})).status_code == 200


# --------------------------------------------------------------------------- T4 payments race --
async def test_two_part_payments_at_once_leave_the_invoice_paid(world):
    mayank, v = world["mayank"], world["site"]
    i = (await mayank.post(f"/ventures/{v}/invoices", json=inv(number=f"RC-{uuid.uuid4().hex[:5]}",
                                                                amount_paise=100000))).json()
    path = f"/ventures/{v}/invoices/{i['id']}/payment"
    r = await asyncio.gather(mayank.post(path, json={"amount_paise": 40000}),
                             mayank.post(path, json={"amount_paise": 60000}))
    assert [x.status_code for x in r] == [200, 200], [x.text for x in r]
    got = next(x for x in (await mayank.get(f"/ventures/{v}/invoices", params={"show": "all"})).json()["invoices"]
               if x["id"] == i["id"])
    assert got["status"] == "paid" and got["paid_paise"] == 100000


async def test_two_payments_that_overpay_together_refuse_the_second(world):
    mayank, v = world["mayank"], world["site"]
    i = (await mayank.post(f"/ventures/{v}/invoices", json=inv(number=f"RD-{uuid.uuid4().hex[:5]}",
                                                                amount_paise=100000))).json()
    path = f"/ventures/{v}/invoices/{i['id']}/payment"
    r = await asyncio.gather(mayank.post(path, json={"amount_paise": 60000}),
                             mayank.post(path, json={"amount_paise": 60000}))
    assert sorted(x.status_code for x in r) == [200, 422], [x.text for x in r]
    got = next(x for x in (await mayank.get(f"/ventures/{v}/invoices", params={"show": "all"})).json()["invoices"]
               if x["id"] == i["id"])
    assert got["status"] == "open" and got["paid_paise"] == 60000


# --------------------------------------------------------------------------- T5 old Razorpay links --
async def test_a_payment_on_an_older_link_is_still_recorded(world, client, rzp, monkeypatch):  # noqa: F811
    import test_payments
    key_id = "rzp_test_" + "Z9y8X7w6V5u4T3"     # a Razorpay account is connected to one business only
    monkeypatch.setattr(test_payments, "KEY_ID", key_id)
    rzp.links.extend([{}] * 900)      # the fake numbers its links per test; real Razorpay ids never repeat
    mayank, v = world["mayank"], world["site"]
    await mayank.put(f"/ventures/{v}/payment-settings", json={"upi_id": "site@okicici", "payee_name": "Sitelytc"})
    r = await mayank.post(f"/ventures/{v}/connectors/razorpay", json={"key_id": key_id, "key_secret": KEY_SECRET})
    assert r.status_code == 201, r.text
    out = r.json()
    i = (await mayank.post(f"/ventures/{v}/invoices", json=inv(number=f"RL-{uuid.uuid4().hex[:5]}",
                                                                amount_paise=100000))).json()
    token = i["pay_url"].rsplit("/", 1)[1]
    first = (await client.post(f"/public/pay/{token}/online")).json()["url"]
    old_link = "plink_" + first.rsplit("/", 1)[1]
    await mayank.post(f"/ventures/{v}/invoices/{i['id']}/payment", json={"amount_paise": 10000})
    second = (await client.post(f"/public/pay/{token}/online")).json()["url"]
    assert second != first
    # the customer pays the first link they were sent (the full amount)
    raw, headers = signed(out["webhook_secret"], paid(old_link, "pay_OLD1", 100000))
    r = await client.post(f"/hooks/razorpay/{out['connector_id']}", content=raw, headers=headers)
    assert r.json() == {"recorded": True}
    got = next(x for x in (await mayank.get(f"/ventures/{v}/invoices", params={"show": "all"})).json()["invoices"]
               if x["id"] == i["id"])
    assert got["status"] == "paid" and got["paid_paise"] == 100000
    # an unknown link still isn't matched
    raw, headers = signed(out["webhook_secret"], paid("plink_NOPE", "pay_X", 500))
    assert (await client.post(f"/hooks/razorpay/{out['connector_id']}", content=raw, headers=headers)).json() == \
        {"recorded": False}


# --------------------------------------------------------------------------- T6 lead webhook dedupe --
async def test_lead_dedupe_key_windows():
    body = b'{"name":"Asha","email":"a@example.com"}'
    t0 = 1_800_000_000 - (1_800_000_000 % LEAD_DEDUPE_WINDOW_S)
    # unsigned: the same body is "the same lead" only within one window
    assert lead_dedupe_key(body, None, now=t0) == lead_dedupe_key(body, None, now=t0 + 30)
    assert lead_dedupe_key(body, None, now=t0) != lead_dedupe_key(body, None, now=t0 + LEAD_DEDUPE_WINDOW_S)
    # signed: a replay (same timestamp) matches; a new submission (new timestamp) doesn't
    assert lead_dedupe_key(body, "1800000000") == lead_dedupe_key(body, "1800000000")
    assert lead_dedupe_key(body, "1800000000") != lead_dedupe_key(body, "1800000005")


async def test_identical_lead_forms_sent_again_later_are_new_leads(world, client, fake_llm):
    mayank, v = world["mayank"], world["site"]
    fake_llm.on("You triage inbound inquiries", {"summary": "s", "requirements": [], "scope": [], "urgency": "low"})
    fake_llm.on("proposal writer", {"subject": "s", "email_body": "b", "proposal": "p", "used_sources": []})
    h = (await mayank.post(f"/ventures/{v}/connectors/webhook")).json()
    path = urlparse(h["url"]).path
    body = json.dumps({"name": "Same", "email": f"same-{uuid.uuid4().hex[:6]}@example.com",
                       "message": "price?"}).encode()
    ts = str(int(time.time()))
    one = await client.post(path, content=body, headers={"X-Kritvia-Timestamp": ts,
                                                         "X-Kritvia-Signature": sign(h["secret"], ts, body)})
    replay = await client.post(path, content=body, headers={"X-Kritvia-Timestamp": ts,
                                                            "X-Kritvia-Signature": sign(h["secret"], ts, body)})
    ts2 = str(int(ts) + 2)
    again = await client.post(path, content=body, headers={"X-Kritvia-Timestamp": ts2,
                                                           "X-Kritvia-Signature": sign(h["secret"], ts2, body)})
    assert one.json()["run_id"] and replay.json()["duplicate"] is True
    assert again.status_code == 202 and again.json()["run_id"] and again.json()["run_id"] != one.json()["run_id"]
    # an unsigned sender's quick retry is still caught
    k1 = await client.post(path, content=body + b" ", headers={"X-Kritvia-Key": h["secret"]})
    k2 = await client.post(path, content=body + b" ", headers={"X-Kritvia-Key": h["secret"]})
    assert k1.json()["run_id"] and k2.json()["duplicate"] is True


# --------------------------------------------------------------------------- T7 plan check per batch --
async def test_whatsapp_batch_checks_the_plan_once_per_business(monkeypatch, client, services):
    from kritvia_api.routers import connectors
    from kritvia_api.services import whatsapp as wa_mod
    seen: list = []

    async def allows(run_as, venture_id, integration):
        seen.append(venture_id)
        return False                       # ignore the messages: only the count of checks matters here
    principal = SimpleNamespace(run_as=uuid.uuid4(), venture_id=uuid.uuid4(), org_id=uuid.uuid4())

    class Conn:
        async def execute(self, *a, **kw):
            return SimpleNamespace(first=lambda: principal)

    class Tx:
        async def __aenter__(self):
            return Conn()

        async def __aexit__(self, *a):
            return False
    monkeypatch.setattr(connectors, "_plan_allows", allows)
    monkeypatch.setattr(connectors, "tenant_tx", lambda *a, **kw: Tx())
    monkeypatch.setattr(wa_mod, "verify_signature", lambda *a: True)
    monkeypatch.setattr(services.whatsapp, "app_secret", "x")
    msgs = [{"from": "919811100000", "id": f"wamid.{n}", "type": "text", "timestamp": "1", "text": {"body": "hi"}}
            for n in range(5)]
    payload = {"entry": [{"changes": [{"field": "messages", "value": {
        "metadata": {"phone_number_id": "555"}, "contacts": [{"profile": {"name": "C"}, "wa_id": "919811100000"}],
        "messages": msgs}}]}]}
    r = await client.post("/hooks/whatsapp", content=json.dumps(payload).encode(),
                          headers={"content-type": "application/json", "x-hub-signature-256": "sha256=x"})
    assert r.status_code == 200 and r.json()["ignored"] == 5
    assert seen == [principal.venture_id]


# --------------------------------------------------------------------------- T8 body limits --
async def test_body_limits_by_kind_of_request():
    assert DEFAULT_LIMIT == 2 * 1024 * 1024
    assert limit_for("/ventures/x/leads", "application/json") == DEFAULT_LIMIT
    assert limit_for("/ventures/x/knowledge/upload", "multipart/form-data; boundary=x") == UPLOAD_LIMIT
    assert limit_for("/hooks/whatsapp", "application/json") == 256 * 1024
    assert limit_for("/hooks/tally/abc/import", "application/xml") > 40 * 1024 * 1024
    assert limit_for("/auth/login", "multipart/form-data") == 64 * 1024


async def test_a_huge_json_body_is_refused_before_parsing(world, client):
    mayank, v = world["mayank"], world["site"]
    big = b'{"name": "' + b"x" * (3 * 1024 * 1024) + b'"}'
    r = await client.post(f"/ventures/{v}/leads", content=big,
                          headers={**mayank.h, "content-type": "application/json"})
    assert r.status_code == 413


async def test_tally_companion_export_is_not_cut_off_by_the_webhook_limit(client):
    # 300 KB is over the general webhook limit but well within the Tally export's own; with an unknown
    # connector the endpoint (not the middleware) answers.
    r = await client.post(f"/hooks/tally/{uuid.uuid4()}/import", content=b"<x/>" * 75_000,
                          headers={"x-kritvia-key": "kts_nope", "content-type": "application/xml"})
    assert r.status_code != 413


# --------------------------------------------------------------------------- T9 billing webhook --
async def test_billing_webhook_with_a_non_json_body_is_a_422(client, monkeypatch):
    secret = "whsec_billing_test"
    monkeypatch.setattr(get_settings(), "razorpay_webhook_secret", secret)
    raw = b"not json"
    r = await client.post("/public/billing/razorpay", content=raw, headers={
        "x-razorpay-signature": hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()})
    assert r.status_code == 422


# --------------------------------------------------------------------------- T10 duplicate call --
async def test_the_same_call_delivered_twice_at_once_is_one_call(world, client, twilio):  # noqa: F811
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Twice", "slug": f"twice-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Twice Shop", "city": "Delhi"})
    out = await connect(mayank, v, twilio)
    cid = out["number"]["voice_url"].split("/twilio/")[1].split("/")[0]
    form = {"CallSid": "CA" + uuid.uuid4().hex, "From": "+919811000022"}
    r = await asyncio.gather(*[hook(client, f"/hooks/voice/twilio/{cid}/incoming", form) for _ in range(3)])
    assert [x.status_code for x in r] == [200, 200, 200], [x.text for x in r]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        n = await conn.fetchval("SELECT count(*) FROM calls WHERE provider_call_id = $1", form["CallSid"])
    finally:
        await conn.close()
    assert n == 1


# --------------------------------------------------------------------------- T11 limiter accounting --
async def test_saying_paid_counts_once_against_the_rate_limits(world, client, monkeypatch):
    from kritvia_api.routers import payments
    mayank, v = world["mayank"], world["site"]
    i = (await mayank.post(f"/ventures/{v}/invoices", json=inv(number=f"RP-{uuid.uuid4().hex[:5]}"))).json()
    keys: list[str] = []
    real = payments.limiter.hit

    async def hit(key, per_minute):
        keys.append(key.split(":")[0])
        return await real(key, per_minute)
    monkeypatch.setattr(payments.limiter, "hit", hit)
    r = await client.post(f"/public/pay/{i['pay_url'].rsplit('/', 1)[1]}/paid", json={})
    assert r.status_code == 200 and keys == ["pay-claim"]
