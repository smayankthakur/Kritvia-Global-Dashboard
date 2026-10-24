"""Round 3 test report, reliability fixes (B and A items with an API side)."""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import asyncpg
import pytest

from conftest import ADMIN_DSN

from kritvia_api.services import customer_facts as cf

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


async def admin():
    return await asyncpg.connect(ADMIN_DSN)


# ------------------------------------------------------------------------- B14: migration rules --
def test_no_migration_adds_and_validates_a_constraint_in_one_transaction():
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name <= "0077":            # already applied in production; can't change (0076 did this)
            continue
        sql = f.read_text()
        if sql.lstrip().startswith("-- kritvia: no-transaction"):
            continue
        assert not ("NOT VALID" in sql and "VALIDATE CONSTRAINT" in sql), f.name


# --------------------------------------------------------------------- B6: business timezone --
def test_booking_times_are_told_in_the_business_timezone():
    dubai = ZoneInfo("Asia/Dubai")
    start = datetime(2031, 3, 10, 10, 0, tzinfo=dubai)
    facts = cf.Facts(name="Sara", bookings=[cf.Booking(service="Haircut", starts_at=start)], tz=dubai)
    text_ = cf.compose("booking", facts, "en", "Salon", today=date(2031, 3, 9))
    assert "10:00" in text_ or "10 AM" in text_.upper()
    assert "11:30" not in text_


