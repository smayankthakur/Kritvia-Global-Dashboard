"""Phase 5, Grow and plan ahead: the cash position ahead, bank statements by email, one answer per forwarded
email, campaign ideas for festivals and slow weeks, the weekly Google listing check, and ads against leads."""
from __future__ import annotations

import io
import json
import uuid
from datetime import date, timedelta

import httpx
import pytest

from kritvia_api.services import ads, bank, cash, email_in, occasions
from kritvia_api.workflows.lead_triage import ad_tags
from test_fill_gaps import HDFC, FakeGoogle, admin, connect_google, mail_to
from test_pricing import _org


@pytest.fixture
async def shop(client, monkeypatch):
    owner, org, v = await _org(client, monkeypatch, plan_code="growth", kind="software")
    name = f"Plan {uuid.uuid4().hex[:6]}"
    await owner.put(f"/ventures/{v}/settings", json={"kind": "software", "business_name": name, "city": "Delhi"})
    return {"owner": owner, "org": org, "v": v, "name": name}


async def run_as_of(v: str) -> tuple[uuid.UUID, uuid.UUID]:
    org = (await admin("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v)))[0]["org_id"]
    ra = (await admin("SELECT private.provision_service_account($1, $2) AS u", org, uuid.UUID(v)))[0]["u"]
    return org, ra


# ------------------------------------------------------------------------------------------- cash --
def test_the_forecast_expects_money_when_each_customer_usually_pays():
    today = date(2026, 10, 19)
    f = cash.build(
        today,
        open_invoices=[("Asha Foods", 100000, today + timedelta(days=3)),     # pays 10 days late -> day 13 (week 2)
                       ("New Co", 50000, today + timedelta(days=1)),          # new: the usual lateness (10) -> week 2
                       ("Old Debt", 70000, today - timedelta(days=120))],     # doubtful: left out
        paid_history=[("asha foods", 10), ("Asha Foods", 10), ("Other", 8)],
        open_bills=[(30000, today - timedelta(days=2)), (20000, today + timedelta(days=20))],
        salaries_paise=40000, fixed_paise=10000, opening=(200000, today - timedelta(days=1), "statement"),
        alert_below_paise=180000)
    assert f.usual_late_days == 10
    assert f.weeks[0].out_paise == 30000 and f.weeks[0].in_paise == 0           # the overdue bill is this week
    assert f.weeks[1].in_paise == 150000
    assert f.weeks[1].out_paise == 50000            # 1 Nov falls in the second week: salaries + fixed costs
    assert f.weeks[1].closing_paise == 200000 - 30000 + 150000 - 50000
    assert f.doubtful_paise == 70000 and f.doubtful_invoices == 1
    h30 = next(h for h in f.horizons if h.days == 30)
    assert h30.in_paise == 150000 and h30.out_paise == 30000 + 20000 + 50000
    assert f.below_alert and f.lowest_paise == 150000 and f.lowest_week == date(2026, 12, 28)
    subject, body = cash.note(f)
    assert subject == "Cash: a tight week ahead" and "₹2,000 in the bank" in body and "not a promise" in body
    bare = cash.build(today, open_invoices=[], paid_history=[], open_bills=[], salaries_paise=0, fixed_paise=0,
                      opening=None, alert_below_paise=None)
    assert not bare.below_alert and bare.opening_paise is None and "net flows" in bare.notes[0]


async def test_cash_settings_forecast_and_the_monday_note(shop, services):
    o, v = shop["owner"], shop["v"]
    today = date.today()
    await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Asha Foods", "amount_paise": 500000,
                                                  "due_on": str(today + timedelta(days=4))})
    await o.post(f"/ventures/{v}/bills", json={"vendor": "Landlord", "amount_paise": 800000,
                                               "due_on": str(today + timedelta(days=2))})
    r = await o.put(f"/ventures/{v}/cash/settings", json={"balance_paise": 100000, "monthly_fixed_paise": 0,
                                                          "alert_below_paise": 50000, "statement_password": "CUST1234"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["balance_paise"] == 100000 and s["has_statement_password"] and "CUST1234" not in r.text
    enc = (await admin("SELECT statement_password_enc FROM cash_settings WHERE venture_id = $1", uuid.UUID(v)))[0][0]
    assert b"CUST1234" not in bytes(enc)
    f = (await o.get(f"/ventures/{v}/cash/forecast")).json()
    assert f["opening_paise"] == 100000 and f["opening_from"] == "typed" and len(f["weeks"]) == 13
    assert f["weeks"][0]["out_paise"] == 800000 and f["below_alert"]
    assert (await o.put(f"/ventures/{v}/cash/settings",
                        json={"balance_paise": 1, "balance_on": str(today + timedelta(days=3))})).status_code == 422
    # the newer of the typed balance and the last statement's closing balance is used
    await o.post(f"/ventures/{v}/bank/statements", files={"file": ("h.csv", HDFC.encode(), "text/csv")})
    assert (await o.get(f"/ventures/{v}/cash/forecast")).json()["opening_from"] == "typed"      # typed today
    await o.put(f"/ventures/{v}/cash/settings", json={"balance_paise": 5, "balance_on": "2026-09-30"})
    f2 = (await o.get(f"/ventures/{v}/cash/forecast")).json()
    assert f2["opening_from"] == "statement" and f2["opening_paise"] == 3930000
    # Monday's note, once a day
    monday = today - timedelta(days=today.weekday())
    before = len(mail_to("Cash"))
    assert await cash.cash_week(services, monday) >= 1
    assert len(mail_to("Cash")) > before
    n = len(mail_to("Cash"))
    await cash.cash_week(services, monday)
    assert len(mail_to("Cash")) == n
    assert await cash.cash_week(services, monday + timedelta(days=1)) == 0     # only on Mondays


# ------------------------------------------------------------------------------- statements by email --
def test_which_emails_are_bank_statements():
    att = [{"filename": "Statement_Oct.csv", "size": 900, "data": b"x"}]
    assert bank.statement_attachment("alerts@hdfcbank.net", "Your account statement for October", att)
    assert bank.statement_attachment("estatement@mail.icicibank.com", "E-Statement", att)
    assert not bank.statement_attachment("scam@hdfc-bank.co", "Account statement", att)
    assert not bank.statement_attachment("alerts@hdfcbank.net", "Your credit card statement", att)
    assert not bank.statement_attachment("alerts@hdfcbank.net", "Your OTP", att)
    assert not bank.statement_attachment("alerts@hdfcbank.net", "Account statement", [{"filename": "a.zip", "size": 9}])


def test_a_password_protected_statement_needs_its_password():
    from pypdf import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=200, height=200)
    w.encrypt("CUST1234")
    buf = io.BytesIO()
    w.write(buf)
    data = buf.getvalue()
    assert bank.pdf_encrypted(data)
    with pytest.raises(bank.StatementError, match="doesn't open"):
        bank.pdf_text(data, "wrong")
    with pytest.raises(bank.StatementError, match="no readable text"):       # opened, but a blank page
        bank.pdf_text(data, "CUST1234")


async def test_a_forwarded_bank_statement_is_read_but_never_confirmed_in_one_tap(shop, services):
    from kritvia_api.services import pollers
    o, v = shop["owner"], shop["v"]
    await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Asha Foods", "number": "INV 0042",
                                                  "amount_paise": 1180000, "due_on": str(date.today())})
    org, ra = await run_as_of(v)
    msg = email_in.InboundMail(id="<st-1@x>", thread_id="", sender="HDFC Bank", sender_email="alerts@hdfcbank.net",
                               to="owner@gaps.in", subject="Account Statement for October 2026", date="", body="",
                               attachments=[{"filename": "Acct_Statement.csv", "mime": "text/csv", "size": len(HDFC),
                                             "data": HDFC.encode()}])
    before = len(mail_to("Bank statement read"))
    assert await pollers.deliver_forwarded(services, org, uuid.UUID(v), ra, msg) == {"statements": 1}
    assert len(mail_to("Bank statement read")) == before + 1
    st = (await o.get(f"/ventures/{v}/bank/statements")).json()[0]
    assert st["source"] == "email" and not st["verified"] and st["sender"] == "alerts@hdfcbank.net"
    lines = (await o.get(f"/ventures/{v}/bank/lines", params={"state": "suggested"})).json()
    asha = next(x for x in lines["lines"] if x["match"]["party"] == "Asha Foods")
    assert asha["match"]["confidence"] == "likely" and asha["unverified"] and lines["sure"] == 0
    assert (await o.post(f"/ventures/{v}/bank/confirm-sure")).json()["confirmed"] == 0
    ok = await o.post(f"/ventures/{v}/bank/lines/{asha['id']}/confirm", json={})
    assert ok.status_code == 200 and ok.json()["state"] == "confirmed"
    # switched off: statements are left alone
    await o.put(f"/ventures/{v}/cash/settings", json={"statements_by_email": False})
    msg.id = "<st-2@x>"
    assert await pollers.deliver_forwarded(services, org, uuid.UUID(v), ra, msg) != {"statements": 1}


