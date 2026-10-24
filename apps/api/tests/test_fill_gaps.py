"""Phase 3, Fill the gaps: bank statements matched to invoices and bills, supplier bills and their reminders,
the GSTR-1 export, the Tally companion sync, Google Business Profile replies, social posts and campaigns."""
from __future__ import annotations

import io
import json
import uuid
from datetime import date, timedelta

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN
from kritvia_api.services import bank, gstr1
from kritvia_api.services.mailer import get_mailer
from kritvia_api.services.xlsx import workbook
from test_pricing import _org


async def admin(sql: str, *args):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


def mail_to(part: str) -> list:
    return [m for m in get_mailer().outbox if part in m["Subject"]]


@pytest.fixture
async def shop(client, monkeypatch):
    owner, org, v = await _org(client, monkeypatch, plan_code="growth", kind="software")
    name = f"Gaps {uuid.uuid4().hex[:6]}"
    await owner.put(f"/ventures/{v}/settings", json={"kind": "software", "business_name": name, "city": "Delhi"})
    return {"owner": owner, "org": org, "v": v, "name": name}


# --------------------------------------------------------------------------------- statements --
HDFC = """HDFC BANK Ltd.  Statement of account
Account No : 50100123456789

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/10/26,UPI-ASHA FOODS PVT LTD-ashafoods@okhdfc-UTIB0000123-627481234567-INV 0042,0000627481234567,01/10/26,,"11,800.00","61,800.00"
02/10/26,NEFT DR-SBIN0001234-SHARMA TRADERS-NETBANK,N123456789,02/10/26,"5,000.00",,"56,800.00"
03/10/26,SALARY OCT RAHUL,,03/10/26,"20,000.00",,"36,800.00"
04/10/26,UPI-RANDOM PERSON-xyz@ybl-9999,0000627000000001,04/10/26,,"2,500.00","39,300.00"
,,,,,,
"""

ICICI = """S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )
1,01/10/2026,01/10/2026,-,UPI/627481234567/ASHA FOODS,0.00,11800.00,61800.00
2,02/10/2026,02/10/2026,-,NEFT/SHARMA TRADERS,5000.00,0.00,56800.00
"""

SBI_TEXT = """STATE BANK OF INDIA
Txn Date Value Date Description Ref No. Debit Credit Balance
Opening Balance 50,000.00
1 Oct 2026 1 Oct 2026 BY TRANSFER-UPI/CR/627481234567/ASHA FOODS 11,800.00 61,800.00
2 Oct 2026 2 Oct 2026 TO TRANSFER-NEFT SHARMA
TRADERS PAYMENT 5,000.00 56,800.00
"""


def test_reads_the_common_bank_formats():
    st = bank.read(HDFC.encode(), "statement.csv")
    assert [x.amount_paise for x in st.lines] == [1180000, -500000, -2000000, 250000]
    assert st.lines[0].day == date(2026, 10, 1) and st.lines[0].reference == "0000627481234567"
    assert st.credits == 1430000 and st.debits == 2500000
    ic = bank.read(ICICI.encode(), "OpTransactionHistory.csv")
    assert [x.amount_paise for x in ic.lines] == [1180000, -500000]
    rows = [["Txn Date", "Description", "Debit", "Credit", "Balance"],
            ["01-10-2026", "UPI ASHA FOODS", "", "11800.00", "61800"], ["02-10-2026", "SHARMA TRADERS", "5000", "", "56800"]]
    xl = bank.read(workbook([("Statement", rows)]), "statement.xlsx")
    assert [x.amount_paise for x in xl.lines] == [1180000, -500000]
    pdf = bank.from_text(SBI_TEXT)
    assert [x.amount_paise for x in pdf.lines] == [1180000, -500000]
    assert pdf.lines[0].reference == "627481234567"
    with pytest.raises(bank.StatementError):
        bank.read(b"hello,world\n1,2\n", "x.csv")
    # the same line in an overlapping statement is the same line
    assert bank.read(HDFC.encode(), "a.csv").lines[0].fingerprint == st.lines[0].fingerprint


