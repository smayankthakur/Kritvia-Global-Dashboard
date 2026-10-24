"""Round 3 test report, security fixes (C2–C9): customers are matched on their full phone number, replies by
themselves hold for refund/discount/complaint words and amounts in words, a forged email sender gets no
automatic reply, the automatic-reply caps hold when messages arrive together, Authentication-Results
comments can't fake a pass, and an approved web look-up stays on the approved site."""
from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from conftest import ADMIN_DSN
from test_auto_reply import configure, meta, script, studio  # noqa: F401  (fixtures)
from test_email_forwarding import inbound, mail, script_inbox, signed as signed_mail  # noqa: F401

from kritvia_api.services import auto_reply as ar
from kritvia_api.services import customer_facts as cf
from kritvia_api.services.browser_agent import same_site
from kritvia_api.services.google import auth_clauses, sender_authenticated

PNID = "5550003333"     # this module's own WhatsApp number (another module's business holds the shared one)
NEHA = "919811100001"


def wa_msg(mid: str, body: str, sender: str, name: str = "Kavya") -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "919876533333", "phone_number_id": PNID},
        "contacts": [{"profile": {"name": name}, "wa_id": sender}],
        "messages": [{"from": sender, "id": mid, "timestamp": "1700000000", "type": "text", "text": {"body": body}}]}}]}]}


@pytest.fixture(scope="module")
async def shop(world, client):
    """A business with invoices for Neha, saved with and without the country code."""
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "R3 Sweets", "slug": f"r3-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "R3 Sweets", "city": "Delhi"})
    from datetime import date, timedelta
    for num, phone in (("R3-NEHA1", NEHA), ("R3-NEHA2", "98111 00001")):
        r = await mayank.post(f"/ventures/{v}/invoices", json={"customer_name": "Neha Gupta", "customer_phone": phone,
                                                               "amount_paise": 120000, "number": num,
                                                               "due_on": str(date.today() + timedelta(days=3))})
        assert r.status_code == 201, r.text
    return {**world, "v": v}


async def wire(studio) -> None:
    r = await studio["mayank"].post(f"/ventures/{studio['v']}/connectors/whatsapp",
                                    json={"phone_number_id": PNID, "access_token": "EAAB" + "a" * 40})
    assert r.status_code in (201, 409), r.text


# ---------------------------------------------------------------------------- C2: full numbers --
def test_numbers_are_compared_in_full():
    assert cf.e164("98111 00001") == "919811100001"
    assert cf.e164("098111-00001") == "919811100001"
    assert cf.e164("+91 98111 00001") == "919811100001"
    assert cf.e164("0044 98111 00001") == "449811100001"
    assert cf.e164("+44 98111 00001") == "449811100001"


@pytest.mark.asyncio
async def test_a_foreign_number_with_the_same_last_ten_digits_gets_nothing(shop):
    engine = create_async_engine(ADMIN_DSN.replace("postgresql://", "postgresql+asyncpg://"))
    try:
        async with engine.connect() as conn:
            v = uuid.UUID(shop["v"])
            mine = await cf.lookup(conn, v, channel="whatsapp", phone=NEHA)
            assert {i.number for i in mine.invoices} == {"R3-NEHA1", "R3-NEHA2"}   # "98111 00001" still hers
            foreign = await cf.lookup(conn, v, channel="whatsapp", phone="44" + NEHA[2:])
            assert foreign.invoices == [] and foreign.name is None
    finally:
        await engine.dispose()


# ------------------------------------------------------------------- C3: words decide, not the AI --
@pytest.mark.parametrize("customer,draft,reason", [
    ("I want my money back, the cake was stale", "So sorry!", "refund_or_payment_dispute"),
    ("Mere paise wapas karo", "Ji", "refund_or_payment_dispute"),
    ("पैसे वापस चाहिए", "जी", "refund_or_payment_dispute"),
    ("Give me 20% discount na", "Sure", "discount_or_offer"),
    ("Thoda kam karo bhaiya", "Ok", "discount_or_offer"),
    ("Worst service ever", "Sorry", "complaint"),
    ("Main consumer forum mein complaint karunga", "Ji", "legal"),
    ("I'll send a legal notice", "Ok", "legal"),
    ("Do you deliver?", "Yes, and free delivery for you!", "discount_or_offer"),
    ("Price?", "Half price for you today", "discount_or_offer"),
    ("Is it good?", "We guarantee you'll love it", "commitment_or_deal"),
    ("Price?", "Just five hundred rupees", "price_not_on_record"),
    ("Price?", "Sirf paanch sau rupaye", "price_not_on_record"),
    ("Price?", "₹300 off on this one", "price_not_on_record"),
])
def test_handoff_words(customer, draft, reason):
    assert reason in ar.handoff_reasons(customer, draft)


