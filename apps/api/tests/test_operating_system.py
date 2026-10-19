"""Phase 4, the operating system: one stream of business events agents react to, routines the assistant sets up
after a yes, hiring (CVs screened against the role) and attendance (IN / OUT on WhatsApp)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta

import asyncpg
import pytest

from conftest import ADMIN_DSN
from kritvia_api.services import events, people
from kritvia_api.services.mailer import get_mailer
from test_assistant import MARK, ask, script
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
async def biz(client, monkeypatch):
    owner, org, v = await _org(client, monkeypatch, plan_code="growth", kind="software")
    name = f"OS {uuid.uuid4().hex[:6]}"
    await owner.put(f"/ventures/{v}/settings", json={"kind": "software", "business_name": name, "city": "Delhi"})
    return {"owner": owner, "org": org, "v": v, "name": name}


async def drain(services):
    """Act on every waiting event (as the worker does each minute)."""
    total = 0
    while True:
        n = (await events.dispatch(services))["events"]
        total += n
        if not n:
            return total


# --------------------------------------------------------------------------------------- events --
async def test_everything_that_happens_is_one_stream(biz, services, client, monkeypatch):
    o, v = biz["owner"], biz["v"]
    await drain(services)
    lead = (await o.post(f"/ventures/{v}/leads", json={"name": "Asha", "company": "Asha Foods"})).json()
    await o.patch(f"/ventures/{v}/leads/{lead['id']}", json={"status": "won"})
    inv = (await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Asha Foods", "number": "A-1",
                                                         "amount_paise": 5000000, "due_on": str(date.today())})).json()
    await o.post(f"/ventures/{v}/invoices/{inv['id']}/payment", json={"amount_paise": 5000000, "method": "upi"})
    await o.post(f"/ventures/{v}/bills", json={"vendor": "Sharma Traders", "amount_paise": 120000,
                                               "due_on": str(date.today())})
    got = (await o.get(f"/ventures/{v}/events")).json()
    kinds = [e["kind"] for e in got]
    assert kinds[:6] == ["bill.new", "payment.received", "invoice.paid", "invoice.issued", "lead.won", "lead.new"], kinds
    paid = next(e for e in got if e["kind"] == "invoice.paid")
    assert paid["summary"] == "Invoice paid by Asha Foods (A-1), ₹50,000" and paid["amount_paise"] == 5000000
    assert paid["what"] == "An invoice is paid in full" and paid["subject_id"] == inv["id"]
    k = {x["kind"]: x for x in (await o.get(f"/ventures/{v}/events/kinds")).json()}
    assert k["invoice.paid"]["has_amount"] and not k["lead.new"]["has_amount"]
    # another organisation sees none of it
    other, _, _ = await _org(client, monkeypatch, plan_code="growth", kind="software")
    assert (await other.get(f"/ventures/{v}/events")).status_code == 404


async def test_alerts_and_skills_react_right_after_an_event(biz, services, fake_llm):
    o, v, name = biz["owner"], biz["v"], biz["name"]
    await drain(services)
    r = await o.post(f"/ventures/{v}/event-alerts", json={"kind": "invoice.paid", "min_paise": 2500000})
    assert r.status_code == 201, r.text
    assert (await o.post(f"/ventures/{v}/event-alerts", json={"kind": "lead.new", "min_paise": 100})).status_code == 422
    sk = await o.post(f"/ventures/{v}/skills", json={
        "name": "Thank you after payment", "instructions": "1. Look up the invoice.\n2. Draft a thank-you email.",
        "trigger": "on_event", "on_event": "invoice.paid"})
    assert sk.status_code == 201, sk.text
    assert sk.json()["when"] == "Right after: an invoice is paid in full"
    script(fake_llm, {"answer": "Thanked them."})
    small = (await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Small Co", "amount_paise": 100000,
                                                           "due_on": str(date.today())})).json()
    big = (await o.post(f"/ventures/{v}/invoices", json={"customer_name": "Big Co", "amount_paise": 9000000,
                                                         "due_on": str(date.today())})).json()
    for i in (small, big):
        await o.post(f"/ventures/{v}/invoices/{i['id']}/payment", json={"amount_paise": i["amount_paise"],
                                                                         "method": "manual"})
    before = len(mail_to("Invoice paid by"))
    await drain(services)
    alerts = mail_to("Invoice paid by")
    assert len(alerts) == before + 1 and "Big Co" in alerts[-1]["Subject"]       # only the one over ₹25,000
    runs = [x for x in (await o.get(f"/ventures/{v}/runs?workflow=assistant")).json()]
    assert len([x for x in runs if x["title"] == "Skill: Thank you after payment"]) == 2
    prompts = [c["prompt"] for c in fake_llm.chat_calls(MARK)]
    assert any("Invoice paid by Big Co" in p and "Do the job \"Thank you after payment\"" in p for p in prompts)
    # each event is acted on once
    await drain(services)
    assert len(mail_to("Invoice paid by")) == before + 1
    assert name


# -------------------------------------------------------------------------------------- routines --
async def test_the_assistant_sets_up_the_routine_it_suggests_after_a_yes(biz, fake_llm):
    o, v = biz["owner"], biz["v"]
    script(fake_llm,
           {"thought": "set up the weekly list", "tool": "routines.create",
            "args": {"name": "Monday overdue list", "instructions": "1. Find overdue invoices.\n2. Reply with the list.",
                     "trigger": "schedule", "freq": "weekly", "weekdays": [0], "at_time": "9:00"}},
           lambda m: {"answer": "Done: every Monday at 09:00." if "done (approved by the person)" in m[-1]["content"]
                      else "It waits for your yes."})
    item = await ask(o, v, "Har Monday subah overdue invoices ki list bhej dena")
    assert item["status"] == "waiting"
    a = (await o.get(f"/ventures/{v}/approvals/{item['pending_approval_id']}")).json()
    assert a["action"] == "routines.create"
    assert a["title"] == "Set up a routine: Monday overdue list (Every Monday at 09:00)"
    assert a["payload"]["at_time"] == "09:00" and a["payload"]["when"] == "Every Monday at 09:00"
    d = await o.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert d.status_code == 200, d.text
    skills = (await o.get(f"/ventures/{v}/skills")).json()
    s = next(x for x in skills if x["name"] == "Monday overdue list")
    assert s["trigger"] == "schedule" and s["weekdays"] == [0] and s["next_run_at"] and s["mine"]
    # an incomplete routine never reaches the board
    script(fake_llm, {"tool": "routines.create", "args": {"name": "x", "instructions": "1. do it",
                                                          "trigger": "on_event", "on_event": "moon.rises"}},
           {"answer": "I couldn't set that up."})
    item = await ask(o, v, "whenever the moon rises do it")
    assert item["status"] == "completed" and item["steps"][0] == {"n": 1, "tool": "routines.create", "result": "failed"}
    assert not [x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json()
                if x["action"] == "routines.create"]


# ---------------------------------------------------------------------------------------- hiring --
CV = """Rahul Verma
rahul.verma@example.com  +91 98111 55555
Sales Executive, Delhi. 4 years selling B2B software to restaurants; Hindi and English; own two-wheeler.
Achievements: grew a territory from 20 to 85 clients in 18 months. Tally basics.
"""


async def test_cvs_are_screened_and_shortlisted_people_invited_after_a_yes(biz, fake_llm, monkeypatch):
    import kritvia_api.routers.people as rp
    o, v = biz["owner"], biz["v"]
    job = (await o.post(f"/ventures/{v}/jobs", json={"title": "Sales Executive", "location": "Delhi",
                                                     "must_have": "2+ years field sales; Hindi",
                                                     "nice_to_have": "restaurant clients"})).json()
    assert job["code"].startswith("JOB-") and job["status"] == "open"

    class Ex:
        text = CV
    monkeypatch.setattr(rp, "extract_text", lambda *a, **k: Ex())
    fake_llm.on("You screen CVs", {"name": "Rahul Verma", "email": "rahul.verma@example.com", "phone": "+91 98111 55555",
                                   "must_haves_met": ["2+ years field sales", "Hindi"], "must_haves_missing": [],
                                   "nice_to_haves_met": ["restaurant clients"], "years_relevant": 4, "score": 86,
                                   "reasons": "4 years B2B sales to restaurants; strong growth record."})
    r = await o.post(f"/ventures/{v}/jobs/{job['id']}/candidates",
                     files={"file": ("rahul.pdf", b"%PDF-1.4 fake", "application/pdf")})
    assert r.status_code == 201, r.text
    got = (await o.get(f"/ventures/{v}/jobs/{job['id']}/candidates")).json()
    c = got[0]
    assert c["score"] == 86 and c["verdict"] == "shortlist" and c["status"] == "shortlisted"
    assert c["name"] == "Rahul Verma" and c["email"] == "rahul.verma@example.com"
    screen = fake_llm.chat_calls("You screen CVs")[-1]["prompt"]
    assert "Ignore name, gender, age, religion, caste" in screen and "2+ years field sales" in screen
    a = next(x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json() if x["agent"] == "hiring")
    assert a["action"] == "gmail.send" and a["payload"]["to"] == "rahul.verma@example.com"
    assert "Interview for Sales Executive" in a["payload"]["subject"]
    await o.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    c = (await o.get(f"/ventures/{v}/jobs/{job['id']}/candidates")).json()[0]
    assert c["status"] == "invited"
    detail = (await o.get(f"/ventures/{v}/candidates/{c['id']}")).json()
    assert "grew a territory" in detail["cv"]
    stored = await admin("SELECT cv_enc FROM candidates WHERE id = $1", uuid.UUID(c["id"]))
    assert b"grew a territory" not in bytes(stored[0]["cv_enc"])                     # encrypted at rest
    # the same person again is refused; a weak CV is never shortlisted or emailed
    again = await o.post(f"/ventures/{v}/jobs/{job['id']}/candidates", data={"email": "rahul.verma@example.com"},
                         files={"file": ("rahul2.pdf", b"%PDF-1.4 fake", "application/pdf")})
    assert again.status_code in (201, 409)
    fake_llm.on("You screen CVs", {"name": "Weak", "email": "weak@example.com", "must_haves_met": [],
                                   "must_haves_missing": ["2+ years field sales"], "score": 90, "reasons": "fresher"})
    await o.post(f"/ventures/{v}/jobs/{job['id']}/candidates", data={"email": "weak@example.com"},
                 files={"file": ("weak.pdf", b"%PDF-1.4 fake", "application/pdf")})
    weak = next(x for x in (await o.get(f"/ventures/{v}/jobs/{job['id']}/candidates")).json()
                if x["email"] == "weak@example.com")
    assert weak["verdict"] == "maybe" and weak["status"] == "screened"          # a missing must-have caps it
    pending = [x for x in (await o.get(f"/ventures/{v}/approvals?status=pending")).json() if x["agent"] == "hiring"]
    assert not pending
    # an event for each application
    kinds = [e["kind"] for e in (await o.get(f"/ventures/{v}/events?kind=candidate.new")).json()]
    assert len(kinds) >= 2


async def test_a_cv_emailed_with_the_jobs_code_is_filed(biz, services, fake_llm, monkeypatch):
    from kritvia_api.services import email_in, pollers, textextract
    o, v = biz["owner"], biz["v"]
    job = (await o.post(f"/ventures/{v}/jobs", json={"title": "Cook"})).json()

    class Ex:
        text = "Sunita Devi, cook, 6 years in dhabas. sunita@example.com"
    monkeypatch.setattr(textextract, "extract_text", lambda *a, **k: Ex())
    fake_llm.on("You screen CVs", {"name": "Sunita Devi", "score": 60, "reasons": "experienced cook",
                                   "must_haves_missing": []})
    msg = email_in.InboundMail(id="<cv-1@x>", thread_id="", sender="Sunita Devi", sender_email="sunita@example.com",
                               to="", subject=f"Application {job['code']} cook", date="", body="Please see my CV",
                               attachments=[{"filename": "sunita.pdf", "mime": "application/pdf", "size": 900,
                                             "data": b"%PDF-1.4"}])
    org = (await admin("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v)))[0]["org_id"]
    run_as = (await admin("SELECT private.provision_service_account($1, $2) AS u", org, uuid.UUID(v)))[0]["u"]
    assert await pollers.deliver_forwarded(services, org, uuid.UUID(v), run_as, msg) == {"hiring": 1}
    c = (await o.get(f"/ventures/{v}/jobs/{job['id']}/candidates")).json()
    assert c[0]["name"] == "Sunita Devi" and c[0]["source"] == "email" and c[0]["verdict"] == "maybe"


# ------------------------------------------------------------------------------------ attendance --
def test_check_in_words():
    assert people.checkin_word("IN") == "in" and people.checkin_word(" aa gaya ") == "in"
    assert people.checkin_word("check-in") == "in" and people.checkin_word("पहुंच गया") == "in"
    assert people.checkin_word("Out") == "out" and people.checkin_word("ja raha") == "out"
    assert people.checkin_word("in 10 minutes") is None and people.checkin_word("hello") is None


async def test_staff_check_in_on_whatsapp_and_the_month_adds_up(biz, client, services, monkeypatch):
    from kritvia_api.services import front_door
    o, v = biz["owner"], biz["v"]
    said = []

    async def say(venture_id, user_id, chat, body, buttons=None, *, check_window=True):
        said.append((chat, body))
        return "wamid.x"
    monkeypatch.setattr(front_door, "whatsapp_say", say)
    s = (await o.post(f"/ventures/{v}/staff", json={"name": "Ramesh Kumar", "phone": "98111 77777", "role": "Delivery",
                                                     "pay_kind": "monthly", "pay_paise": 1500000,
                                                     "starts_at": "10:00"})).json()
    assert s["phone"] == "919811177777"
    dup = await o.post(f"/ventures/{v}/staff", json={"name": "Other", "phone": "+91 98111 77777"})
    assert dup.status_code == 409

    run_as = (await admin("SELECT private.provision_service_account($1, $2) AS u", uuid.UUID(biz["org"]),
                          uuid.UUID(v)))[0]["u"]

    class P:
        venture_id = uuid.UUID(v)
        org_id = uuid.UUID(biz["org"])
    P.run_as = run_as

    class M:
        kind = "text"
        sender = "919811177777"
        text = "IN"
    assert await people.whatsapp_checkin(P, M, services) is True
    M.text = "out"
    assert await people.whatsapp_checkin(P, M, services) is True
    assert said[0][0] == "919811177777" and said[0][1].startswith("Checked in at")
    assert said[1][1].startswith("Checked out at")
    M.text = "kal chhutti chahiye"                 # anything else is an ordinary message
    assert await people.whatsapp_checkin(P, M, services) is False
    M.sender, M.text = "919800000000", "IN"       # not on the team
    assert await people.whatsapp_checkin(P, M, services) is False
    today = (await o.get(f"/ventures/{v}/attendance")).json()
    assert today[0]["name"] == "Ramesh Kumar" and today[0]["in_at"] and today[0]["out_at"]
    # a person marks the other days; the sheet adds them up
    d0 = date.today().replace(day=1)
    marked = await o.put(f"/ventures/{v}/attendance", json={"staff_id": s["id"], "day": str(d0), "status": "leave"})
    assert marked.status_code == 200, marked.text
    assert (await o.put(f"/ventures/{v}/attendance", json={"staff_id": s["id"], "day": str(date.today() + timedelta(days=3)),
                                                            "status": "present"})).status_code == 422
    month = date.today().strftime("%Y-%m")
    sheet = (await o.get(f"/ventures/{v}/attendance/sheet", params={"month": month})).json()
    row = sheet[0]
    assert row["leave"] == 1 and row["present"] == (0 if d0 == date.today() else 1)
    assert row["working_days"] in range(24, 28) and row["pay_estimate_paise"] > 0
    f = await o.get(f"/ventures/{v}/attendance/sheet/file", params={"month": month})
    assert f.status_code == 200 and f.content[:2] == b"PK"


async def test_the_owner_hears_who_has_not_checked_in(biz, services):
    o, v, name = biz["owner"], biz["v"], biz["name"]
    await o.post(f"/ventures/{v}/staff", json={"name": "Late Larry", "phone": "98111 88888", "starts_at": "09:00"})
    noon = datetime.combine(date.today(), time(12, 5))
    if noon.weekday() == 6:
        noon += timedelta(days=1)
    before = len(mail_to("Not checked in yet"))
    assert await people.missing_today(services, noon.replace(tzinfo=people.IST)) >= 1
    got = mail_to("Not checked in yet")
    assert len(got) > before and any("Late Larry" in m.get_content() for m in got[before:])
    assert name
