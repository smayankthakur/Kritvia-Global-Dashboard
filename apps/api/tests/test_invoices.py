"""Invoices (what customers owe) and the Payment reminders agent."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest

import asyncpg

from conftest import ADMIN_DSN, join, make_actor
from test_inbox_assistant import APP_SECRET, VERIFY
from test_whatsapp_front_door import hook, msg
from test_whatsapp_templates import FakeGraph, template_status

pytestmark = pytest.mark.asyncio

PNID = "5550004444"
WABA = "7770003333"
IST = timezone(timedelta(hours=5, minutes=30))


async def admin(sql: str, *args) -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute(sql, *args)
    finally:
        await conn.close()


def today() -> date:
    return datetime.now(IST).date()


@pytest.fixture(scope="module")
async def shop(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Print Hub", "slug": f"print-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Print Hub", "city": "Delhi"})
    approver = await make_actor(client, "inv-approver")
    await join(mayank, approver, world["org"], v, "approver")
    operator = await make_actor(client, "inv-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "approver": approver, "operator": operator}


@pytest.fixture
def graph(services):
    from kritvia_api.services.whatsapp import WhatsAppClient
    fake = FakeGraph(PNID, WABA)
    wa = WhatsAppClient(APP_SECRET, VERIFY, transport=httpx.MockTransport(fake))
    old = services.whatsapp, services.messaging.whatsapp
    services.whatsapp = services.messaging.whatsapp = wa
    yield fake
    services.whatsapp, services.messaging.whatsapp = old


def invoice(**kw) -> dict:
    return {"number": "INV-1", "customer_name": "Neha Traders", "customer_email": "accounts@nehatraders.in",
            "customer_phone": None, "amount_paise": 1180000, "issued_on": str(today() - timedelta(days=10)),
            "due_on": str(today() + timedelta(days=2)), **kw}


async def collections_run(actor, v) -> dict:
    r = await actor.post(f"/ventures/{v}/runs", json={"workflow": "collections", "input": {}})
    assert r.status_code == 201, r.text
    return (await actor.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()


async def touches(actor, v) -> list[dict]:
    return [x for x in (await actor.get(f"/ventures/{v}/runs", params={"workflow": "collections"})).json()
            if x["title"] == "Payment reminder"]


async def test_invoices_are_kept_and_payments_recorded(shop):
    mayank, operator, approver, mallory, v = (shop["mayank"], shop["operator"], shop["approver"], shop["mallory"],
                                              shop["v"])
    bad = await operator.post(f"/ventures/{v}/invoices", json=invoice(customer_phone="12345"))
    assert bad.status_code == 422
    bad = await operator.post(f"/ventures/{v}/invoices", json=invoice(due_on=str(today() - timedelta(days=20))))
    assert bad.status_code == 422 and "before the invoice date" in bad.text
    assert (await approver.post(f"/ventures/{v}/invoices", json=invoice())).status_code == 403
    r = await operator.post(f"/ventures/{v}/invoices", json=invoice(number="T-1", customer_phone="98111 22233"))
    assert r.status_code == 201, r.text
    inv = r.json()
    assert inv["customer_phone"] == "919811122233" and inv["balance_paise"] == 1180000 and inv["status"] == "open"
    assert (await operator.post(f"/ventures/{v}/invoices", json=invoice(number="t-1"))).status_code == 409
    late = (await operator.post(f"/ventures/{v}/invoices", json=invoice(
        number="T-2", amount_paise=50000, issued_on=None, due_on=str(today() - timedelta(days=5))))).json()
    assert late["overdue_days"] == 5

    # part payment, then the rest: paid, and it leaves the open list
    assert (await operator.post(f"/ventures/{v}/invoices/{inv['id']}/payment",
                                json={"amount_paise": 2000000})).status_code == 422          # more than owed
    r = await operator.post(f"/ventures/{v}/invoices/{inv['id']}/payment", json={"amount_paise": 180000})
    assert r.json()["balance_paise"] == 1000000 and r.json()["status"] == "open"
    r = await operator.post(f"/ventures/{v}/invoices/{inv['id']}/payment", json={"amount_paise": 1000000})
    assert r.json()["status"] == "paid" and r.json()["paid_on"] == str(today())
    assert (await operator.patch(f"/ventures/{v}/invoices/{inv['id']}", json={"status": "open"})).status_code == 409

    d = (await approver.get(f"/ventures/{v}/invoices")).json()           # approvers can read
    assert [x["number"] for x in d["invoices"]] == ["T-2"]
    t = d["totals"]
    assert t["outstanding_paise"] == 50000 and t["overdue_paise"] == 50000 and t["overdue_count"] == 1
    assert t["paid_this_month_paise"] >= 1180000
    assert [x["number"] for x in (await mayank.get(f"/ventures/{v}/invoices", params={"show": "paid"})).json()["invoices"]] == ["T-1"]

    r = await operator.patch(f"/ventures/{v}/invoices/{late['id']}", json={"reminders_paused": True, "notes": " Promised Friday "})
    assert r.json()["reminders_paused"] is True and r.json()["notes"] == "Promised Friday"
    assert (await mallory.get(f"/ventures/{v}/invoices")).status_code == 404
    assert (await mallory.delete(f"/ventures/{v}/invoices/{late['id']}")).status_code == 404
    assert (await operator.delete(f"/ventures/{v}/invoices/{late['id']}")).status_code == 403
    assert (await mayank.delete(f"/ventures/{v}/invoices/{inv['id']}")).status_code == 204
    assert (await mayank.delete(f"/ventures/{v}/invoices/{late['id']}")).status_code == 204


async def test_an_invoice_is_read_from_a_file(shop, fake_llm, monkeypatch):
    from kritvia_api.routers import invoices
    from kritvia_api.services.textextract import Extracted
    operator, v = shop["operator"], shop["v"]
    monkeypatch.setattr(invoices, "extract_text", lambda data, name, mime: Extracted(
        text="TAX INVOICE  Print Hub\nBill to: Kapoor Sweets, +91 98222 33344\nInvoice No: PH/0042  Date: 2026-10-01\n"
             "Grand Total: Rs. 11,800.00", method="text"))
    fake_llm.on("You read invoices", {"number": "PH/0042", "customer_name": "Kapoor Sweets", "customer_email": "",
                                      "customer_phone": "+91 98222 33344", "total": "11,800.00",
                                      "issued_on": "2026-10-01", "due_on": "", "unsure": []})
    pdf = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"
    r = await operator.post(f"/ventures/{v}/invoices/read", files={"file": ("invoice.pdf", pdf, "application/pdf")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["number"] == "PH/0042" and d["customer_name"] == "Kapoor Sweets" and d["customer_phone"] == "919822233344"
    assert d["amount_paise"] == 1180000 and d["issued_on"] == "2026-10-01"
    assert d["due_on"] == "2026-10-16" and "due_on" in d["unsure"]          # not printed: 15 days, flagged
    assert not [x for x in (await operator.get(f"/ventures/{v}/invoices", params={"show": "all"})).json()["invoices"]
                if x["number"] == "PH/0042"]                              # nothing is saved by reading
    # only PDFs and images
    r = await operator.post(f"/ventures/{v}/invoices/read", files={"file": ("x.txt", b"hello there", "text/plain")})
    assert r.status_code == 415
    assert (await shop["approver"].post(f"/ventures/{v}/invoices/read",
                                        files={"file": ("invoice.pdf", pdf, "application/pdf")})).status_code == 403


async def test_reminders_go_out_by_email_with_approval(shop, fake_llm):
    mayank, approver, operator, v = shop["mayank"], shop["approver"], shop["operator"], shop["v"]
    inv = (await operator.post(f"/ventures/{v}/invoices", json=invoice(number="R-1"))).json()
    far = (await operator.post(f"/ventures/{v}/invoices", json=invoice(number="R-2", due_on=str(today() + timedelta(days=20))))).json()
    cfg = {"days_before": 2, "repeat_days": 7, "max_reminders": 3, "how_to_pay": "UPI printhub@okhdfc"}
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/collections", json={
        "enabled": True, "schedule": "10:00", "settings": cfg, "instructions": ""})).status_code == 200
    fake_llm.on("You write short, warm payment reminders", {
        "subject": "Invoice R-1: ₹11,800 due soon",
        "body": "Hi Neha Traders, a quick heads-up that ₹11,800 for invoice R-1 is due on its date. Ignore this if paid."})
    assert (await collections_run(mayank, v))["summary"]["reminders"] == 1      # R-2 isn't due for 20 days
    run = next(x for x in await touches(mayank, v) if x["status"] == "waiting")
    a = next(x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run["id"])
    assert a["action"] == "gmail.send" and a["payload"]["to"] == "accounts@nehatraders.in"
    assert "UPI printhub@okhdfc" in a["payload"]["body"] and "another amount" not in a["summary"]
    prompt = fake_llm.chat_calls("You write short, warm payment reminders")[-1]["prompt"]
    assert "₹11,800" in prompt and "R-1" in prompt and "heads-up" in prompt
    assert (await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})).status_code == 200
    assert (await mayank.get(f"/ventures/{v}/runs/{run['id']}")).json()["outcome"] == "reminded"
    got = next(x for x in (await mayank.get(f"/ventures/{v}/invoices")).json()["invoices"] if x["id"] == inv["id"])
    assert got["reminders_sent"] == 1
    # the next one waits for the day after the due date
    assert (await collections_run(mayank, v))["summary"]["reminders"] == 0

    # now it's overdue: a reminder that mentions another amount always waits for a person
    await operator.patch(f"/ventures/{v}/invoices/{inv['id']}", json={
        "issued_on": str(today() - timedelta(days=30)), "due_on": str(today() - timedelta(days=4))})
    await admin("UPDATE invoices SET last_reminder_at = now() - interval '6 days' WHERE id = $1", uuid.UUID(inv["id"]))
    fake_llm.on("You write short, warm payment reminders", {
        "subject": "Overdue: invoice R-1", "body": "Hi, ₹11,800 is 4 days overdue; a late fee of ₹500 applies."})
    assert (await collections_run(mayank, v))["summary"]["reminders"] == 1
    run = next(x for x in await touches(mayank, v) if x["status"] == "waiting")
    a = next(x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run["id"])
    assert "another amount" in a["summary"]
    assert "overdue" in fake_llm.chat_calls("You write short, warm payment reminders")[-1]["prompt"]
    # paid in part while it waited: nothing is sent
    await operator.post(f"/ventures/{v}/invoices/{inv['id']}/payment", json={"amount_paise": 100000})
    await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert (await mayank.get(f"/ventures/{v}/runs/{run['id']}")).json()["outcome"] == "not_needed"

    # paused or paid: no reminders
    await operator.patch(f"/ventures/{v}/invoices/{inv['id']}", json={"reminders_paused": True})
    assert (await collections_run(mayank, v))["summary"]["reminders"] == 0
    await operator.post(f"/ventures/{v}/invoices/{far['id']}/payment", json={"amount_paise": 1180000})


async def test_reminders_by_whatsapp_only_to_customers_who_chat(shop, client, fake_llm, graph):
    mayank, approver, operator, v = shop["mayank"], shop["approver"], shop["operator"], shop["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp",
                          json={"phone_number_id": PNID, "access_token": "EAAB" + "i" * 40, "waba_id": WABA})
    assert r.status_code == 201, r.text
    body = "Hi {{1}}, a reminder that {{2}} for invoice {{3}} was due on {{4}}. Thank you!"
    r = await mayank.post(f"/ventures/{v}/whatsapp/templates", json={
        "label": "Payment reminder", "category": "UTILITY", "body": body,
        "examples": ["Ravi", "₹2,500", "PH/0040", "5 Oct 2026"]})
    assert r.status_code == 201, r.text
    await hook(client, template_status("APPROVED", graph.templates["payment_reminder"]["id"], "payment_reminder", waba=WABA))
    ravi, stranger = "919833300011", "919833300022"
    payload = msg("wamid.i1", "Bill bhej dijiye", sender=ravi, name="Ravi")
    payload["entry"][0]["changes"][0]["value"]["metadata"]["phone_number_id"] = PNID
    await hook(client, payload)                                   # Ravi wrote first: he may get reminders
    due = str(today() - timedelta(days=3))
    issued = str(today() - timedelta(days=20))
    a1 = (await operator.post(f"/ventures/{v}/invoices", json=invoice(
        number="W-1", customer_name="Ravi", customer_email=None, customer_phone="+" + ravi, amount_paise=250000,
        issued_on=issued, due_on=due))).json()
    a2 = (await operator.post(f"/ventures/{v}/invoices", json=invoice(
        number="W-2", customer_name="Stranger", customer_email=None, customer_phone="+" + stranger,
        amount_paise=90000, issued_on=issued, due_on=due))).json()
    await mayank.put(f"/ventures/{v}/workflow-configs/collections", json={
        "enabled": True, "schedule": "10:00", "instructions": "",
        "settings": {"days_before": 2, "repeat_days": 7, "max_reminders": 3, "whatsapp_template": "Payment reminder"}})
    nice = datetime.fromisoformat(due).date()
    fake_llm.on("approved WhatsApp payment reminder", {"params": ["Ravi", "₹2,500", "W-1", f"{nice.day} {nice:%b %Y}"]})
    before = {x["id"] for x in await touches(mayank, v)}
    assert (await collections_run(mayank, v))["summary"]["reminders"] == 2
    runs = {x["id"]: x for x in await touches(mayank, v) if x["id"] not in before}
    assert sorted(x["outcome"] or x["status"] for x in runs.values()) == ["no_way_to_reach", "waiting"]
    waiting = next(x for x in runs.values() if x["status"] == "waiting")
    a = next(x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == waiting["id"])
    assert a["action"] == "whatsapp.template" and a["payload"]["to"] == ravi
    assert a["payload"]["body"].startswith("Hi Ravi, a reminder that ₹2,500 for invoice W-1 was due on")
    await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert graph.sent[-1]["to"] == ravi and graph.sent[-1]["template"]["name"] == "payment_reminder"
    for x in (a1, a2):
        await mayank.delete(f"/ventures/{v}/invoices/{x['id']}")


async def test_money_and_timing_rules():
    from kritvia_api.routers.invoices import phone_digits, to_paise
    from kritvia_api.workflows.collections import amounts, next_reminder, rupees
    assert rupees(1180000) == "₹11,800" and rupees(12345678950) == "₹12,34,56,789.50" and rupees(5) == "₹0.05"
    assert to_paise("₹ 11,800.5") == 1180050 and to_paise("Rs.11800") == 1180000 and to_paise("") is None
    assert to_paise("1.2.3") is None
    assert phone_digits("098111 22233") == "919811122233" and phone_digits("+1 415 555 0100") == "14155550100"
    with pytest.raises(ValueError):
        phone_digits("12345")
    assert amounts("₹11,800.00 and Rs. 11800") == {"11800.00"}
    cfg = {"days_before": 2, "repeat_days": 7}
    due = date(2026, 10, 20)
    assert next_reminder(due, None, cfg) == date(2026, 10, 18)
    assert next_reminder(due, None, {"days_before": 0}) == date(2026, 10, 21)
    sent_before = datetime(2026, 10, 18, 5, 0, tzinfo=timezone.utc)
    assert next_reminder(due, sent_before, cfg) == date(2026, 10, 21)
    sent_after = datetime(2026, 10, 21, 5, 0, tzinfo=timezone.utc)
    assert next_reminder(due, sent_after, cfg) == date(2026, 10, 28)