# ----------------------------------------------------------------------- B8: leads and proposals --
@pytest.mark.asyncio
async def test_deleting_a_lead_deletes_its_proposals_and_proposals_can_be_deleted(world):
    mayank, v = world["mayank"], world["site"]
    leads = [(await mayank.post(f"/ventures/{v}/leads", json={"name": f"Test {n}", "phone": "98111 22233"})).json()
             for n in range(3)]
    assert leads[0]["phone"] == "98111 22233"
    c = await admin()
    try:
        org = await c.fetchval("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
        props = {}
        for lead, st in zip(leads, ("draft", "sent", "draft")):
            props[lead["id"]] = await c.fetchval(
                "INSERT INTO proposals (org_id, venture_id, lead_id, title, content_enc, subtotal_inr, total_inr, status)"
                " VALUES ($1, $2, $3, 'T', '\\x00', 1, 1, $4) RETURNING id", org, uuid.UUID(v), uuid.UUID(lead["id"]), st)
    finally:
        await c.close()
    p_draft, p_sent, p_third = (props[x["id"]] for x in leads)
    # a draft goes; a sent one needs force
    assert (await mayank.delete(f"/ventures/{v}/proposals/{p_draft}")).status_code == 204
    assert (await mayank.delete(f"/ventures/{v}/proposals/{p_sent}")).status_code == 409
    assert (await mayank.delete(f"/ventures/{v}/proposals/{p_sent}", params={"force": "true"})).status_code == 204
    # another business's id: not found
    assert (await world["mallory"].delete(f"/ventures/{v}/proposals/{p_third}")).status_code in (403, 404)
    # bulk delete takes the third lead and its proposal with it
    r = await mayank.post(f"/ventures/{v}/leads/bulk-delete", json={"ids": [x["id"] for x in leads] + [world["b_lead"]]})
    assert r.status_code == 200 and r.json()["deleted"] == 3        # Truhome's lead isn't in this business
    c = await admin()
    try:
        assert await c.fetchval("SELECT count(*) FROM proposals WHERE id = $1", p_third) == 0
        assert await c.fetchval("SELECT count(*) FROM leads WHERE id = $1", uuid.UUID(world["b_lead"])) == 1
    finally:
        await c.close()


# ------------------------------------------------------- B10, B11: settings checked and merged --
@pytest.mark.asyncio
async def test_agent_settings_are_checked_and_patched(world):
    mayank, v = world["mayank"], world["site"]
    url = f"/ventures/{v}/workflow-configs/inbox_assistant"
    r = await mayank.put(url, json={"enabled": True, "settings": {"auto_reply_channels": None, "answer_facts": "yes"}})
    assert r.status_code == 422
    r = await mayank.put(url, json={"enabled": True, "settings": {"auto_reply_channels": None}, "instructions": "Be kind"})
    assert r.status_code == 200 and "auto_reply_channels" not in r.json()["settings"]
    assert (await mayank.patch(url, json={"settings": {"answer_facts": True}})).status_code == 200
    r = await mayank.patch(url, json={"settings": {"auto_reply": True}})
    assert r.json()["settings"] == {"answer_facts": True, "auto_reply": True} and r.json()["instructions"] == "Be kind"
    assert (await mayank.patch(url, json={"settings": {"auto_reply_channels": ["fax"]}})).status_code == 422
    await mayank.put(url, json={"enabled": True, "settings": {}})


# ------------------------------------------------------------- B12: daily jobs retry the same day --
@pytest.mark.asyncio
async def test_a_failed_daily_job_is_tried_again_that_day(world, monkeypatch):
    from kritvia_worker import main as w
    calls = []

    async def flaky(ctx):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("deploy restarted the worker")
    monkeypatch.setattr(w, "DAILY", (("r3_daily_job", "r3_daily_fn", 9, 15, None, None),))
    monkeypatch.setitem(w.__dict__, "r3_daily_fn", flaky)
    day = datetime(2032, 2, 3, 10, 0, tzinfo=w.IST)
    assert await w.daily_jobs({}, now=day) == []                         # failed
    assert await w.daily_jobs({}, now=day.replace(hour=11)) == ["r3_daily_job"]   # tried again, done
    assert await w.daily_jobs({}, now=day.replace(hour=12)) == []        # once done, not again
    assert len(calls) == 2


# ------------------------------------------------------------ B7: old runs that sent something --
@pytest.mark.asyncio
async def test_old_runs_that_sent_a_message_are_purged(world):
    c = await admin()
    try:
        v = uuid.UUID(world["site"])
        org = await c.fetchval("SELECT org_id FROM ventures WHERE id = $1", v)
        user = await c.fetchval("SELECT id FROM users LIMIT 1")
        run = await c.fetchval(
            "INSERT INTO workflow_runs (org_id, venture_id, workflow, current_step, run_as, status, finished_at, created_at)"
            " VALUES ($1, $2, 'inbox_assistant', 'send', $3, 'completed', now() - interval '400 days',"
            " now() - interval '400 days') RETURNING id", org, v, user)
        ap = await c.fetchval(
            "INSERT INTO approvals (org_id, venture_id, run_id, step, agent, action, capability, title, payload_enc, status)"
            " VALUES ($1, $2, $3, 'draft', 'inbox', 'gmail.send', 'send', 'x', '\\x00', 'pending') RETURNING id",
            org, v, run)
        await c.execute("UPDATE approvals SET status = 'approved' WHERE id = $1", ap)
        ob = await c.fetchval(
            "INSERT INTO outbox_messages (org_id, venture_id, approval_id, channel, recipient, body_enc, transport, status,"
            " created_at) VALUES ($1, $2, $3, 'email', 'a@b.example', '\\x01', 'gmail', 'sent', now() - interval '400 days')"
            " RETURNING id", org, v, ap)
        assert await c.fetchval("SELECT run_id FROM outbox_messages WHERE id = $1", ob) == run   # filled in
        await c.execute("SELECT private.purge_run_history(180, 100000)")
        assert await c.fetchval("SELECT count(*) FROM workflow_runs WHERE id = $1", run) == 0
        row = await c.fetchrow("SELECT approval_id, run_id, body_enc FROM outbox_messages WHERE id = $1", ob)
        assert row["approval_id"] is None and row["run_id"] == run and row["body_enc"] is None
    finally:
        await c.close()


# ------------------------------------------------------- A7: the enquiry is kept if the AI fails --
@pytest.mark.asyncio
async def test_an_enquiry_is_saved_as_a_lead_when_the_ai_fails(world, services, fake_llm):
    from kritvia_api.engine.runner import advance_run
    mayank, v = world["mayank"], world["site"]
    fake_llm.on("You triage inbound inquiries", {"not": "valid"})        # missing required fields
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "lead_triage", "input": {
        "from_name": "Gaurav Unscored", "from_email": "gaurav@example.com", "subject": "Need a website",
        "body": "Hi, need a site for my shop"}})
    assert r.status_code == 201, r.text
    await advance_run(services, uuid.UUID(r.json()["id"]))
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["outcome"] == "saved_unscored", run
    leads = (await mayank.get(f"/ventures/{v}/leads", params={"limit": 200})).json()
    assert any(x["email"] == "gaurav@example.com" for x in leads)


# ------------------------------------------------------- A18: freshly switched-on agents aren't idle --
@pytest.mark.asyncio
async def test_an_agent_switched_on_today_is_not_reported_idle(world):
    mayank, v = world["mayank"], world["site"]
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/meeting_digest",
                             json={"enabled": True, "settings": {}})).status_code in (200, 402, 422)
    r = await mayank.put(f"/ventures/{v}/workflow-configs/collections", json={"enabled": True, "settings": {}})
    if r.status_code != 200:
        pytest.skip("collections isn't on this plan here")
    health = (await mayank.get(f"/ventures/{v}/automation-health")).json()
    assert not [f for f in health["findings"] if f["agent"] == "collections" and f["kind"] == "idle"]