def test_matching_is_sure_only_when_the_narration_names_them():
    inv = [bank.Open("i1", "Asha Foods Pvt Ltd", "INV 0042", 1180000), bank.Open("i2", "Bina Sweets", "", 1180000),
           bank.Open("i3", "Chetan Kumar", "", 99900, ref="UTR77788899")]
    bills = [bank.Open("b1", "Sharma Traders", "ST/1", 500000)]
    got = bank.match([("l1", 1180000, "UPI-ASHA FOODS PVT LTD-ashafoods@okhdfc"),
                      ("l2", -500000, "NEFT DR SHARMA TRADERS"),
                      ("l3", 99900, "IMPS UTR77788899 FROM SOMEONE"),
                      ("l4", 1180000, "UPI-UNKNOWN PAYER")], inv, bills)
    assert got["l1"] == ("invoice", bank.Match("i1", "sure"))
    assert got["l2"] == ("bill", bank.Match("b1", "sure"))
    assert got["l3"] == ("invoice", bank.Match("i3", "sure"))          # the UPI reference the customer gave
    assert got["l4"] == ("invoice", bank.Match("i2", "likely"))        # only Bina is left owing exactly that
    # two invoices owing the same and nobody named: no guess
    assert bank.match([("x", 1180000, "UPI-SOMEONE")], inv[:2], []) == {}


async def test_a_statement_pays_invoices_and_bills_after_one_tap(shop):
    o, v = shop["owner"], shop["v"]
    inv = (await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Asha Foods", "number": "INV 0042",
                                                         "amount_paise": 1180000,
                                                         "due_on": str(date.today() + timedelta(days=5))})).json()
    bill = await o.post(f"/ventures/{v}/bills", json={"vendor": "Sharma Traders", "number": "ST/1",
                                                      "amount_paise": 500000, "due_on": str(date.today())})
    assert bill.status_code == 201, bill.text
    up = await o.post(f"/ventures/{v}/bank/statements", files={"file": ("hdfc.csv", HDFC.encode(), "text/csv")},
                      data={"account_label": "HDFC current"})
    assert up.status_code == 201, up.text
    u = up.json()
    assert u["new_lines"] == 4 and u["sure"] == 2 and u["statement"]["period_to"] == "2026-10-04"
    lines = (await o.get(f"/ventures/{v}/bank/lines", params={"state": "suggested"})).json()
    assert lines["sure"] == 2 and {x["match"]["party"] for x in lines["lines"]} == {"Asha Foods", "Sharma Traders"}
    # nothing is recorded until a person says so
    assert (await o.get(f"/ventures/{v}/invoices", params={"show": "open"})).json()["totals"]["outstanding_paise"] == 1180000
    done = (await o.post(f"/ventures/{v}/bank/confirm-sure")).json()
    assert done == {"confirmed": 2, "paid_invoices": 1, "paid_bills": 1}
    paid = (await o.get(f"/ventures/{v}/invoices", params={"show": "paid"})).json()["invoices"]
    assert [x["id"] for x in paid] == [inv["id"]]
    pays = await admin("SELECT method, amount_paise, bank_line_id FROM invoice_payments WHERE invoice_id = $1",
                       uuid.UUID(inv["id"]))
    assert pays[0]["method"] == "bank" and pays[0]["amount_paise"] == 1180000 and pays[0]["bank_line_id"]
    assert (await o.get(f"/ventures/{v}/bills", params={"show": "paid"})).json()["bills"][0]["paid_ref"]
    # the same statement again: nothing new, nothing paid twice
    again = (await o.post(f"/ventures/{v}/bank/statements", files={"file": ("hdfc.csv", HDFC.encode(), "text/csv")})).json()
    assert again["new_lines"] == 0 and again["already_seen"] == 4
    # the salary isn't a customer or a supplier: ignore it, and bring it back
    un = (await o.get(f"/ventures/{v}/bank/lines", params={"state": "unmatched"})).json()["lines"]
    salary = next(x for x in un if "SALARY" in x["narration"])
    assert (await o.post(f"/ventures/{v}/bank/lines/{salary['id']}/ignore")).json()["state"] == "ignored"
    assert (await o.post(f"/ventures/{v}/bank/lines/{salary['id']}/reset")).json()["state"] == "unmatched"
    # a credit can't pay a bill
    credit = next(x for x in un if x["amount_paise"] > 0)
    bad = await o.post(f"/ventures/{v}/bank/lines/{credit['id']}/confirm",
                       json={"match_kind": "bill", "match_id": bill.json()["id"]})
    assert bad.status_code in (409, 422)


async def test_a_password_protected_pdf_is_refused(shop):
    o, v = shop["owner"], shop["v"]
    pdf = b"%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF"
    r = await o.post(f"/ventures/{v}/bank/statements", files={"file": ("s.pdf", pdf, "application/pdf")})
    assert r.status_code == 422 and "password" in r.text


