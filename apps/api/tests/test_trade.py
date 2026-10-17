"""Trade: shipment files for exporters, importers and C&F agents. Numbering, the document checklist,
lines and value, stages and their dates, realisation, alerts, a C&F job's bill, status updates that
wait for a yes, and the morning shipment watch. Viewers can look but not change; strangers see nothing."""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.config import get_settings
from kritvia_api.services import trade as tr

pytestmark = pytest.mark.asyncio
IST = ZoneInfo("Asia/Kolkata")


async def _sql(sql: str, *args) -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute(sql, *args)
    finally:
        await conn.close()


async def _setup(client):
    owner = await make_actor(client, "trade-owner")
    org = (await owner.post("/orgs", json={"name": "Spice Exports", "slug": f"tr-{uuid.uuid4().hex[:8]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Spice Exports", "slug": f"se-{uuid.uuid4().hex[:6]}"})).json()["id"]
    r = await owner.put(f"/ventures/{v}/settings", json={"kind": "trade", "business_name": "Spice Exports", "city": "Delhi"})
    assert r.status_code == 200, r.text
    return owner, org, v


async def test_trade_files(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner, org, v = await _setup(client)
    viewer = await make_actor(client, "trade-viewer")
    await join(owner, viewer, org, v, "viewer")
    stranger = await make_actor(client, "trade-stranger")

    # profile
    got = (await owner.get(f"/ventures/{v}/trade-profile")).json()
    assert got["configured"] is False and got["can_edit"] is True
    bad = await owner.put(f"/ventures/{v}/trade-profile", json={"legal_name": "Spice Exports Pvt Ltd", "address": "Okhla, New Delhi", "iec": "123"})
    assert bad.status_code == 422
    prof = {"roles": ["exporter", "cha", "importer"], "legal_name": "Spice Exports Pvt Ltd", "address": "Okhla Phase 2, New Delhi 110020",
            "iec": "abcde1234f", "ad_code": "0510 005", "lut_arn": "AD0704260012345", "lut_valid_until": str(date.today() + timedelta(days=20)),
            "default_currency": "USD", "realisation_months": 9}
    r = await owner.put(f"/ventures/{v}/trade-profile", json=prof)
    assert r.status_code == 200, r.text
    assert r.json()["roles"] == ["exporter", "importer", "cha"] and r.json()["iec"] == "ABCDE1234F" and r.json()["ad_code"] == "0510005"
    assert (await viewer.put(f"/ventures/{v}/trade-profile", json=prof)).status_code == 403

    # an export file: numbered, checklist from Incoterm and payment terms
    exp = await owner.post(f"/ventures/{v}/shipments", json={
        "direction": "export", "party_name": "Al Noor Trading LLC", "party_country": "ae", "party_email": "buy@alnoor.example",
        "incoterm": "CIF", "incoterm_place": "Jebel Ali", "payment_terms": "lc", "lc_no": "LC123",
        "lc_expiry": str(date.today() + timedelta(days=10)), "port_loading": "Nhava Sheva", "port_discharge": "Jebel Ali",
        "etd": str(date.today() + timedelta(days=1)), "cutoff_at": (datetime.now(UTC) + timedelta(hours=20)).isoformat(),
        "reference": "PO-778"})
    assert exp.status_code == 201, exp.text
    e = exp.json()
    fy = tr.fy_now(datetime.now(IST).date())
    assert e["number"] == f"EXP/{fy}/0001" and e["currency"] == "USD" and e["party_country"] == "AE"
    codes = [d["code"] for d in e["docs"]]
    assert codes[0] == "lc_copy" and "insurance" in codes and "shipping_bill" in codes and "brc" in codes
    kinds = {a["kind"] for a in e["alerts"]}
    assert {"cutoff", "etd", "lc"} <= kinds
    assert [s["code"] for s in e["stages"]][:3] == ["order", "production", "booking"]
    assert (await viewer.post(f"/ventures/{v}/shipments", json={"direction": "export", "party_name": "X"})).status_code == 403
    assert (await stranger.get(f"/ventures/{v}/shipments/{e['id']}")).status_code == 404
    assert (await viewer.get(f"/ventures/{v}/shipments/{e['id']}")).json()["can_edit"] is False

    # lines set the value; packing list
    r = await owner.put(f"/ventures/{v}/shipments/{e['id']}/items", json=[
        {"description": "1121 Basmati rice, 25 kg bags", "hs_code": "10063020", "qty": "40", "unit": "MT", "unit_price_minor": 115000},
        {"description": "Black pepper", "hs_code": "09041130", "qty": "2.5", "unit": "MT", "unit_price_minor": 410033}])
    assert r.status_code == 200, r.text
    assert r.json()["value_minor"] == 40 * 115000 + 1025083
    r = await owner.put(f"/ventures/{v}/shipments/{e['id']}/packages", json=[
        {"marks": "AN/1-1600", "kind": "bags", "count": 1600, "net_kg": "40000", "gross_kg": "40320"}])
    assert r.json()["packages"][0]["count"] == 1600

    # documents: tick one, add an extra and a custom one
    doc = next(d for d in e["docs"] if d["code"] == "commercial_invoice")
    r = await owner.patch(f"/ventures/{v}/shipments/{e['id']}/docs/{doc['id']}", json={"status": "done", "ref_no": "EXP/1"})
    assert next(d for d in r.json()["docs"] if d["code"] == "commercial_invoice")["status"] == "done"
    r = await owner.post(f"/ventures/{v}/shipments/{e['id']}/docs", json={"code": "phytosanitary"})
    assert r.status_code == 201 and any(d["code"] == "phytosanitary" for d in r.json()["docs"])
    assert (await owner.post(f"/ventures/{v}/shipments/{e['id']}/docs", json={"code": "phytosanitary"})).status_code == 409
    r = await owner.post(f"/ventures/{v}/shipments/{e['id']}/docs", json={"name": "Halal certificate", "needed_by": "documents"})
    assert any(d["name"] == "Halal certificate" for d in r.json()["docs"])

    # shipped: date and realisation deadline follow; paid marks it realised
    r = await owner.patch(f"/ventures/{v}/shipments/{e['id']}", json={"stage": "shipped", "bl_no": "MAEU1234", "vessel": "MSC Aurora 123E"})
    s = r.json()
    today = datetime.now(IST).date()
    assert s["shipped_on"] == str(today) and s["realise_by"] == str(tr.add_months(today, 9))
    assert any(a["kind"] == "docs" for a in s["alerts"])           # shipping bill was needed before now
    assert (await owner.patch(f"/ventures/{v}/shipments/{e['id']}", json={"stage": "duty_paid"})).status_code == 422
    r = await owner.patch(f"/ventures/{v}/shipments/{e['id']}", json={"received_minor": 3000000})
    assert r.json()["events"][0]["kind"] == "payment"
    await _sql("UPDATE shipments SET realise_by = current_date + 5 WHERE id = $1", uuid.UUID(e["id"]))
    lst = (await owner.get(f"/ventures/{v}/shipments")).json()
    assert any(a["text"].startswith("Export proceeds to be realised") for a in lst["attention"])
    assert lst["profile_alert"]["kind"] == "lut" and lst["roles"] == ["exporter", "importer", "cha"]
    assert (await owner.get(f"/ventures/{v}/shipments", params={"q": "MAEU"})).json()["items"][0]["id"] == e["id"]
    r = await owner.patch(f"/ventures/{v}/shipments/{e['id']}", json={"stage": "paid", "brc_no": "BRC9"})
    assert r.json()["realised_on"] == str(today)

    # an import at port too long
    imp = (await owner.post(f"/ventures/{v}/shipments", json={
        "direction": "import", "party_name": "Shenzhen Parts Co", "currency": "CNY", "incoterm": "FOB", "stage": "arrived",
        "arrived_on": str(today - timedelta(days=6))})).json()
    assert imp["number"] == f"IMP/{fy}/0001" and "insurance" in [d["code"] for d in imp["docs"]]
    assert any(a["kind"] == "port" and a["level"] == "urgent" for a in imp["alerts"])

    # a C&F job: billed once to the client, as an invoice
    job = (await owner.post(f"/ventures/{v}/shipments", json={
        "direction": "import", "for_client": True, "party_name": "Mehta Traders", "party_email": "a@mehta.example",
        "fee_paise": 750000, "reimbursable_paise": 4250000, "customs_no": "1234567"})).json()
    assert job["number"] == f"JOB/{fy}/0001" and job["stage"] == "arrived" and job["currency"] == "USD"
    assert [d["code"] for d in job["docs"]][0] == "kyc"
    assert (await owner.post(f"/ventures/{v}/shipments/{e['id']}/bill")).status_code == 422
    b = await owner.post(f"/ventures/{v}/shipments/{job['id']}/bill")
    assert b.status_code == 201, b.text and b.json()["amount_paise"] == 5000000
    inv = next(i for i in (await owner.get(f"/ventures/{v}/invoices")).json()["invoices"] if i["id"] == b.json()["invoice_id"])
    assert inv["amount_paise"] == 5000000 and inv["customer_name"] == "Mehta Traders" and "BE 1234567" in inv["notes"]
    assert (await owner.post(f"/ventures/{v}/shipments/{job['id']}/bill")).status_code == 409

    # numbering can be typed; duplicates refused; delete is for admins
    assert (await owner.post(f"/ventures/{v}/shipments", json={"direction": "export", "party_name": "Y", "number": f"EXP/{fy}/0001"})).status_code == 409
    assert (await viewer.delete(f"/ventures/{v}/shipments/{imp['id']}")).status_code == 403
    assert (await owner.delete(f"/ventures/{v}/shipments/{imp['id']}")).status_code == 204


async def test_update_and_watch(client, monkeypatch, services):
    from kritvia_api.engine.runner import start_run
    from kritvia_api.services.mailer import get_mailer
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner, org, v = await _setup(client)
    s = (await owner.post(f"/ventures/{v}/shipments", json={
        "direction": "export", "for_client": True, "party_name": "Ravi Exports", "party_email": "ravi@example.com",
        "vessel": "Maersk Kolkata", "customs_no": "SB778", "etd": str(date.today() + timedelta(days=1)), "reference": "R-1"})).json()

    r = await owner.post(f"/ventures/{v}/shipments/{s['id']}/update", json={"channel": "email", "note": "Originals couriered today."})
    assert r.status_code == 201, r.text
    aps = [a for a in (await owner.get(f"/ventures/{v}/approvals")).json() if a["agent"] == "trade_update"]
    assert len(aps) == 1 and aps[0]["payload"]["to"] == "ravi@example.com"
    body = aps[0]["payload"]["body"]
    assert s["number"] in body and "SB778" in body and "Originals couriered today." in body and "your ref. R-1" in body
    assert (await owner.post(f"/ventures/{v}/shipments/{s['id']}/update", json={"channel": "whatsapp"})).status_code == 422

    # the watch needs a plan with the trade agent (Starter and up); then it emails the owner the list
    await _sql("INSERT INTO org_plans (org_id, plan) VALUES ($1, 'starter') ON CONFLICT (org_id) DO UPDATE SET plan = 'starter'",
               uuid.UUID(org))
    outbox = get_mailer().outbox
    before = len(outbox)
    await start_run(services, actor_user_id=owner.id, actor_type="user", venture_id=uuid.UUID(v), workflow="trade_watch",
                    input={}, trigger_kind="manual", title="Shipment watch")
    mine = [m for m in outbox[before:] if m["To"] == owner.email]
    assert len(mine) == 1 and "Sails in 1 day(s)" in mine[0].get_content() and s["number"] in mine[0].get_content()

    # nothing to say: stays quiet
    await owner.patch(f"/ventures/{v}/shipments/{s['id']}", json={"stage": "closed"})
    before = len(outbox)
    await start_run(services, actor_user_id=owner.id, actor_type="user", venture_id=uuid.UUID(v), workflow="trade_watch",
                    input={}, trigger_kind="manual", title="Shipment watch")
    assert [m for m in outbox[before:] if m["To"] == owner.email] == []


async def test_alert_rules():
    class S:
        stage, direction, for_client = "booking", "export", False
        cutoff_at = datetime.now(UTC) - timedelta(hours=1)
        etd = eta = arrived_on = lc_last_shipment = lc_expiry = realise_by = realised_on = None
        payment_terms, received_minor, value_minor, fee_paise, invoice_id = None, 0, 0, None, None

    class D:
        status, needed_by, name = "needed", "documents", "Packing list"
    a = tr.alerts(S(), [D()], date.today())
    assert a[0].kind == "cutoff" and a[0].level == "urgent" and "1 document(s)" in a[0].text
    assert tr.add_months(date(2026, 5, 31), 9) == date(2027, 2, 28)
    assert tr.money(123456, "USD") == "USD 1,234.56" and tr.money(5000, "JPY") == "JPY 5,000"
    assert tr.line_amount(tr.Decimal("2.5"), 410033) == 1025083