@pytest.mark.parametrize("customer,draft", [
    ("Are you free tomorrow at 5?", "Yes, we have a slot at 5 pm tomorrow."),
    ("What are your timings?", "We're open 10 to 8, Monday to Saturday."),
    ("Hi", "Hello! How can I help?"),
])
def test_ordinary_messages_have_no_handoff(customer, draft):
    assert ar.handoff_reasons(customer, draft) == []


def test_only_amounts_marked_as_money_are_known():
    sources = ["Shop no. 450, Sector 12, open 10 to 8", "Free times: 26 Oct 11:00, 27 Oct 15:00"]
    known = ar.known_values(sources + ["Haircut: ₹300"], [])
    assert ar.unknown_amounts("₹450 for you", known) == ["₹450"]
    assert ar.unknown_amounts("Just ₹26 today", known) == ["₹26"]
    assert ar.unknown_amounts("I can do it for 1500", known) == ["for 1500"]
    assert ar.unknown_amounts("Haircut is ₹300", known) == []
    assert ar.unknown_amounts("See you at 5 pm, for 2 people", known) == []


@pytest.mark.parametrize("body", [
    "Yes, I'm Priya from the front desk!", "Haan ji, main Priya hoon", "I'm definitely a real human",
    "Not a bot, I promise", "Don't worry, you're talking to a real person", "My name is Rohit, happy to help",
])
def test_claims_to_be_a_person(body):
    assert ar.claims_human(body, "Sharma Sweets")


@pytest.mark.parametrize("body", [
    "Hi! This is Sharma Sweets here, happy to help.", "I'm happy to help!", "I'll get a real person from the team for you.",
    "Main Sharma Sweets ki AI assistant hoon", "I'm the AI assistant of Sharma Sweets",
])
def test_honest_replies_pass(body):
    assert not ar.claims_human(body, "Sharma Sweets")


def test_holding_line_without_a_business_name():
    for lang in ("en", "hi", "hinglish"):
        line = ar.holding("sorry", lang, emoji=False, business=None)
        assert "our" not in line.split() and "{business}" not in line
    assert "our's" not in ar.holding("sorry", "en", emoji=False, business="")


@pytest.mark.asyncio
async def test_a_refund_demand_waits_even_when_the_ai_says_it_is_fine(studio, client, fake_llm, meta):
    from test_auto_reply import approvals, hook, latest_run, sent_to
    await wire(studio)
    await configure(studio, auto_reply=True)
    script(fake_llm, body="No problem at all, we'll sort it out!")        # the AI didn't flag anything
    await hook(client, wa_msg(f"wamid.{uuid.uuid4().hex[:10]}", "Bad haircut, I want my money back", "919822200301"))
    run = await latest_run(studio)
    aps = await approvals(run["id"])
    assert [(a["step"], a["status"]) for a in aps] == [("hold", "auto_approved"), ("owner_draft", "pending")]
    assert "a refund or payment dispute" in aps[1]["title"]
    assert "we'll sort it out" not in " ".join(sent_to(meta, "919822200301"))


# ------------------------------------------------------------- B4: caps hold under concurrency --
@pytest.mark.asyncio
async def test_caps_hold_when_messages_arrive_together(studio, client, fake_llm, meta, services, monkeypatch):
    from kritvia_api.engine.runner import advance_run, start_run
    from kritvia_api.workflows.inbox import message_input
    await wire(studio)
    await configure(studio, auto_reply=True)
    c = await asyncpg.connect(ADMIN_DSN)
    try:   # earlier tests in this business already replied by themselves: count from here
        before = await c.fetchval(
            "SELECT count(*) FROM workflow_runs WHERE venture_id = $1 AND created_at > now() - interval '24 hours'"
            " AND (summary->>'auto_sent' = 'true' OR summary->>'auto_pending' = 'true')", uuid.UUID(studio["v"]))
    finally:
        await c.close()
    monkeypatch.setattr(ar, "PER_BUSINESS_DAY", before + 2)
    script(fake_llm, body="Hello! How can we help?")
    me = (await studio["mayank"].get("/auth/me")).json()
    ids = [await start_run(services, actor_user_id=uuid.UUID(me["id"]), actor_type="user",
                           venture_id=uuid.UUID(studio["v"]), workflow="inbox_assistant", dispatch=False,
                           input=message_input(channel="whatsapp", from_name=f"C{n}", from_phone=f"9198333{n:05d}",
                                               subject=None, body="Do you make websites?",
                                               message_id=f"wamid.r3.{uuid.uuid4().hex}"))
           for n in range(5)]
    await asyncio.gather(*[advance_run(services, i) for i in ids])
    c = await asyncpg.connect(ADMIN_DSN)
    try:
        auto = await c.fetchval("SELECT count(*) FROM approvals WHERE run_id = ANY($1::uuid[]) AND step = 'draft'"
                                " AND status = 'auto_approved'", ids)
        waiting = await c.fetchval("SELECT count(*) FROM approvals WHERE run_id = ANY($1::uuid[]) AND step = 'draft'"
                                   " AND status = 'pending'", ids)
    finally:
        await c.close()
    assert auto == 2 and waiting == 3