# -------------------------------------------------------------------------------------- bills --
async def test_bills_double_bills_and_reminders(shop, services, fake_llm):
    from kritvia_api.services import money_watch
    o, v, name = shop["owner"], shop["v"], shop["name"]
    today = date.today()
    b = {"vendor": "Gupta Packaging", "number": "GP-77", "amount_paise": 236000, "gst_paise": 36000,
         "due_on": str(today + timedelta(days=2)), "category": "Packaging"}
    assert (await o.post(f"/ventures/{v}/bills", json=b)).status_code == 201
    dup = await o.post(f"/ventures/{v}/bills", json={**b, "vendor": "gupta packaging"})
    assert dup.status_code == 409 and "double bill" in dup.text
    await o.post(f"/ventures/{v}/bills", json={"vendor": "Landlord", "amount_paise": 2500000,
                                               "due_on": str(today - timedelta(days=1)), "category": "Rent"})
    t = (await o.get(f"/ventures/{v}/bills")).json()["totals"]
    assert t["to_pay_paise"] == 2736000 and t["overdue_count"] == 1
    before = len(mail_to("supplier bill"))
    assert await money_watch.bills_due(services, today) >= 1
    got = [m for m in mail_to("supplier bill") if name in m.get_content() or m["To"] == o.email]
    assert len(mail_to("supplier bill")) == before + 1 and "2 supplier bills to pay" in got[-1]["Subject"]
    assert "never pays" in got[-1].get_content()
    await money_watch.bills_due(services, today)           # once a day
    assert len(mail_to("supplier bill")) == before + 1
    # read from a file: the fields come back for a person to check
    fake_llm.on("You read supplier bills", {"vendor": "Fresh Dairy", "number": "FD/9", "vendor_gstin": "",
                                            "total": "4,720.00", "gst": "720", "bill_date": "2026-10-01",
                                            "due_on": "", "category": "Milk", "unsure": []})
    from kritvia_api.services import textextract

    class Ex:
        text = "TAX INVOICE Fresh Dairy FD/9 Total 4720.00"
    import kritvia_api.routers.bills as rb
    orig = rb.extract_text
    rb.extract_text = lambda *a, **k: Ex()
    try:
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 100
        r = (await o.post(f"/ventures/{v}/bills/read", files={"file": ("bill.png", png, "image/png")})).json()
    finally:
        rb.extract_text = orig
    assert r["vendor"] == "Fresh Dairy" and r["amount_paise"] == 472000 and r["gst_paise"] == 72000
    assert "due_on" in r["unsure"]
    assert textextract                                     # (imported for the patch target's module)


