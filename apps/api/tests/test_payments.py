"""Getting paid: every invoice has a payment page with the business's UPI QR and, with its own Razorpay
account connected, an online payment link; Razorpay's signed webhook marks the invoice paid by itself."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio
IST = timezone(timedelta(hours=5, minutes=30))
KEY_ID = "rzp_test_" + "A1b2C3d4E5f6G7"
KEY_SECRET = "s3cr3t" + "x" * 18


def today() -> date:
    return datetime.now(IST).date()


class FakeRazorpay:
    def __init__(self) -> None:
        self.links: list[dict] = []
        self.fail = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        import base64
        user, _, pw = base64.b64decode(auth.removeprefix("Basic ")).decode().partition(":")
        if (user, pw) != (KEY_ID, KEY_SECRET):
            return httpx.Response(401, json={"error": {"code": "BAD_REQUEST_ERROR", "description": "Authentication failed"}})
        if self.fail:
            return httpx.Response(500, json={"error": {"description": "server down"}})
        if request.method == "GET" and request.url.path == "/v1/payment_links":
            return httpx.Response(200, json={"payment_links": []})
        if request.method == "POST" and request.url.path == "/v1/payment_links":
            body = json.loads(request.content)
            n = len(self.links) + 1
            self.links.append(body)
            return httpx.Response(200, json={"id": f"plink_T{n:04d}", "short_url": f"https://rzp.io/i/T{n:04d}",
                                             "status": "created", "amount": body["amount"]})
        return httpx.Response(404, json={"error": {"description": "not found"}})


@pytest.fixture
def rzp(services):
    from kritvia_api.services.payments import RazorpayClient
    fake = FakeRazorpay()
    old = services.razorpay
    services.razorpay = RazorpayClient(transport=httpx.MockTransport(fake))
    yield fake
    services.razorpay = old


@pytest.fixture(scope="module")
async def biz(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Glow Salon Pay", "slug": f"glowpay-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Glow Salon", "city": "Pune"})
    operator = await make_actor(client, "pay-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


def inv(**kw) -> dict:
    return {"number": "GS-101", "customer_name": "Ritu Sharma", "customer_email": "ritu@example.com",
            "customer_phone": "+91 98111 22233", "amount_paise": 250050, "issued_on": str(today()),
            "due_on": str(today() + timedelta(days=7)), **kw}


def signed(secret: str, payload: dict) -> tuple[bytes, dict]:
    raw = json.dumps(payload).encode()
    return raw, {"x-razorpay-signature": hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest(),
                 "content-type": "application/json"}


def paid(link: str, pay: str, paise: int) -> dict:
    return {"event": "payment_link.paid", "payload": {
        "payment_link": {"entity": {"id": link, "amount_paid": paise, "status": "paid"}},
        "payment": {"entity": {"id": pay, "amount": paise, "method": "upi", "status": "captured"}}}}


async def test_upi_page_and_customer_says_paid(biz, client):
    mayank, operator, v = biz["mayank"], biz["operator"], biz["v"]
    i = (await operator.post(f"/ventures/{v}/invoices", json=inv())).json()
    assert i["pay_url"].endswith("/pay/" + i["pay_url"].rsplit("/", 1)[1]) and len(i["pay_url"].rsplit("/", 1)[1]) == 32
    token = i["pay_url"].rsplit("/", 1)[1]
    # before a UPI ID is set the page still shows the amount, without ways to pay
    page = (await client.get(f"/public/pay/{token}")).json()
    assert page["business"] == "Glow Salon Pay" and page["amount_text"] == "₹2,500.50"
    assert page["upi"] is None and page["online"] is False
    assert (await client.get("/public/pay/" + "0" * 32)).status_code == 404
    assert (await client.get("/public/pay/not-a-token")).status_code == 404

    # only admins set the UPI ID; a wrong one is refused
    assert (await operator.put(f"/ventures/{v}/payment-settings", json={"upi_id": "glow@okicici"})).status_code == 403
    assert (await mayank.put(f"/ventures/{v}/payment-settings", json={"upi_id": "not a upi"})).status_code == 422
    r = await mayank.put(f"/ventures/{v}/payment-settings", json={"upi_id": "glowsalon@okicici", "payee_name": "Glow Salon"})
    assert r.status_code == 200 and r.json()["upi_id"] == "glowsalon@okicici" and r.json()["razorpay"] is None
    assert (await operator.get(f"/ventures/{v}/payment-settings")).json()["can_edit"] is False

    page = (await client.get(f"/public/pay/{token}")).json()
    assert page["upi"]["link"] == "upi://pay?pa=glowsalon@okicici&pn=Glow%20Salon&am=2500.50&cu=INR&tn=Invoice%20GS-101"
    assert (await client.post(f"/public/pay/{token}/online")).status_code == 409

    # the customer says they paid: the team sees it, nothing is marked paid until a person confirms
    r = await client.post(f"/public/pay/{token}/paid", json={"reference": "UTR 4123-5678"})
    assert r.status_code == 200 and r.json()["customer_says_paid"] is True
    got = next(x for x in (await operator.get(f"/ventures/{v}/invoices")).json()["invoices"] if x["id"] == i["id"])
    assert got["status"] == "open" and got["customer_says_paid_at"] and got["customer_paid_ref"] == "UTR41235678"
    r = await operator.post(f"/ventures/{v}/invoices/{i['id']}/payment",
                            json={"amount_paise": 250050, "method": "upi", "reference": "UTR41235678"})
    assert r.status_code == 200 and r.json()["status"] == "paid" and r.json()["customer_says_paid_at"] is None
    page = (await client.get(f"/public/pay/{token}")).json()
    assert page["status"] == "paid" and page["upi"] is None and page["balance_paise"] == 0


async def test_razorpay_link_and_webhook_mark_paid(biz, client, rzp):
    mayank, operator, v = biz["mayank"], biz["operator"], biz["v"]
    assert (await operator.post(f"/ventures/{v}/connectors/razorpay",
                                json={"key_id": KEY_ID, "key_secret": KEY_SECRET})).status_code == 403
    bad = await mayank.post(f"/ventures/{v}/connectors/razorpay", json={"key_id": KEY_ID, "key_secret": "wrong" * 4})
    assert bad.status_code == 422 and "didn't accept" in bad.json()["detail"]
    r = await mayank.post(f"/ventures/{v}/connectors/razorpay", json={"key_id": KEY_ID, "key_secret": KEY_SECRET})
    assert r.status_code == 201, r.text
    out = r.json()
    hook, secret = out["webhook_url"], out["webhook_secret"]
    assert out["events"] == ["payment_link.paid"] and hook.endswith(f"/hooks/razorpay/{out['connector_id']}")
    s = (await mayank.get(f"/ventures/{v}/payment-settings")).json()
    assert s["razorpay"]["key_id"] == KEY_ID and KEY_SECRET not in json.dumps(s)

    i = (await operator.post(f"/ventures/{v}/invoices", json=inv(number="GS-102", amount_paise=100000))).json()
    token = i["pay_url"].rsplit("/", 1)[1]
    page = (await client.get(f"/public/pay/{token}")).json()
    assert page["online"] is True and page["upi"]["link"].startswith("upi://pay?pa=glowsalon@okicici")
    url = (await client.post(f"/public/pay/{token}/online")).json()["url"]
    assert url == "https://rzp.io/i/T0001"
    link = rzp.links[-1]
    assert link["amount"] == 100000 and link["currency"] == "INR" and link["notify"] == {"sms": False, "email": False}
    assert link["customer"] == {"name": "Ritu Sharma", "email": "ritu@example.com", "contact": "+919811122233"}
    assert link["callback_url"].endswith("/pay/" + token)
    # the same amount: the same link
    assert (await client.post(f"/public/pay/{token}/online")).json()["url"] == url and len(rzp.links) == 1

    # a part payment by hand: a new link for what is left
    await operator.post(f"/ventures/{v}/invoices/{i['id']}/payment", json={"amount_paise": 40000})
    url2 = (await client.post(f"/public/pay/{token}/online")).json()["url"]
    assert url2 == "https://rzp.io/i/T0002" and rzp.links[-1]["amount"] == 60000

    # webhook: unsigned or wrongly signed is refused; an old link's payment isn't matched
    raw, headers = signed(secret, paid("plink_T0002", "pay_A1", 60000))
    path = "/hooks/razorpay/" + out["connector_id"]
    assert (await client.post(path, content=raw, headers={"content-type": "application/json"})).status_code == 401
    assert (await client.post(path, content=raw, headers={**headers, "x-razorpay-signature": "0" * 64})).status_code == 401
    other = signed(secret, paid("plink_T0001", "pay_A0", 100000))
    assert (await client.post(path, content=other[0], headers=other[1])).json() == {"recorded": False}
    r = await client.post(path, content=raw, headers=headers)
    assert r.json() == {"recorded": True}
    got = next(x for x in (await operator.get(f"/ventures/{v}/invoices", params={"show": "all"})).json()["invoices"]
               if x["id"] == i["id"])
    assert got["status"] == "paid" and got["paid_paise"] == 100000 and got["paid_on"] == str(today())
    # delivered again: counted once
    assert (await client.post(path, content=raw, headers=headers)).json() == {"recorded": False}
    # other events are fine and ignored
    ev = signed(secret, {"event": "payment.captured", "payload": {}})
    assert (await client.post(path, content=ev[0], headers=ev[1])).json() == {"recorded": False}
    assert (await client.post(f"/public/pay/{token}/online")).status_code == 409

    # Razorpay down: the page says so and the connector shows the error
    j = (await operator.post(f"/ventures/{v}/invoices", json=inv(number="GS-103", amount_paise=5000))).json()
    rzp.fail = True
    r = await client.post(f"/public/pay/{j['pay_url'].rsplit('/', 1)[1]}/online")
    assert r.status_code == 502 and "UPI" in r.json()["detail"]
    assert (await mayank.get(f"/ventures/{v}/payment-settings")).json()["razorpay"]["last_error"]


async def test_reminders_carry_the_payment_link(biz, fake_llm):
    mayank, operator, v = biz["mayank"], biz["operator"], biz["v"]
    i = (await operator.post(f"/ventures/{v}/invoices", json=inv(number="GS-200", amount_paise=90000,
                                                                     due_on=str(today() + timedelta(days=1))))).json()
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/collections", json={
        "enabled": True, "schedule": "10:00", "settings": {"days_before": 2}, "instructions": ""})).status_code == 200
    fake_llm.on("You write short, warm payment reminders", {
        "subject": "Invoice GS-200 due soon", "body": "Hi Ritu, ₹900 for invoice GS-200 is due tomorrow. Ignore if paid."})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "collections", "input": {}})
    assert r.status_code == 201
    a = [x for x in (await mayank.get("/approvals/inbox")).json() if x["action"] == "gmail.send"
         and "GS-200" in x["payload"]["body"]][-1]
    assert f"Pay online: {i['pay_url']}" in a["payload"]["body"]
    assert i["pay_url"] in fake_llm.chat_calls("You write short, warm payment reminders")[-1]["prompt"]
