"""GST invoices made in Kritvia: the business's GST details, numbered tax invoices with CGST+SGST or IGST
per line, the printed document (in the app and on the payment page), and no re-pricing after issue."""
from __future__ import annotations

import uuid
from datetime import date

import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio

GSTIN_MH = "27AAPFU0939F1ZV"       # a well-known valid sample (Maharashtra)
GSTIN_KA = "29AAGCB7383J1Z4"       # a valid sample (Karnataka)


async def test_gst_arithmetic():
    from decimal import Decimal

    from kritvia_api.services import gst
    assert gst.gstin_ok(GSTIN_MH) and gst.gstin_ok(GSTIN_KA)
    assert not gst.gstin_ok("27AAPFU0939F1ZX") and not gst.gstin_ok("99AAPFU0939F1ZV") and not gst.gstin_ok("x")
    assert gst.financial_year(date(2026, 3, 31)) == "25-26" and gst.financial_year(date(2026, 4, 1)) == "26-27"
    assert gst.invoice_number("GS", "26-27", 7) == "GS/26-27/0007"
    same = gst.line_tax(Decimal("3"), 33333, 1000, Decimal("18"), True)
    assert (same.taxable, same.cgst, same.sgst, same.igst) == (98999, 8910, 8910, 0)
    other = gst.line_tax(Decimal("1.5"), 100001, 0, Decimal("5"), False)
    assert (other.taxable, other.igst) == (150002, 7500)
    assert gst.amount_in_words(1234567_89) == ("Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven"
                                               " and Eighty Nine Paise Only")
    assert gst.amount_in_words(10_00_00_000_00) == "Rupees Ten Crore Only"


@pytest.fixture(scope="module")
async def firm(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Pixel Studio", "slug": f"pixel-{uuid.uuid4().hex[:6]}"})).json()["id"]
    operator = await make_actor(client, "gst-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


def body(**kw) -> dict:
    return {"customer_name": "Bright Foods Pvt Ltd", "customer_gstin": GSTIN_MH, "customer_address": "Andheri, Mumbai",
            "customer_email": "accounts@brightfoods.in",
            "items": [{"description": "Website design", "hsn_sac": "998314", "qty": "1", "unit": "job",
                       "rate_paise": 4000000, "gst_rate": "18"},
                      {"description": "Hosting (12 months)", "hsn_sac": "998315", "qty": "12", "unit": "month",
                       "rate_paise": 50000, "discount_paise": 10000, "gst_rate": "18"}], **kw}


async def test_profile_issue_number_document(firm, client):
    mayank, operator, v = firm["mayank"], firm["operator"], firm["v"]
    assert (await operator.post(f"/ventures/{v}/invoices/gst", json=body())).status_code == 409   # no GST details yet
    prof = {"legal_name": "Pixel Studio LLP", "gstin": "27AAPFU0939F1ZV", "address": "12 MG Road, Pune 411001",
            "prefix": "px", "terms": "Bank: HDFC 50200012345678, IFSC HDFC0000123"}
    assert (await operator.put(f"/ventures/{v}/gst-profile", json=prof)).status_code == 403
    assert (await mayank.put(f"/ventures/{v}/gst-profile", json={**prof, "gstin": "27AAPFU0939F1ZX"})).status_code == 422
    r = await mayank.put(f"/ventures/{v}/gst-profile", json=prof)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["state"] == {"code": "27", "name": "Maharashtra"} and out["profile"]["prefix"] == "PX"
    assert out["next_number"].startswith("PX/") and out["next_number"].endswith("/0001")

    # same state: CGST + SGST
    r = await operator.post(f"/ventures/{v}/invoices/gst", json=body())
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["kind"] == "gst" and a["number"].endswith("/0001") and a["number"].startswith("PX/")
    # 40,000 + 12 x 500 - 100 = 45,900 taxable; 18% = 8,262 -> 54,162
    assert a["amount_paise"] == 5416200
    doc = (await operator.get(f"/ventures/{v}/invoices/{a['id']}/document")).json()
    assert doc["title"] == "Tax Invoice" and doc["supplier"]["gstin"] == "27AAPFU0939F1ZV"
    assert doc["supplier"]["state"] == "Maharashtra" and doc["place_of_supply"] == {"code": "27", "name": "Maharashtra"}
    assert (doc["taxable_paise"], doc["cgst_paise"], doc["sgst_paise"], doc["igst_paise"]) == (4590000, 413100, 413100, 0)
    assert [i["qty"] for i in doc["items"]] == ["1", "12"] and doc["items"][1]["taxable_paise"] == 590000
    assert doc["amount_in_words"] == "Rupees Fifty Four Thousand One Hundred Sixty Two Only"
    assert doc["terms"].startswith("Bank: HDFC") and len(doc["tax_summary"]) == 2

    # another state: IGST; the numbers run on
    b = (await operator.post(f"/ventures/{v}/invoices/gst",
                             json=body(customer_gstin=GSTIN_KA, items=[{"description": "Logo", "hsn_sac": "998391",
                                                                        "qty": "1", "rate_paise": 1000000,
                                                                        "gst_rate": "18"}]))).json()
    assert b["number"].endswith("/0002") and b["amount_paise"] == 1180000
    d2 = (await operator.get(f"/ventures/{v}/invoices/{b['id']}/document")).json()
    assert d2["igst_paise"] == 180000 and d2["cgst_paise"] == 0 and d2["place_of_supply"]["code"] == "29"
    # an unregistered customer: place of supply defaults to the business's state
    c = (await operator.post(f"/ventures/{v}/invoices/gst",
                             json=body(customer_gstin=None, items=[{"description": "Banner", "qty": "2",
                                                                    "rate_paise": 150050, "gst_rate": "5"}]))).json()
    assert c["amount_paise"] == 300100 + 15006 + 0 or c["amount_paise"] == 315106
    bad = await operator.post(f"/ventures/{v}/invoices/gst",
                              json=body(items=[{"description": "x", "qty": "1", "rate_paise": 100, "gst_rate": "7"}]))
    assert bad.status_code == 422

    # issued means issued: no re-pricing or renumbering, but contacts and due date may change
    assert (await operator.patch(f"/ventures/{v}/invoices/{a['id']}", json={"amount_paise": 100})).status_code == 409
    assert (await operator.patch(f"/ventures/{v}/invoices/{a['id']}", json={"number": "X"})).status_code == 409
    ok = await operator.patch(f"/ventures/{v}/invoices/{a['id']}", json={"customer_phone": "+91 98111 22233"})
    assert ok.status_code == 200

    # the customer sees the same document from the payment page
    token = a["pay_url"].rsplit("/", 1)[1]
    pub = (await client.get(f"/public/pay/{token}/document")).json()
    assert pub["number"] == a["number"] and pub["total_paise"] == 5416200
    assert (await client.get("/public/pay/" + "f" * 32 + "/document")).status_code == 404
    assert (await firm["mallory"].get(f"/ventures/{v}/invoices/{a['id']}/document")).status_code == 404