# --------------------------------------------------------------- A1: production never "logs" a send --
def test_production_never_pretends_to_send(monkeypatch):
    from kritvia_api.config import Settings
    s = Settings(environment="production", messaging_fallback="log", database_url="postgresql+asyncpg://x:y@h/d",
                 master_kek_b64="A" * 44, jwt_secret="x" * 40)
    assert s.messaging_fallback == "none"
    d = Settings(environment="development", messaging_fallback="log", database_url="postgresql+asyncpg://x:y@h/d",
                 master_kek_b64="A" * 44, jwt_secret="x" * 40)
    assert d.messaging_fallback == "log"


# ------------------------------------------------------------- A9: forecast doesn't count twice --
@pytest.mark.asyncio
async def test_a_matched_bank_credit_is_not_counted_again_in_the_forecast(world):
    from sqlalchemy.ext.asyncio import create_async_engine

    from kritvia_api.services import cash
    mayank, v = world["mayank"], world["tru"]
    inv = (await mayank.post(f"/ventures/{v}/invoices", json={"customer_name": "R3 Cash", "amount_paise": 11800000,
                                                              "number": f"R3C-{uuid.uuid4().hex[:5]}",
                                                              "due_on": str(date.today() + timedelta(days=5))})).json()
    c = await admin()
    try:
        org = await c.fetchval("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
        st = await c.fetchval("INSERT INTO bank_statements (org_id, venture_id, file_name) VALUES ($1, $2, 'r3.csv')"
                              " RETURNING id", org, uuid.UUID(v))
        await c.execute(
            "INSERT INTO bank_lines (org_id, venture_id, statement_id, line_date, narration, amount_paise, balance_paise,"
            " fingerprint, match_kind, match_id, confidence, state) VALUES ($1, $2, $3, $4, 'NEFT R3 CASH', 11800000,"
            " 19232100, $5, 'invoice', $6, 'sure', 'suggested')",
            org, uuid.UUID(v), st, date.today(), uuid.uuid4().hex + uuid.uuid4().hex, uuid.UUID(inv["id"]))
    finally:
        await c.close()
    engine = create_async_engine(ADMIN_DSN.replace("postgresql://", "postgresql+asyncpg://"))
    try:
        async with engine.connect() as conn:
            f = await cash.forecast(conn, uuid.UUID(v))
    finally:
        await engine.dispose()
    assert f.opening_paise == 19232100
    assert all(x.in_paise < 11800000 for x in f.horizons) or not f.horizons


# ---------------------------------------------------------------- B5: a business called "Ask …" --
from test_email_forwarding import inbound, mail, script_inbox, signed  # noqa: E402,F401


@pytest.mark.asyncio
async def test_a_business_whose_name_starts_with_ask_gets_its_forwarded_mail(world, inbound, client, fake_llm):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Ask Ginni", "slug": f"ask-ginni-{uuid.uuid4().hex[:4]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Ask Ginni", "city": "Delhi"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}})).status_code == 200
    address = (await mayank.post(f"/ventures/{v}/connectors/email-forwarding")).json()["address"]
    assert address.startswith("biz-ask-ginni")
    script_inbox(fake_llm)
    raw = mail()
    res = await client.post("/public/email-in", content=raw, headers=signed(raw, address))
    assert res.status_code == 200, res.text
    # an older address that does start with "ask-" (made before this fix) still reaches the business
    c = await admin()
    try:
        old = "ask-ginni-" + uuid.uuid4().hex
        n = await c.execute("UPDATE connectors SET external_id = $1 WHERE venture_id = $2 AND provider = 'email_in'",
                            old, uuid.UUID(v))
    finally:
        await c.close()
    if n.endswith(" 1"):
        domain = address.split("@", 1)[1]
        raw = mail(subject="Second one")
        res = await client.post("/public/email-in", content=raw, headers=signed(raw, f"{old}@{domain}"))
        assert res.status_code == 200, res.text


# ------------------------------------------------------------- A5: what the customer wrote --
@pytest.mark.asyncio
async def test_a_card_shows_what_the_customer_wrote(world, inbound, client, fake_llm):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Wrote", "slug": f"wrote-{uuid.uuid4().hex[:4]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Wrote", "city": "Delhi"})
    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    address = (await mayank.post(f"/ventures/{v}/connectors/email-forwarding")).json()["address"]
    script_inbox(fake_llm)
    raw = mail(body="Do you deliver to Pune? It's for a wedding on the 12th. Rahul")
    assert (await client.post("/public/email-in", content=raw, headers=signed(raw, address))).status_code == 200
    cards = (await mayank.get(f"/ventures/{v}/approvals")).json()
    assert cards, "a draft was made"
    one = (await mayank.get(f"/ventures/{v}/approvals/{cards[0]['id']}")).json()
    assert "deliver to Pune" in (one["they_wrote"] or "") and "wedding" in one["they_wrote"]