# -------------------------------------------------------------------------- one answer per email --
async def test_forwarded_mail_isnt_answered_again_when_gmail_reads_that_mailbox(shop, services):
    from kritvia_api.services import pollers
    from kritvia_api.services.google import SCOPES
    o, v = shop["owner"], shop["v"]
    await o.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    org, ra = await run_as_of(v)

    def msg(mid):
        return email_in.InboundMail(id=mid, thread_id="", sender="Rahul", sender_email="rahul@example.com",
                                    to="owner@gaps.in", subject="Delivery?", date="", body="How long to Pune?",
                                    headers={"x-forwarded-for": "owner@gaps.in kritvia-x@in.example.com"})
    assert pollers.forwarded_from(msg("<a@x>")) == "owner@gaps.in"
    await connect_google(shop, services)              # send + Business Profile only: the forwarded copy is needed
    assert not await pollers.gmail_reads(pollers.RunContext(
        run_id=uuid.uuid4(), org_id=org, venture_id=uuid.UUID(v), run_as=ra, workflow="t", services=services), msg("<a@x>"))
    await admin("UPDATE connectors SET scopes = scopes || $2 WHERE venture_id = $1 AND provider = 'google'",
                uuid.UUID(v), [SCOPES["gmail.readonly"]])
    assert await pollers.deliver_forwarded(services, org, uuid.UUID(v), ra, msg("<b@x>")) == {"read_by_gmail": 1}
    # Gmail broken (an error on the connection): forwarding carries the mail again
    await admin("UPDATE connectors SET last_error = 'token refresh failed' WHERE venture_id = $1 AND provider = 'google'",
                uuid.UUID(v))
    assert "read_by_gmail" not in await pollers.deliver_forwarded(services, org, uuid.UUID(v), ra, msg("<c@x>"))