async def test_a_forwarded_supplier_bill_is_filed(shop, services, fake_llm, monkeypatch):
    from kritvia_api.services import email_in, pollers, textextract
    o, v = shop["owner"], shop["v"]
    fake_llm.on("You read supplier bills", {"vendor": "Speedy Couriers", "number": "SC-1001", "vendor_gstin": "",
                                            "total": "1180", "gst": "", "bill_date": "", "due_on": "2026-11-01",
                                            "category": "Courier", "unsure": []})

    class Ex:
        text = "INVOICE Speedy Couriers SC-1001 Amount payable Rs 1180"
    monkeypatch.setattr(textextract, "extract_text", lambda *a, **k: Ex())
    msg = email_in.InboundMail(id="<bill-1@x>", thread_id="", sender="Speedy", sender_email="billing@speedy.in",
                               to="", subject="Fwd: Invoice SC-1001 for October", date="", body="Please find attached",
                               attachments=[{"filename": "SC-1001.pdf", "mime": "application/pdf", "size": 900,
                                             "data": b"%PDF-1.4 ..."}])
    rows = await admin("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
    run_as = (await admin("SELECT private.provision_service_account($1, $2) AS u", rows[0]["org_id"], uuid.UUID(v)))[0]["u"]
    got = await pollers.deliver_forwarded(services, rows[0]["org_id"], uuid.UUID(v), run_as, msg)
    assert got == {"bills": 1}
    b = (await o.get(f"/ventures/{v}/bills")).json()["bills"]
    assert b[0]["vendor"] == "Speedy Couriers" and b[0]["source"] == "email" and "genuine" in b[0]["notes"]
    # an email about something else isn't a bill
    other = email_in.InboundMail(id="<x-2@x>", thread_id="", sender="A", sender_email="a@b.in", to="",
                                 subject="Lunch on Friday?", date="", body="", attachments=[])
    assert await pollers._bill_forwarded(None, services, other) is False


# ------------------------------------------------------------------------------------- GSTR-1 --
GSTIN = "07AAPFU0939F1ZX"
BUYER = "27AAPFU0939F1ZV"


def test_gstr1_sections():
    items = lambda taxable, rate, inter: [gstr1.Item(  # noqa: E731
        "998314", "Website design", __import__("decimal").Decimal(1), "nos", __import__("decimal").Decimal(rate),
        taxable, 0 if inter else taxable * rate // 200, 0 if inter else taxable * rate // 200,
        taxable * rate // 100 if inter else 0)]
    invs = [
        gstr1.Inv("INV/26-27/0001", date(2026, 9, 2), "Acme", BUYER, "27", False, 1180000, "open",
                  items(1000000, 18, True)),
        gstr1.Inv("INV/26-27/0002", date(2026, 9, 5), "Big Buyer", None, "29", False, 23600000, "paid",
                  items(20000000, 18, True)),
        gstr1.Inv("INV/26-27/0003", date(2026, 9, 9), "Walk-in", None, "07", False, 118000, "open",
                  items(100000, 18, False)),
        gstr1.Inv("INV/26-27/0004", date(2026, 9, 9), "Cancelled Co", None, "07", False, 118000, "cancelled",
                  items(100000, 18, False)),
    ]
    g = gstr1.build(GSTIN, "07", 2026, 9, invs)
    j = g["json"]
    assert j["fp"] == "092026" and j["b2b"][0]["ctin"] == BUYER
    assert j["b2b"][0]["inv"][0]["itms"][0]["itm_det"] == {"txval": 10000.0, "rt": 18, "iamt": 1800.0, "camt": 0.0,
                                                          "samt": 0.0, "csamt": 0}
    assert j["b2cl"][0]["pos"] == "29" and j["b2cl"][0]["inv"][0]["val"] == 236000.0
    assert j["b2cs"] == [{"sply_ty": "INTRA", "pos": "07", "typ": "OE", "txval": 1000.0, "rt": 18, "iamt": 0.0,
                          "camt": 90.0, "samt": 90.0, "csamt": 0}]
    assert j["doc_issue"]["doc_det"][0]["docs"][0] == {"num": 1, "from": "INV/26-27/0001", "to": "INV/26-27/0004",
                                                       "totnum": 4, "cancel": 1, "net_issue": 3}
    assert g["totals"]["invoices"] == 3 and g["totals"]["b2b"] == 1 and g["totals"]["b2cl"] == 1
    sheets = dict(g["sheets"])
    assert sheets["b2b"][1][:4] == [BUYER, "Acme", "INV/26-27/0001", "02-Sep-2026"]
    assert sheets["b2b"][1][5] == "27-Maharashtra"
    # the workbook opens (read back with Kritvia's own statement reader)
    rows = bank._xlsx_rows(workbook(g["sheets"]))
    assert rows[0][0] == "GSTIN/UIN of Recipient" and rows[1][2] == "INV/26-27/0001"


async def test_gstr1_download_and_reminder(shop, services):
    from kritvia_api.services import money_watch
    o, v = shop["owner"], shop["v"]
    r = await o.put(f"/ventures/{v}/gst-profile", json={"legal_name": "Gaps Pvt Ltd", "gstin": GSTIN,
                                                        "address": "Nihal Vihar, New Delhi", "prefix": "GP"})
    assert r.status_code == 200, r.text
    last = date.today().replace(day=1) - timedelta(days=1)
    for buyer, pos in ((BUYER, "27"), (None, "07")):
        r = await o.post(f"/ventures/{v}/invoices/gst", json={
            "customer_name": "Acme" if buyer else "Walk-in", "customer_gstin": buyer, "place_of_supply": pos,
            "issued_on": str(last), "due_on": str(last + timedelta(days=15)),
            "items": [{"description": "Website design", "hsn_sac": "998314", "qty": 1, "rate_paise": 1000000,
                       "gst_rate": 18}]})
        assert r.status_code == 201, r.text
    month = last.strftime("%Y-%m")
    s = (await o.get(f"/ventures/{v}/gst/gstr1", params={"month": month})).json()
    assert s["totals"]["invoices"] == 2 and s["totals"]["b2b"] == 1 and s["problems"] == []
    x = await o.get(f"/ventures/{v}/gst/gstr1/file", params={"month": month})
    assert x.status_code == 200 and x.content[:2] == b"PK" and "GSTR1_" in x.headers["content-disposition"]
    js = (await o.get(f"/ventures/{v}/gst/gstr1/file", params={"month": month, "format": "json"})).json()
    assert js["gstin"] == GSTIN and js["b2b"][0]["inv"][0]["pos"] == "27"
    assert (await o.get(f"/ventures/{v}/gst/gstr1", params={"month": "2026-13"})).status_code == 422
    before = len(mail_to("GSTR-1 for"))
    third = date.today().replace(day=3)
    assert await money_watch.gstr1_ready(services, third) >= 1
    assert len(mail_to("GSTR-1 for")) == before + 1
    assert await money_watch.gstr1_ready(services, third.replace(day=4)) == 0


# -------------------------------------------------------------------------------------- Tally --
DAYBOOK = """<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><VOUCHER VCHTYPE="Sales"><GUID>g-1</GUID><DATE>20261001</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
<VOUCHERNUMBER>T-1</VOUCHERNUMBER><PARTYLEDGERNAME>Old Customer</PARTYLEDGERNAME>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Old Customer</LEDGERNAME><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>"""


async def test_the_tally_companion_syncs_both_ways(shop, client):
    o, v = shop["owner"], shop["v"]
    await admin("SELECT set_org_plan($1, 'scale', now() + interval '30 days')", uuid.UUID(shop["org"]))
    k = await o.post(f"/ventures/{v}/connectors/tally/sync-key")
    assert k.status_code == 200, k.text
    key, url = k.json()["key"], k.json()["hook_url"]
    cid = k.json()["connector_id"]
    assert url.endswith(f"/hooks/tally/{cid}")
    bad = await client.post(f"/hooks/tally/{cid}/import", content=DAYBOOK, headers={"x-kritvia-key": "kts_wrong"})
    assert bad.status_code == 401
    r = await client.post(f"/hooks/tally/{cid}/import", content=DAYBOOK, headers={"x-kritvia-key": key})
    assert r.status_code == 201, r.text
    assert r.json()["imported"] == 1
    inv = (await o.post(f"/ventures/{v}/invoices", json={"customer_name": "New & Co", "number": "K-1",
                                                         "amount_paise": 250050, "issued_on": "2026-10-02",
                                                         "due_on": "2026-10-20"})).json()
    s = (await client.get(f"/hooks/tally/{cid}/sales", headers={"x-kritvia-key": key})).json()
    assert [x["number"] for x in s["vouchers"]] == ["K-1"]
    xml = s["vouchers"][0]["xml"]
    assert "<VOUCHERNUMBER>K-1</VOUCHERNUMBER>" in xml and "New &amp; Co" in xml and "<AMOUNT>-2500.50</AMOUNT>" in xml
    assert "<LEDGERNAME>Sales</LEDGERNAME>" in xml and "<DATE>20261002</DATE>" in xml
    a = (await client.post(f"/hooks/tally/{cid}/sales/ack", json={"invoice_ids": [inv["id"]]},
                           headers={"x-kritvia-key": key})).json()
    assert a == {"synced": 1}
    assert (await client.get(f"/hooks/tally/{cid}/sales", headers={"x-kritvia-key": key})).json()["vouchers"] == []
    st = (await o.get(f"/ventures/{v}/connectors/tally/sync")).json()
    assert st["has_key"] and st["last_sync"] and st["waiting_invoices"] == 0
    # a new key: the old one stops working
    await o.post(f"/ventures/{v}/connectors/tally/sync-key")
    assert (await client.get(f"/hooks/tally/{cid}/sales", headers={"x-kritvia-key": key})).status_code == 401


# ------------------------------------------------------------------ Google profile and social --
class FakeGoogle:
    def __init__(self):
        self.replies: list[tuple[str, dict]] = []
        self.posts: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "oauth2.googleapis.com/token" in u:
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        if u.startswith("https://mybusinessaccountmanagement.googleapis.com/v1/accounts"):
            return httpx.Response(200, json={"accounts": [{"name": "accounts/111"}]})
        if "mybusinessbusinessinformation" in u:
            return httpx.Response(200, json={"locations": [{"name": "locations/222", "title": "Gaps Studio",
                                                            "storefrontAddress": {"addressLines": ["Nihal Vihar"],
                                                                                  "locality": "Delhi"}}]})
        if request.method == "GET" and u.split("?")[0].endswith("/reviews"):
            return httpx.Response(200, json={"reviews": [
                {"name": "accounts/111/locations/222/reviews/r1", "starRating": "FIVE",
                 "reviewer": {"displayName": "Priya Sharma"}, "comment": "Lovely website, quick work!"},
                {"name": "accounts/111/locations/222/reviews/r2", "starRating": "TWO",
                 "reviewer": {"displayName": "Old Customer"}, "comment": "Late", "reviewReply": {"comment": "Sorry"}}]})
        if request.method == "PUT" and u.endswith("/reply"):
            self.replies.append((u, json.loads(request.content)))
            return httpx.Response(200, json={"comment": "ok"})
        if request.method == "POST" and u.endswith("/localPosts"):
            self.posts.append((u, json.loads(request.content)))
            return httpx.Response(200, json={"name": "accounts/111/locations/222/localPosts/p1"})
        return httpx.Response(404, json={})


@pytest.fixture
def google(services, monkeypatch):
    from kritvia_api.services.google import GoogleClient
    fake = FakeGoogle()
    g = GoogleClient("cid", "secret", "http://x", transport=httpx.MockTransport(fake))
    monkeypatch.setattr(services, "google", g)
    return fake


async def connect_google(shop, services):
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.google import SCOPES
    async with tenant_tx(shop["owner"].id) as conn:
        cid = (await conn.execute(__import__("sqlalchemy").text(
            "INSERT INTO connectors (org_id, venture_id, provider, account_email, scopes)"
            " VALUES (:o, :v, 'google', 'owner@gaps.in', :s) RETURNING id"),
            {"o": uuid.UUID(shop["org"]), "v": uuid.UUID(shop["v"]),
             "s": ["openid", SCOPES["gmail.send"], SCOPES["business.manage"]]})).scalar_one()
        enc = await EnvelopeCrypto(conn, services.keys).encrypt(uuid.UUID(shop["v"]), "connector.secret", "rt-1")
        await conn.execute(__import__("sqlalchemy").text(
            "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"),
            {"c": cid, "o": uuid.UUID(shop["org"]), "v": uuid.UUID(shop["v"]), "s": enc})


async def test_review_replies_are_posted_on_google_after_a_yes(shop, services, google, fake_llm):
    o, v = shop["owner"], shop["v"]
    await connect_google(shop, services)
    locs = (await o.get(f"/ventures/{v}/business-profile/locations")).json()
    assert locs == [{"name": "accounts/111/locations/222", "title": "Gaps Studio", "address": "Nihal Vihar, Delhi"}]
    assert (await o.put(f"/ventures/{v}/business-profile", json={"name": locs[0]["name"], "title": "Gaps Studio"})).status_code == 200
    await o.put(f"/ventures/{v}/workflow-configs/reviews", json={"enabled": True})
    fake_llm.on("public reply to a Google review", {"reply": "Thank you Priya! It was a joy to build."})
    r = await o.post(f"/ventures/{v}/runs", json={"workflow": "reviews", "input": {}})
    assert r.status_code == 201, r.text
    watch = (await o.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert watch["summary"]["replies_drafted"] == 1, watch            # the one already answered is left alone
    pending = [a for a in (await o.get(f"/ventures/{v}/approvals?status=pending")).json()
               if a["action"] == "google.review_reply"]
    assert len(pending) == 1 and "Priya" in pending[0]["title"]
    # only the text can change
    bad = await o.post(f"/ventures/{v}/approvals/{pending[0]['id']}/decision", json={
        "decision": "approve", "edited_payload": {"review_name": "accounts/1/locations/2/reviews/zzz"}})
    assert bad.status_code == 422
    ok = await o.post(f"/ventures/{v}/approvals/{pending[0]['id']}/decision", json={
        "decision": "approve", "edited_payload": {"comment": "Thank you so much, Priya!"}})
    assert ok.status_code == 200, ok.text
    assert google.replies == [("https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews/r1/reply",
                               {"comment": "Thank you so much, Priya!"})]
    rows = await admin("SELECT status, posted_at FROM review_replies WHERE venture_id = $1", uuid.UUID(v))
    assert rows[0]["status"] == "posted" and rows[0]["posted_at"]


async def test_social_posts_go_to_google_and_facebook_after_a_yes(shop, services, google, fake_llm, monkeypatch):
    from kritvia_api.services import facebook
    o, v = shop["owner"], shop["v"]
    fb_posts = []

    def fb(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"name": "Gaps Studio", "id": "123456789"})
        fb_posts.append(dict(__import__("urllib.parse").parse.parse_qsl(request.content.decode())))
        return httpx.Response(200, json={"id": "123456789_99"})
    monkeypatch.setattr(facebook, "_transport", httpx.MockTransport(fb))
    # nowhere to post yet: a post is still written, to copy by hand (round 3, A14)
    assert (await o.post(f"/ventures/{v}/social/draft-now")).status_code == 200
    r = await o.put(f"/ventures/{v}/connectors/facebook", json={"page_id": "123456789", "page_token": "EAAG" + "x" * 30})
    assert r.status_code == 200, r.text
    assert r.json()["page_name"] == "Gaps Studio"
    await connect_google(shop, services)
    await o.put(f"/ventures/{v}/business-profile", json={"name": "accounts/111/locations/222", "title": "Gaps Studio"})
    s = (await o.get(f"/ventures/{v}/social")).json()
    assert set(s["channels"]) == {"google", "facebook"} and "EAAG" not in json.dumps(s)
    await o.put(f"/ventures/{v}/workflow-configs/social", json={"enabled": True, "settings": {
        "offers": "Diwali website package ₹14,999 till 5 Nov"}})
    fake_llm.on("social media posts", {"topic": "Diwali package", "body": "This Diwali, get your shop online. #Diwali"})
    started = await o.post(f"/ventures/{v}/social/draft-now")
    assert started.status_code == 200, started.text
    prompt = fake_llm.chat_calls("social media posts")[-1]["prompt"]
    assert "₹14,999" in prompt
    a = next(x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json() if x["action"] == "social.post")
    ok = await o.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={
        "decision": "approve", "edited_payload": {"body": "This Diwali, get your shop online with us. #Diwali"}})
    assert ok.status_code == 200, ok.text
    assert google.posts[-1][1]["summary"] == "This Diwali, get your shop online with us. #Diwali"
    assert fb_posts[-1]["message"] == "This Diwali, get your shop online with us. #Diwali"
    post = (await o.get(f"/ventures/{v}/social")).json()["posts"][0]
    assert post["status"] == "posted" and post["results"]["facebook"]["id"] == "123456789_99"
    # not on a day the owner didn't choose
    await o.put(f"/ventures/{v}/workflow-configs/social", json={"enabled": True, "settings": {"post_days": "none"}})


# ----------------------------------------------------------------------------------- campaigns --
async def test_an_email_campaign_goes_to_customers_once_and_honours_unsubscribe(shop, client):
    from kritvia_api.services import campaigns as cs
    o, v = shop["owner"], shop["v"]
    for n, e in (("Asha", "asha@example.com"), ("Bina", "bina@example.com"), ("Asha again", "ASHA@example.com")):
        await o.post(f"/ventures/{v}/invoices", json={"customer_name": n, "customer_email": e, "amount_paise": 10000,
                                                      "due_on": str(date.today())})
    size = (await o.get(f"/ventures/{v}/campaigns/audience", params={"channel": "email", "audience": "customers"})).json()
    assert size == {"people": 2, "capped": False}
    assert (await o.post(f"/ventures/{v}/campaigns", json={"name": "x", "channel": "email", "audience": "opted_in",
                                                           "subject": "s", "body": "b"})).status_code == 422
    c = (await o.post(f"/ventures/{v}/campaigns", json={"name": "Diwali offer", "channel": "email",
                                                        "audience": "customers", "subject": "Diwali at Gaps",
                                                        "body": "20% off websites till 5 Nov."})).json()
    assert c["status"] == "draft"
    assert (await o.post(f"/ventures/{v}/campaigns/{c['id']}/send")).status_code == 200
    a = next(x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json() if x["action"] == "campaign.send")
    assert a["title"] == "Send 'Diwali offer' to 2 people" and a["payload"]["recipients"] == 2
    # the list and wording are fixed
    bad = await o.post(f"/ventures/{v}/approvals/{a['id']}/decision",
                       json={"decision": "approve", "edited_payload": {"recipients": 500}})
    assert bad.status_code == 422
    assert (await o.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})).status_code == 200
    got = [x for x in (await o.get(f"/ventures/{v}/campaigns")).json() if x["id"] == c["id"]][0]
    assert got["status"] == "sent" and got["sent"] == 2, got
    sent = await admin("SELECT recipient, status FROM outbox_messages WHERE approval_id = $1 ORDER BY recipient",
                       uuid.UUID(a["id"]))
    assert [r["recipient"] for r in sent] == ["asha@example.com", "bina@example.com"]
    # Bina unsubscribes with the link from her email
    token = cs.unsubscribe_token(uuid.UUID(v), "bina@example.com")
    r = await client.post("/public/campaign-unsubscribe", json={"token": token})
    assert r.status_code == 200 and r.json()["ok"]
    assert (await client.post("/public/campaign-unsubscribe", json={"token": token[:-3] + "AAA"})).status_code == 400
    size = (await o.get(f"/ventures/{v}/campaigns/audience", params={"channel": "email", "audience": "customers"})).json()
    assert size["people"] == 1


