"""Tally Prime XML import: vouchers, receivables, a cited document; re-import is idempotent."""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio

DAYBOOK = """<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
 <VOUCHER REMOTEID="r1" VCHTYPE="Sales" ACTION="Create">
  <DATE>20260901</DATE><GUID>g-1</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-101</VOUCHERNUMBER>
  <PARTYLEDGERNAME>Acme Foods</PARTYLEDGERNAME><NARRATION>Website build phase 1</NARRATION>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Foods</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-118000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>100000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output GST</LEDGERNAME><AMOUNT>18000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER>
 <VOUCHER REMOTEID="r2" VCHTYPE="Receipt" ACTION="Create">
  <DATE>20260910</DATE><GUID>g-2</GUID><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>R-7</VOUCHERNUMBER>
  <PARTYLEDGERNAME>Acme Foods</PARTYLEDGERNAME><NARRATION>Part payment NEFT</NARRATION>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme Foods</LEDGERNAME><AMOUNT>50000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><AMOUNT>-50000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER>
 <VOUCHER REMOTEID="r3" VCHTYPE="Purchase" ACTION="Create">
  <DATE>20260912</DATE><GUID>g-3</GUID><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>P-3</VOUCHERNUMBER>
  <PARTYLEDGERNAME>Cloud Host Ltd</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cloud Host Ltd</LEDGERNAME><AMOUNT>12000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Hosting expenses</LEDGERNAME><AMOUNT>-12000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 </VOUCHER>
</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>"""


async def test_import_overview_and_reimport(world):
    mayank, v = world["mayank"], world["site"]
    r = await mayank.post(f"/ventures/{v}/connectors/tally/import", files={"file": ("daybook.xml", DAYBOOK.encode(), "text/xml")})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["imported"] == 3 and out["updated"] == 0
    assert out["period_from"] == "2026-09-01" and out["period_to"] == "2026-09-12"
    assert out["by_type"]["Sales"] == {"count": 1, "total": "118000.00"}
    assert out["outstanding"] == {"Acme Foods": "68000.00"}
    assert out["document_id"]

    ov = (await mayank.get(f"/ventures/{v}/tally")).json()
    assert ov["vouchers"] == 3
    recv = ov["receivables"]
    assert len(recv) == 1 and recv[0]["party"] == "Acme Foods" and recv[0]["outstanding_inr"] == "68000.00"
    assert [x["voucher_number"] for x in ov["recent"]] == ["P-3", "R-7", "S-101"]
    found = (await mayank.get(f"/ventures/{v}/tally", params={"q": "NEFT"})).json()
    assert [x["voucher_number"] for x in found["recent"]] == ["R-7"]

    # the import is a cited document in Knowledge, and the connector shows as active
    docs = (await mayank.get(f"/ventures/{v}/documents")).json()
    assert any(d["id"] == out["document_id"] and d["title"].startswith("Tally 2026-09-01") for d in docs)
    conns = (await mayank.get(f"/ventures/{v}/connectors")).json()
    assert any(c["provider"] == "tally" and c["status"] == "active" for c in conns)

    # importing the same period again updates rather than duplicates
    r2 = await mayank.post(f"/ventures/{v}/connectors/tally/import", files={"file": ("daybook.xml", DAYBOOK.encode(), "text/xml")})
    assert r2.json()["imported"] == 0 and r2.json()["updated"] == 3
    assert (await mayank.get(f"/ventures/{v}/tally")).json()["vouchers"] == 3

    # another org sees nothing; operators cannot import
    assert (await world["mallory"].get(f"/ventures/{v}/tally")).status_code == 404
    bad = await world["alice"].post(f"/ventures/{v}/connectors/tally/import", files={"file": ("x.xml", DAYBOOK.encode(), "text/xml")})
    assert bad.status_code == 404
    junk = await mayank.post(f"/ventures/{v}/connectors/tally/import", files={"file": ("x.xml", b"<html>no</html>", "text/xml")})
    assert junk.status_code == 422