# ---------------------------------------------------------------------------------- campaign ideas --
def test_occasions_are_found_two_to_three_weeks_ahead():
    got = occasions.upcoming(date(2026, 10, 19))
    assert [o.key for o in got] == ["diwali-2026"]            # Dhanteras and Bhai Dooj ride along with Diwali
    assert "dhanteras-2026" in [o.key for o in occasions.upcoming(date(2026, 10, 19), include={"dhanteras"})]
    assert occasions.upcoming(date(2026, 10, 19), skip={"diwali"}) == []
    assert occasions.upcoming(date(2027, 3, 5))[0].key == "holi-2027"
    assert occasions.last_day() >= date(2027, 12, 25)
    keys = [o.key for o in occasions.ALL]
    assert len(keys) == len(set(keys))


async def test_campaign_ideas_suggest_a_festival_campaign_once(shop, fake_llm, monkeypatch):
    from kritvia_api.workflows import campaign_ideas
    o, v = shop["owner"], shop["v"]
    for n, e in (("Asha", "asha@example.com"), ("Bina", "bina@example.com")):
        await o.post(f"/ventures/{v}/invoices", json={"customer_name": n, "customer_email": e, "amount_paise": 10000,
                                                      "due_on": str(date.today())})
    diwali = occasions.Occasion("diwali-2026", "Diwali", date(2026, 11, 8), "lights")
    monkeypatch.setattr(campaign_ideas.occasions, "upcoming", lambda *a, **k: [diwali])
    await o.put(f"/ventures/{v}/workflow-configs/campaign_ideas", json={"enabled": True, "settings": {
        "offers": "Diwali hampers from ₹499"}})
    fake_llm.on("marketing emails", {"name": "Diwali 2026", "subject": "Happy Diwali from us",
                                     "body": "Wishing you a bright Diwali. Our hampers start at ₹499."})
    r = await o.post(f"/ventures/{v}/runs", json={"workflow": "campaign_ideas", "input": {"now": True}})
    assert r.status_code == 201, r.text
    run = (await o.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["outcome"] == "suggested", run
    assert "₹499" in fake_llm.chat_calls("marketing emails")[-1]["prompt"]
    c = (await o.get(f"/ventures/{v}/campaigns")).json()[0]
    assert c["name"] == "Diwali 2026" and c["status"] == "waiting" and c["recipients"] == 2
    a = next(x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json() if x["action"] == "campaign.send")
    assert "Diwali 2026" in a["title"] and "2 people" in a["title"]
    rows = await admin("SELECT occasion, suggested FROM campaigns WHERE venture_id = $1", uuid.UUID(v))
    assert rows[0]["occasion"] == "diwali-2026" and rows[0]["suggested"]
    # not twice in a week, and never twice for the same occasion
    again = await o.post(f"/ventures/{v}/runs", json={"workflow": "campaign_ideas", "input": {"now": True}})
    assert (await o.get(f"/ventures/{v}/runs/{again.json()['id']}")).json()["outcome"] == "recent_campaign"
    await admin("UPDATE campaigns SET created_at = now() - interval '8 days' WHERE venture_id = $1", uuid.UUID(v))
    third = await o.post(f"/ventures/{v}/runs", json={"workflow": "campaign_ideas", "input": {"now": True}})
    assert (await o.get(f"/ventures/{v}/runs/{third.json()['id']}")).json()["outcome"] == "nothing_this_week"


async def test_a_slow_fortnight_is_noticed(shop):
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.workflows.campaign_ideas import slow_fortnight
    o, v = shop["owner"], shop["v"]
    org = (await admin("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v)))[0]["org_id"]
    today = date.today()
    for i in range(43):                     # seven a fortnight for twelve weeks, then one in the last fortnight
        await admin("INSERT INTO leads (org_id, venture_id, name, created_at) VALUES ($1, $2, $3, now() - make_interval(days => $4))",
                    org, uuid.UUID(v), f"L{i}", 16 + i * 2)
    await admin("INSERT INTO leads (org_id, venture_id, name, created_at) VALUES ($1, $2, 'Recent', now() - '2 days'::interval)",
                org, uuid.UUID(v))
    async with tenant_tx(o.id) as conn:
        got = await slow_fortnight(conn, uuid.UUID(v), today)
    assert got and got["recent"] == 1 and got["usual"] >= 4


# ------------------------------------------------------------------------------- Google listing check --
class ListingGoogle(FakeGoogle):
    def __init__(self):
        super().__init__()
        self.patches: list[tuple[str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        u = str(request.url)
        if "mybusinessbusinessinformation" in u and "/locations/222" in u and "readMask=name%2Ctitle%2CregularHours" in u:
            return httpx.Response(200, json={"name": "locations/222", "title": "Gaps Studio", "websiteUri": "",
                                             "regularHours": {"periods": [
                                                 {"openDay": d, "openTime": {"hours": 10}, "closeDay": d,
                                                  "closeTime": {"hours": 18}} for d in ("MONDAY", "TUESDAY")]}})
        if request.method == "PATCH":
            self.patches.append((u, json.loads(request.content)))
            return httpx.Response(200, json={})
        return super().__call__(request)


@pytest.fixture
def listing_google(services, monkeypatch):
    from kritvia_api.services.google import GoogleClient
    fake = ListingGoogle()
    monkeypatch.setattr(services, "google", GoogleClient("cid", "secret", "http://x", transport=httpx.MockTransport(fake)))
    return fake


async def test_the_google_listing_gets_kritvias_hours_after_a_yes(shop, services, listing_google):
    o, v = shop["owner"], shop["v"]
    await connect_google(shop, services)
    await o.put(f"/ventures/{v}/business-profile", json={"name": "accounts/111/locations/222", "title": "Gaps Studio"})
    await o.put(f"/ventures/{v}/workflow-configs/google_listing", json={"enabled": True})
    r = await o.post(f"/ventures/{v}/runs", json={"workflow": "google_listing", "input": {"now": True}})
    assert (await o.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["outcome"] == "no_hours_in_kritvia"
    org = uuid.UUID(shop["org"])
    await admin("INSERT INTO booking_settings (venture_id, org_id, hours) VALUES ($1, $2, $3::jsonb)",
                uuid.UUID(v), org, json.dumps({"mon": [["10:00", "19:00"]], "tue": [["10:00", "19:00"]],
                                                "wed": [["10:00", "19:00"]]}))
    r = await o.post(f"/ventures/{v}/runs", json={"workflow": "google_listing", "input": {"now": True}})
    a = next(x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json()
             if x["action"] == "google.listing_update")
    assert "opening hours on Google" in a["title"]
    bad = await o.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={
        "decision": "approve", "edited_payload": {"hours": {"sun": [["10:00", "11:00"]]}}})
    assert bad.status_code == 422
    ok = await o.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert ok.status_code == 200, ok.text
    url, body = listing_google.patches[-1]
    assert "locations/222" in url and "updateMask=regularHours" in url
    periods = body["regularHours"]["periods"]
    assert len(periods) == 3 and periods[0]["openDay"] == "MONDAY" and periods[0]["closeTime"] == {"hours": 19, "minutes": 0}
    rv = (await o.get(f"/ventures/{v}/reviews")).json()
    assert rv["listing"]["hours_match"] is True and rv["listing"]["has_website"] is False


# -------------------------------------------------------------------------------------------- ads --
def test_ad_tags_on_website_form_leads():
    assert ad_tags({"utm_source": "facebook", "utm_medium": "paid_social", "utm_campaign": "Diwali Sale"}) == {
        "ad_source": "meta", "ad_campaign": "Diwali Sale"}
    assert ad_tags({"utm": {"source": "google", "medium": "cpc", "campaign": "brand"}}) == {
        "ad_source": "google", "ad_campaign": "brand"}
    assert ad_tags({"gclid": "abc"}) == {"ad_source": "google"}
    assert ad_tags({"utm_source": "instagram", "utm_medium": "bio"}) == {}        # a free link isn't an ad
    assert ad_tags({"name": "x"}) == {}


META = """Campaign name,Reporting starts,Reporting ends,Amount spent (INR),Impressions,Link clicks,Results
Diwali Sale,2026-10-01,2026-10-15,"3,000.00",40000,600,12
Brand Awareness,2026-10-01,2026-10-15,1500,90000,200,
"""
GOOGLE = """Campaign report
1 October 2026 - 15 October 2026
Campaign,Cost,Impr.,Clicks,Conversions
brand,"1,000.50",5000,150,4
Total: Account,1000.50,5000,150,4
"""


def test_reads_meta_and_google_ad_reports():
    p, rows = ads.read(META.encode(), "meta.csv")
    assert p == "meta" and [r.spend_paise for r in rows] == [300000, 150000] and rows[0].results == 12
    assert rows[0].day_from == date(2026, 10, 1) and rows[1].results is None
    g, grows = ads.read(GOOGLE.encode(), "Campaign report.csv")
    assert g == "google" and len(grows) == 1 and grows[0].spend_paise == 100050
    assert grows[0].day_to == date(2026, 10, 15)
    with pytest.raises(ads.ReportError):
        ads.read(b"a,b\n1,2\n", "x.csv")


async def test_ad_spend_against_leads_and_advice(shop, fake_llm):
    o, v = shop["owner"], shop["v"]
    today = date.today()
    meta = META.replace("2026-10-01", str(today - timedelta(days=10))).replace("2026-10-15", str(today - timedelta(days=1)))
    r = await o.post(f"/ventures/{v}/ads/reports", files={"file": ("meta.csv", meta.encode(), "text/csv")})
    assert r.status_code == 201, r.text
    assert r.json()["platform"] == "meta" and r.json()["spend_paise"] == 450000
    org = uuid.UUID(shop["org"])
    for i, status in enumerate(("new", "won", "new")):
        await admin("INSERT INTO leads (org_id, venture_id, name, source, status, ad_source, ad_campaign)"
                    " VALUES ($1, $2, $3, 'webhook', $4, 'meta', 'diwali_sale')", org, uuid.UUID(v), f"Ad {i}", status)
    s = (await o.get(f"/ventures/{v}/ads/summary", params={"days": 30})).json()
    diwali = next(c for c in s["campaigns"] if c["campaign"] == "Diwali Sale")
    assert diwali["leads"] == 3 and diwali["won"] == 1 and diwali["cost_per_lead_paise"] == 100000
    meta_row = s["platforms"][0]
    assert meta_row["platform"] == "meta" and meta_row["spend_paise"] == 450000 and meta_row["cost_per_won_paise"] == 450000
    # the same report again replaces, never doubles
    await o.post(f"/ventures/{v}/ads/reports", files={"file": ("meta.csv", meta.encode(), "text/csv")})
    assert (await o.get(f"/ventures/{v}/ads/summary")).json()["platforms"][0]["spend_paise"] == 450000
    fake_llm.on("advise an Indian small business owner on their ads", {
        "points": ["Keep Diwali Sale: ₹1,000 a lead and one sale.", "Brand Awareness brought no leads; pause it."]})
    adv = await o.post(f"/ventures/{v}/ads/advice")
    assert adv.status_code == 200 and len(adv.json()["points"]) == 2
    assert "Diwali Sale" in fake_llm.chat_calls("advise an Indian small business owner")[-1]["prompt"]