async def test_a_whatsapp_campaign_only_reaches_people_who_agreed(shop, client, services, fake_llm):
    from test_inbox_assistant import APP_SECRET, VERIFY
    from test_whatsapp_front_door import hook
    from test_whatsapp_templates import FakeGraph, template_status

    from kritvia_api.services.whatsapp import WhatsAppClient
    o, v = shop["owner"], shop["v"]
    pnid, waba = f"55{uuid.uuid4().int % 10**8:08d}", f"77{uuid.uuid4().int % 10**8:08d}"
    graph = FakeGraph(pnid, waba)
    wa = WhatsAppClient(APP_SECRET, VERIFY, transport=httpx.MockTransport(graph))
    old = services.whatsapp, services.messaging.whatsapp
    services.whatsapp = services.messaging.whatsapp = wa
    try:
        r = await o.post(f"/ventures/{v}/connectors/whatsapp",
                         json={"phone_number_id": pnid, "access_token": "EAAB" + "g" * 40, "waba_id": waba})
        assert r.status_code == 201, r.text
        r = await o.post(f"/ventures/{v}/whatsapp/templates", json={
            "label": "Festive offer", "category": "MARKETING", "body": "Hi! {{1}} at Gaps this week. Reply STOP to stop.",
            "examples": ["20% off websites"]})
        assert r.status_code == 201, r.text
        await hook(client, template_status("APPROVED", graph.templates["festive_offer"]["id"], "festive_offer", waba=waba))
        tid = r.json()["id"]
        org = uuid.UUID(shop["org"])
        for phone, name, opted_in, out in (("919811100101", "Neha", True, False), ("919811100102", "Ravi", True, True),
                                           ("919811100103", "Stranger", False, False)):
            await admin("INSERT INTO wa_contacts (org_id, venture_id, phone, name, opted_in_at, opt_in_source,"
                        " opted_out_at) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END,"
                        " CASE WHEN $5 THEN 'wrote_first' END, CASE WHEN $6 THEN now() END)",
                        org, uuid.UUID(v), phone, name, opted_in, out)
        c = (await o.post(f"/ventures/{v}/campaigns", json={"name": "Festive", "channel": "whatsapp",
                                                            "audience": "opted_in", "template_id": tid,
                                                            "params": ["20% off websites"]})).json()
        assert c["status"] == "draft", c
        await o.post(f"/ventures/{v}/campaigns/{c['id']}/send")
        a = next(x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json()
                 if x["action"] == "campaign.send")
        assert a["payload"]["recipients"] == 1 and "20% off websites" in a["payload"]["message"]
        await o.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
        sends = [m for m in graph.sent if m.get("type") == "template"]
        assert [m["to"] for m in sends] == ["919811100101"]
        got = [x for x in (await o.get(f"/ventures/{v}/campaigns")).json() if x["id"] == c["id"]][0]
        assert got["status"] == "sent" and got["sent"] == 1
    finally:
        services.whatsapp, services.messaging.whatsapp = old


