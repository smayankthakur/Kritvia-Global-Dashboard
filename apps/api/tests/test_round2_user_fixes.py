"""Test report round 2, owner-side fixes that need the API: a bill marked paid by mistake can be reopened (U3),
a recorded bank line can be taken back (U7), a draft invoice can be issued after its due date passed (U8), and a
campaign isn't created twice when sending it fails (U9)."""
from __future__ import annotations

import uuid
from datetime import date, timedelta

from test_fill_gaps import HDFC, admin, shop  # noqa: F401  (shop is a fixture)


async def test_a_bill_marked_paid_or_cancelled_by_mistake_can_be_reopened(shop):  # noqa: F811
    o, v = shop["owner"], shop["v"]
    b = (await o.post(f"/ventures/{v}/bills", json={"vendor": "Sharma Traders", "amount_paise": 1240000,
                                                     "due_on": str(date.today() + timedelta(days=30))})).json()
    paid = (await o.post(f"/ventures/{v}/bills/{b['id']}/paid", json={})).json()
    assert paid["status"] == "paid"
    back = await o.post(f"/ventures/{v}/bills/{b['id']}/reopen")
    assert back.status_code == 200, back.text
    assert back.json()["status"] == "open" and back.json()["balance_paise"] == 1240000 and back.json()["paid_on"] is None
    assert (await o.patch(f"/ventures/{v}/bills/{b['id']}", json={"status": "cancelled"})).json()["status"] == "cancelled"
    assert (await o.post(f"/ventures/{v}/bills/{b['id']}/reopen")).json()["status"] == "open"


async def test_a_recorded_bank_line_can_be_taken_back(shop):  # noqa: F811
    o, v = shop["owner"], shop["v"]
    inv = (await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Asha Foods", "number": "INV 0042",
                                                         "amount_paise": 1180000,
                                                         "due_on": str(date.today() + timedelta(days=5))})).json()
    bill = (await o.post(f"/ventures/{v}/bills", json={"vendor": "Sharma Traders", "number": "ST/1",
                                                        "amount_paise": 500000, "due_on": str(date.today() + timedelta(days=30))})).json()
    await o.post(f"/ventures/{v}/bank/statements", files={"file": ("hdfc.csv", HDFC.encode(), "text/csv")})
    assert (await o.post(f"/ventures/{v}/bank/confirm-sure")).json()["confirmed"] == 2
    recorded = (await o.get(f"/ventures/{v}/bank/lines", params={"state": "confirmed"})).json()["lines"]
    for line in recorded:
        r = await o.post(f"/ventures/{v}/bank/lines/{line['id']}/reset")
        assert r.status_code == 200, r.text
        assert r.json()["state"] in ("unmatched", "suggested")
    assert (await o.get(f"/ventures/{v}/invoices", params={"show": "open"})).json()["totals"]["outstanding_paise"] == 1180000
    assert not await admin("SELECT 1 FROM invoice_payments WHERE invoice_id = $1", uuid.UUID(inv["id"]))
    bills = (await o.get(f"/ventures/{v}/bills", params={"show": "open"})).json()["bills"]
    assert [x["balance_paise"] for x in bills if x["id"] == bill["id"]] == [500000]
    # and a line can then be matched by hand to the invoice it really pays
    credit = next(x for x in (await o.get(f"/ventures/{v}/bank/lines", params={"state": "all"})).json()["lines"]
                  if x["amount_paise"] == 1180000)
    done = await o.post(f"/ventures/{v}/bank/lines/{credit['id']}/confirm",
                        json={"match_kind": "invoice", "match_id": inv["id"]})
    assert done.status_code == 200 and done.json()["state"] == "confirmed"