# ------------------------------------------------------ C4: Authentication-Results comments --
def test_text_inside_comments_and_quotes_never_counts():
    forged = ('mx.google.com; dkim=none; spf=pass (google.com: domain of '
              '"dkim=pass header.d=bank.example"@attacker.example designates 1.2.3.4 as permitted sender) '
              'smtp.mailfrom=attacker.example; dmarc=fail (p=NONE) header.from=bank.example')
    assert not sender_authenticated([forged], "alerts@bank.example")
    forged2 = ('mx.google.com; spf=pass (dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example) '
               'smtp.mailfrom=attacker.example')
    assert not sender_authenticated([forged2], "alerts@bank.example")


def test_a_real_pass_still_counts():
    real = ('mx.google.com; dkim=pass header.i=@bank.example header.s=s1 header.b=abc; '
            'spf=pass (google.com: domain of x@bank.example designates 1.2.3.4) smtp.mailfrom=x@bank.example; '
            'dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bank.example')
    assert sender_authenticated([real], "alerts@bank.example")
    assert ("dmarc", "pass", {"header.from": "bank.example"}) in auth_clauses(real)
    arc = "i=1; mx.cloudflare.net; dkim=pass header.d=shop.example; dmarc=pass header.from=shop.example"
    assert sender_authenticated([arc], "me@shop.example", authserv="mx.cloudflare.net")


# ------------------------------------------------------------------- C5: forged email senders --
@pytest.mark.asyncio
async def test_an_unverified_email_sender_gets_no_reply_by_itself(world, client, fake_llm, inbound):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Mehta", "slug": f"mehta-{uuid.uuid4().hex[:4]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Mehta", "city": "Pune"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {"auto_reply": True}})).status_code == 200
    address = (await mayank.post(f"/ventures/{v}/connectors/email-forwarding")).json()["address"]
    script_inbox(fake_llm)
    raw = mail(frm="Forged <victim@example.org>")          # no DMARC/DKIM verdict: nobody checked who sent it
    res = await client.post("/public/email-in", content=raw, headers=signed_mail(raw, address))
    assert res.status_code == 200, res.text
    c = await asyncpg.connect(ADMIN_DSN)
    try:
        rows = await c.fetch("SELECT a.step, a.status FROM approvals a JOIN workflow_runs r ON r.id = a.run_id"
                             " WHERE r.venture_id = $1", uuid.UUID(v))
    finally:
        await c.close()
    assert "auto_approved" not in [r["status"] for r in rows]


# --------------------------------------------------------- C8: approved look-ups stay on site --
def test_same_site():
    assert same_site("https://www.gst.gov.in/help", "gst.gov.in")
    assert same_site("https://services.gst.gov.in/x", "gst.gov.in")
    assert not same_site("https://evil.example/?q=gst.gov.in", "gst.gov.in")
    assert not same_site("https://gst.gov.in.evil.example/", "gst.gov.in")
    assert not same_site(None, "gst.gov.in")


@pytest.mark.asyncio
async def test_an_approved_look_up_never_leaves_the_site():
    from kritvia_api.services import browser_agent as ba

    class Ctx:
        async def brief(self):
            return "A shop"

    class Client:
        def __init__(self):
            self.opened = []

        async def open(self):
            return "s1"

        async def goto(self, sid, url):
            self.opened.append(url)
            return {"url": url, "title": "t", "elements": []}

        async def close(self, sid):
            return None

    with pytest.raises(ba.BrowserError):
        await ba.browse(Ctx(), Client(), "find the rate", None, max_actions=1, may_submit=False, stay_on="gst.gov.in")
    with pytest.raises(ba.BrowserError):
        await ba.browse(Ctx(), Client(), "find it", "https://other.example", max_actions=1, may_submit=False,
                        stay_on="gst.gov.in")


# ------------------------------------------------------- C9: approver links (database policy) --
@pytest.mark.asyncio
async def test_a_member_cannot_remove_someone_elses_approver_link(world):
    """The route deletes by id; the database policy (own_delete) limits it to your own link or an admin."""
    c = await asyncpg.connect(ADMIN_DSN)
    try:
        pol = await c.fetchval("SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'own_delete'"
                               " AND polrelid = 'approver_links'::regclass")
    finally:
        await c.close()
    assert "current_user_id()" in pol and "can_admin_venture" in pol