async def test_a_campaign_can_be_stopped_before_its_yes(shop):
    o, v = shop["owner"], shop["v"]
    await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Zed", "customer_email": "zed@example.com",
                                                  "amount_paise": 10000, "due_on": str(date.today())})
    c = (await o.post(f"/ventures/{v}/campaigns", json={"name": "Oops", "channel": "email", "audience": "customers",
                                                        "subject": "s", "body": "b"})).json()
    await o.post(f"/ventures/{v}/campaigns/{c['id']}/send")
    r = await o.post(f"/ventures/{v}/campaigns/{c['id']}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert not [x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json() if x["action"] == "campaign.send"]
    assert (await o.delete(f"/ventures/{v}/campaigns/{c['id']}")).status_code == 204


def test_xlsx_round_trip():
    data = workbook([("One", [["a", 1, 2.5], ["b & c", None, "x"]])])
    assert bank._xlsx_rows(data) == [["a", "1", "2.5"], ["b & c", "", "x"]]
    assert io


def test_the_tally_companion_reads_tallys_answers():
    import importlib.util
    from pathlib import Path
    root = Path(__file__).resolve().parents[3]
    src = root / "infra/tally/kritvia_tally_sync.py"
    spec = importlib.util.spec_from_file_location("kritvia_tally_sync", src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.created("<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS></RESPONSE>")
    assert not mod.created("<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger 'Sales' does not exist</LINEERROR></RESPONSE>")
    req = mod.daybook_request({"days": "3", "company": ""})
    assert "<ID>Day Book</ID>" in req and "<SVFROMDATE>" in req
    # the copy the web app offers for download is the same program
    for name in ("kritvia_tally_sync.py", "kritvia_tally_sync.example.ini"):
        web = root / "apps/web/public/downloads" / name
        assert web.read_bytes() == (root / "infra/tally" / name).read_bytes(), name
