"""Test report round 2, technical-user findings P1–P20 (and S9's stored results): background work that
can't get stuck, sends that are neither lost nor doubled, imports that keep real data, and a developer
API with paging, idempotency and one error format."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import uuid
import zipfile
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest
from sqlalchemy import text

from conftest import ADMIN_DSN, make_actor

from kritvia_api.db.session import tenant_tx
from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Interrupt, Workflow, registry
from kritvia_api.engine.runner import _create_approval, advance_run, retry_run, start_run, sweep
from kritvia_api.engine.tools import AlreadyExecuted, _reason, _safe

pytestmark = pytest.mark.asyncio

from tests_support_flow import EXECUTIONS  # noqa: E402,F401  (registers "test_flow")

SLOW = {"sleep": True}
if "test_slow" not in registry:
    _wf = registry.register(Workflow("test_slow", title="Slow test flow", start="slow"))

    @_wf.step("slow", agent="tester")
    async def _slow(ctx, state):
        if SLOW["sleep"]:
            await asyncio.sleep(30)      # cancelled by the test (a job timeout or a worker stopping)
        return Finish("done")


async def admin(sql: str, *args):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


async def _run(world, services, workflow="test_flow", **inp):
    return await start_run(services, actor_user_id=world["alice"].id, venture_id=uuid.UUID(world["site"]),
                           workflow=workflow, input=inp, dispatch=False)


async def _approve(world, approval_id):
    async with tenant_tx(world["mayank"].id) as conn:
        await conn.execute(text("SELECT decide_approval(:id, 'approved', NULL, NULL)"), {"id": approval_id})


# --------------------------------------------------------------------------------- P4 / S9 --
async def test_a_failed_send_is_sent_again_and_a_done_one_never(world, services):
    tool = services.tools.get("gmail.send")
    real, fails = tool.handler, {"left": 1}

    async def flaky(ctx, payload, approved):
        if fails["left"]:
            fails["left"] -= 1
            raise RuntimeError("SMTP said: 550 mailbox of x@example.com unavailable, body hello")
        return await real(ctx, payload, approved)
    tool.handler = flaky
    try:
        run_id = await _run(world, services)
        assert await advance_run(services, run_id) == "waiting"
        approval = (await admin("SELECT id FROM approvals WHERE run_id = $1", run_id))[0]["id"]
        await _approve(world, approval)
        assert await advance_run(services, run_id) == "failed"
        res = json.loads((await admin("SELECT execution_result FROM approvals WHERE id = $1", approval))[0]["execution_result"])
        # only the kind of failure is kept, never the provider's words (they quote addresses and drafts)
        assert res == {"ok": False, "error": "RuntimeError", "why": "the service refused it", "attempt": 1}
        assert await retry_run(world["alice"].id, run_id, services)       # runs at once (inline in tests)
        assert (await admin("SELECT status FROM workflow_runs WHERE id = $1", run_id))[0]["status"] == "completed"
        res = json.loads((await admin("SELECT execution_result FROM approvals WHERE id = $1", approval))[0]["execution_result"])
        assert res["ok"] is True
        # a step running again after a restart gets the recorded result back instead of a second send
        row = (await admin("SELECT org_id, venture_id, run_as FROM workflow_runs WHERE id = $1", run_id))[0]
        ctx = RunContext(run_id=run_id, org_id=row["org_id"], venture_id=row["venture_id"], run_as=row["run_as"],
                         workflow="test_flow", services=services)
        again = await ctx.invoke("gmail.send", approval_id=approval)
        assert again["already_done"] is True
        with pytest.raises(AlreadyExecuted):
            await services.tools.invoke(ctx, "gmail.send", {}, approval_id=approval)
    finally:
        tool.handler = real


def test_stored_results_keep_ids_not_text():
    kept = _safe({"status": "sent", "message_id": "m-1", "transport": "gmail", "body": "Dear Ravi…", "to": "r@x.in",
                  "error_text": "provider said …", "thread_id": "t-9", "count": 3, "subject": "Invoice"})
    assert kept == {"status": "sent", "message_id": "m-1", "transport": "gmail", "thread_id": "t-9", "count": 3}
    assert _reason(httpx.ConnectTimeout("x")) == "timed out"
    assert _reason(httpx.ConnectError("x")) == "couldn't reach the service"


# --------------------------------------------------------------------------------------- P2 --
async def test_a_step_that_keeps_running_out_of_time_fails_instead_of_looping(world, services):
    run_id = await _run(world, services, workflow="test_slow")
    task = asyncio.create_task(advance_run(services, run_id))
    for _ in range(50):
        await asyncio.sleep(0.05)
        if (await admin("SELECT status FROM workflow_runs WHERE id = $1", run_id))[0]["status"] == "running":
            break
    task.cancel()                                  # arq's job timeout, or the worker stopping
    with pytest.raises(asyncio.CancelledError):
        await task
    r = (await admin("SELECT status, lease_until < now() AS free FROM workflow_runs WHERE id = $1", run_id))[0]
    assert r["status"] == "running" and r["free"]  # handed back at once, not after the 10-minute lease
    SLOW["sleep"] = False
    await sweep(services, limit=500)            # re-queued (counted) and, inline in tests, run again at once
    r = (await admin("SELECT status, reclaims FROM workflow_runs WHERE id = $1", run_id))[0]
    assert (r["status"], r["reclaims"]) == ("completed", 1)
    # it keeps stopping: after the third time in a row it fails with a clear message
    await admin("UPDATE workflow_runs SET status = 'running', lease_owner = 'w', lease_until = now() - interval '1 minute',"
                " reclaims = 3, finished_at = NULL WHERE id = $1", run_id)
    await admin("UPDATE tickets SET status = 'open', finished_at = NULL WHERE run_id = $1", run_id)
    await sweep(services, limit=500)
    r = (await admin("SELECT status, error FROM workflow_runs WHERE id = $1", run_id))[0]
    assert r["status"] == "failed" and "ran out of time" in r["error"]
    t = (await admin("SELECT status FROM tickets WHERE run_id = $1", run_id))[0]
    assert t["status"] == "blocked"


# --------------------------------------------------------------------------------------- P5 --
async def test_a_card_is_made_once_and_the_run_waits_in_the_same_step(world, services):
    run_id = await _run(world, services)
    row = (await admin("UPDATE workflow_runs SET status = 'running', lease_owner = $2, lease_until = now() + interval '5 minutes'"
                       " WHERE id = $1 RETURNING org_id, venture_id, run_as", run_id, services.worker_id))[0]
    ctx = RunContext(run_id=run_id, org_id=row["org_id"], venture_id=row["venture_id"], run_as=row["run_as"],
                     workflow="test_flow", services=services)
    it = Interrupt(ApprovalRequest(agent="mailer", action="gmail.send", title="Send test",
                                   payload={"to": "x@example.com", "subject": "hi", "body": "hello"}), resume="send")
    assert await _create_approval(ctx, {"input": {}}, "ask", it, step_count=1) is False
    st = (await admin("SELECT status, lease_owner FROM workflow_runs WHERE id = $1", run_id))[0]
    assert st["status"] == "waiting" and st["lease_owner"] is None          # parked with the card, atomically
    # the step running again (after a crash) reuses the waiting card instead of making a second one
    await admin("UPDATE workflow_runs SET status = 'running', lease_owner = $2, lease_until = now() + interval '5 minutes'"
                " WHERE id = $1", run_id, services.worker_id)
    await _create_approval(ctx, {"input": {}}, "ask", it, step_count=1)
    assert len(await admin("SELECT id FROM approvals WHERE run_id = $1", run_id)) == 1


# --------------------------------------------------------------------------------------- P3 --
async def test_a_claimed_automation_comes_back_if_the_worker_stops(world):
    mayank = world["mayank"]
    v = world["site"]
    a = await mayank.post(f"/ventures/{v}/automations", json={
        "name": "Daily sales", "task": "Summarise sales", "period": "today", "freq": "daily", "weekdays": [],
        "day_of_month": None, "at_time": "09:00", "channel": "email", "recipients": [], "said": "daily sales"})
    assert a.status_code in (200, 201), a.text
    aid = uuid.UUID(a.json()["id"])
    due = datetime.now(UTC) - timedelta(minutes=1)
    await admin("UPDATE automations SET next_run_at = $2 WHERE id = $1", aid, due)
    now = datetime.now(UTC)
    async with tenant_tx(None, "system") as conn:
        got = (await conn.execute(text("SELECT * FROM private.claim_due_automations(:n)"), {"n": now})).all()
        again = (await conn.execute(text("SELECT * FROM private.claim_due_automations(:n)"), {"n": now})).all()
    mine = [g for g in got if g.automation_id == aid]
    assert mine and abs((mine[0].due_at - due).total_seconds()) < 1        # the due time, not "now"
    assert not [g for g in again if g.automation_id == aid]                # claimed: nobody else takes it
    # the worker died before setting the next time: 15 minutes later it is due again, same due time
    async with tenant_tx(None, "system") as conn:
        later = (await conn.execute(text("SELECT * FROM private.claim_due_automations(:n)"),
                                    {"n": now + timedelta(minutes=16)})).all()
    assert [g for g in later if g.automation_id == aid][0].due_at == mine[0].due_at
    await admin("UPDATE automations SET enabled = false WHERE id = $1", aid)


async def test_events_are_done_only_once_acted_on(world):
    rows = await admin("SELECT id FROM business_events ORDER BY id DESC LIMIT 1")
    if not rows:
        pytest.skip("no events yet")
    eid = rows[0]["id"]
    await admin("UPDATE business_events SET dispatched_at = NULL, claimed_at = NULL, dispatch_attempts = 0 WHERE id = $1", eid)
    async with tenant_tx(None, "system") as conn:
        got = [e.id for e in (await conn.execute(text("SELECT * FROM private.claim_events(2000)"))).all()]
        assert eid in got
        assert eid not in [e.id for e in (await conn.execute(text("SELECT * FROM private.claim_events(2000)"))).all()]
        await conn.execute(text("SELECT private.events_done(:i, false)"), {"i": [eid]})      # failed: back
        assert eid in [e.id for e in (await conn.execute(text("SELECT * FROM private.claim_events(2000)"))).all()]
        await conn.execute(text("SELECT private.events_done(:i, true)"), {"i": [eid]})
    assert (await admin("SELECT dispatched_at IS NOT NULL AS done FROM business_events WHERE id = $1", eid))[0]["done"]


# --------------------------------------------------------------------------------------- P1 --
class FakeRedis:
    def __init__(self):
        self.d = {}

    async def get(self, k):
        return self.d.get(k)

    async def set(self, k, v, ex=None):
        self.d[k] = v


async def test_worker_runs_busy_slots_schedules_and_daily_jobs(world, services, monkeypatch):
    from kritvia_worker import main as w
    # a run that finds every run slot taken returns at once (it stays queued for the sweeper)
    monkeypatch.setattr(w, "_runs", asyncio.Semaphore(1))
    async with w._runs:
        assert await w.execute_run({"services": services}, str(uuid.uuid4())) == "busy"
    # heartbeat comes from its own task; job slots leave room for scheduled jobs
    assert w.WorkerSettings.max_jobs == w.RUN_SLOTS + w.CRON_SLOTS
    assert "heartbeat" not in [c.name for c in w.WorkerSettings.cron_jobs]
    # the schedule uses the minute the job was due, and catches up on missed minutes
    fired = []

    async def fake_minute(ctx, m):
        fired.append(m.strftime("%H:%M"))
        return 0
    monkeypatch.setattr(w, "_fire_minute", fake_minute)
    r = FakeRedis()
    due = datetime(2026, 10, 23, 23, 30, tzinfo=w.IST)
    await r.set("kritvia:fire_schedules:last", (due - timedelta(minutes=3)).isoformat())
    await w.fire_schedules({"redis": r, "score": int(due.timestamp() * 1000)})
    assert fired == ["23:28", "23:29", "23:30"]
    # daily jobs: once per day after their time, by exactly one worker
    ran = []

    async def job(ctx):
        ran.append(1)
    monkeypatch.setattr(w, "DAILY", (("test_daily_job", "test_daily_fn", 9, 15, None, None),))
    monkeypatch.setitem(w.__dict__, "test_daily_fn", job)
    day = datetime(2031, 1, 7, 9, 0, tzinfo=w.IST)
    assert await w.daily_jobs({}, now=day) == []                        # not yet
    assert await w.daily_jobs({}, now=day.replace(hour=11)) == ["test_daily_job"]   # caught up later that day
    assert await w.daily_jobs({}, now=day.replace(hour=12)) == []       # once a day
    assert len(ran) == 1


async def test_readyz_reports_the_queue(client):
    r = await client.get("/readyz")
    assert r.status_code == 200 and r.json()["queue"] in ("n/a", "ok")


# ----------------------------------------------------------------------------------- P6 / P7 / P8 --
def test_kitchen_reports_keep_their_platform():
    from kritvia_api.workflows.kitchen import parse_sales_csv, report_channel
    d = {"pb": uuid.uuid4()}
    assert report_channel("orders@swiggy.in", "x.csv") == "swiggy"
    assert report_channel(None, "Zomato_sales_Oct.csv") == "zomato"
    rows, _ = parse_sales_csv(b"date,item,qty\n2026-10-20,pb,4\n", {}, d, "zomato")
    assert rows[0]["channel"] == "zomato"
    rows, _ = parse_sales_csv(b"date,item,qty,Swiggy Order ID\n2026-10-20,pb,4,x\n", {}, d)
    assert rows[0]["channel"] == "swiggy"
    rows, _ = parse_sales_csv(b"date,item,qty\n2026-10-20,pb,4\n", {}, d)
    assert rows[0]["channel"] == "all"


def test_identical_bank_lines_on_one_day_are_both_kept():
    from kritvia_api.services import bank
    csv_ = (b"Date,Narration,Withdrawal,Deposit,Balance\n"
            b"20/10/2026,ATM WDL DELHI,2000.00,,48000.00\n20/10/2026,ATM WDL DELHI,2000.00,,46000.00\n"
            b"21/10/2026,SALARY,,50000.00,96000.00\n")
    st = bank.read(csv_, "s.csv")
    fps = [x.fingerprint for x in st.lines]
    assert len(set(fps)) == 3                                   # both withdrawals are real
    assert bank.read(csv_, "s.csv").lines[1].fingerprint == fps[1]   # the same file again: the same fingerprints
    first = bank.Line(st.lines[0].day, st.lines[0].narration, st.lines[0].reference, st.lines[0].amount_paise)
    assert first.fingerprint == fps[0]                          # the first keeps the old fingerprint (no re-import)


def test_tally_utf16_and_hindi_exports_parse():
    from kritvia_api.services.tally import parse_vouchers
    xml = ('<?xml version="1.0" encoding="UTF-16"?><ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>'
           '<VOUCHER VCHTYPE="Sales"><DATE>20261020</DATE><VOUCHERNUMBER>S-1</VOUCHERNUMBER>'
           '<PARTYLEDGERNAME>कपूर स्वीट्स</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>कपूर स्वीट्स</LEDGERNAME>'
           '<AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA>'
           '</BODY></ENVELOPE>')
    for data in (b"\xff\xfe" + xml.encode("utf-16-le"), xml.encode("utf-16-le"), xml.replace("UTF-16", "UTF-8").encode()):
        out = parse_vouchers(data)
        assert out and out[0].party == "कपूर स्वीट्स", out


# -------------------------------------------------------------------------------------- P9 is in web --
# ------------------------------------------------------------------------------------- P12 --
def test_logs_mask_emails_and_phone_numbers():
    from kritvia_api.logredact import RedactFilter, redact
    assert redact("sent to ravi.kumar@example.in and +91 98111 22233") == "sent to r***@example.in and [number]"
    assert redact("run 4f1c9a uuid 123e4567-e89b-12d3-a456-426614174000 step 12") == \
        "run 4f1c9a uuid 123e4567-e89b-12d3-a456-426614174000 step 12"
    rec = logging.LogRecord("x", logging.INFO, "f", 1, "lead %s phone %s", ("a@b.co", "9811122233"), None)
    RedactFilter().filter(rec)
    assert rec.getMessage() == "lead a***@b.co phone [number]"


# ------------------------------------------------------------------------------------- P13 --
async def test_old_run_history_is_purged_but_what_went_out_is_kept(world, services):
    run_id = await _run(world, services)
    await admin("UPDATE workflow_runs SET status = 'completed', finished_at = now() - interval '400 days' WHERE id = $1", run_id)
    async with tenant_tx(None, "system") as conn:
        for sql in ("SELECT private.purge_run_history(180, 5000)", "SELECT private.purge_model_calls(400, 1000)",
                    "SELECT private.purge_trigger_events(180, 1000)", "SELECT private.purge_idempotency_keys()"):
            assert (await conn.execute(text(sql))).scalar() >= 0
    assert not await admin("SELECT 1 FROM workflow_runs WHERE id = $1", run_id)
    from kritvia_worker.main import purge_expired
    await purge_expired({"services": services})          # each purge in its own transaction, none raises


# ------------------------------------------------------------------------------------- P14 --
async def test_owners_export_the_whole_organisation(world, client):
    mayank, alice = world["mayank"], world["alice"]
    r = await alice.get(f"/orgs/{world['org']}/export")
    assert r.status_code == 403
    r = await mayank.get(f"/orgs/{world['org']}/export")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert "README.txt" in names and "organisation.json" in names
    leads = [n for n in names if n.endswith("/leads.csv")]
    assert leads, names
    body = "\n".join(z.read(n).decode() for n in leads)
    assert "Acme Corp" in body
    assert not [n for n in names if "connector_tokens" in n or "tenant_keys" in n]
    me = (await mayank.get("/auth/me/export")).json()
    for k in ("linked_chats", "signed_in_devices", "api_keys_you_made", "notification_devices", "security_events"):
        assert k in me


# ------------------------------------------------------------------------------------- P15 --
async def test_suppressed_addresses_get_no_mail_and_ses_feedback_fills_the_list(client, monkeypatch):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from cryptography.x509.oid import NameOID

    from kritvia_api.config import get_settings
    from kritvia_api.routers import ses_feedback
    from kritvia_api.services.mailer import get_mailer

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "sns.amazonaws.com")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(datetime.now(UTC) - timedelta(days=1))
            .not_valid_after(datetime.now(UTC) + timedelta(days=1)).sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM)
    cert_url = "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-test.pem"
    monkeypatch.setattr(ses_feedback, "transport_override",
                        httpx.MockTransport(lambda req: httpx.Response(200, content=pem)))
    ses_feedback._certs.clear()
    topic = "arn:aws:sns:ap-south-1:123:kritvia-ses-feedback"
    monkeypatch.setattr(get_settings(), "ses_feedback_topic_arn", topic)
    who = f"bounced-{uuid.uuid4().hex[:6]}@example.com"

    def signed(msg):
        msg = {**msg, "TopicArn": topic, "SignatureVersion": "2", "SigningCertURL": cert_url}
        msg["Signature"] = base64.b64encode(key.sign(ses_feedback.canonical(msg), padding.PKCS1v15(), hashes.SHA256())).decode()
        return msg
    note = {"Type": "Notification", "MessageId": "m1", "Timestamp": "2026-10-23T00:00:00Z",
            "Message": json.dumps({"notificationType": "Bounce", "bounce": {
                "bounceType": "Permanent", "bouncedRecipients": [{"emailAddress": who}]}})}
    forged = {**signed(note), "Message": json.dumps({"notificationType": "Complaint", "complaint": {
        "complainedRecipients": [{"emailAddress": "someone@example.com"}]}})}
    assert (await client.post("/hooks/ses/feedback", content=json.dumps(forged))).status_code == 403
    r = await client.post("/hooks/ses/feedback", content=json.dumps(signed(note)))
    assert r.status_code == 200 and r.json() == {"suppressed": 1}
    soft = {**note, "MessageId": "m2", "Message": json.dumps({"notificationType": "Bounce", "bounce": {
        "bounceType": "Transient", "bouncedRecipients": [{"emailAddress": "full@example.com"}]}})}
    assert (await client.post("/hooks/ses/feedback", content=json.dumps(signed(soft)))).json() == {"suppressed": 0}

    outbox = get_mailer().outbox
    before = len(outbox)
    await get_mailer().send(who, "Your code", "123456")
    assert len(outbox) == before                                   # suppressed: not sent
    await get_mailer().send("fine@example.com", "Hello", "hi")
    assert outbox[-1]["Reply-To"]                                  # replies reach a person


async def test_owner_digests_respect_unsubscribe(world, services):
    from kritvia_api.services.mailer import get_mailer
    from kritvia_api.services.owner_news import tell_admins
    outbox = get_mailer().outbox
    mayank = world["mayank"]
    async with tenant_tx(mayank.id) as conn:
        before = len(outbox)
        await tell_admins(services, conn, uuid.UUID(world["site"]), subject="Bills due", body="2 bills", path="/", tag="t1")
        mine = [m for m in outbox[before:] if m["To"] == mayank.email]
        assert mine and mine[0]["List-Unsubscribe"]
        await conn.execute(text("SELECT product_email_optout(:u, true)"), {"u": mayank.id})
        before = len(outbox)
        await tell_admins(services, conn, uuid.UUID(world["site"]), subject="Bills due", body="2 bills", path="/", tag="t2")
        assert not [m for m in outbox[before:] if m["To"] == mayank.email]
        await conn.execute(text("SELECT product_email_optout(:u, false)"), {"u": mayank.id})


# ------------------------------------------------------------------------------------- P16 --
async def test_developer_api_pages_retries_and_errors(world, client):
    mayank, v = world["mayank"], world["site"]
    for i in range(5):
        await mayank.post(f"/ventures/{v}/leads", json={"name": f"Paged lead {i}"})
    seen, cursor = [], None
    for _ in range(10):
        r = await mayank.get(f"/ventures/{v}/leads", params={"limit": 2, **({"cursor": cursor} if cursor else {})})
        assert r.status_code == 200
        seen += [x["id"] for x in r.json()]
        cursor = r.headers.get("x-next-cursor")
        if not cursor:
            break
    assert len(seen) == len(set(seen)) and len(seen) >= 6          # every lead once, no repeats
    assert (await mayank.get(f"/ventures/{v}/leads", params={"cursor": "not-a-cursor"})).status_code == 422

    # an API key, the /v1 prefix, Idempotency-Key and the error format (an organisation of its own, on Scale)
    owner = await make_actor(client, "dev-owner")
    org = (await owner.post("/orgs", json={"name": "Dev Co", "slug": f"dev-{uuid.uuid4().hex[:8]}"})).json()["id"]
    dv = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Dev Shop", "slug": f"dv-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await admin("INSERT INTO org_plans (org_id, plan) VALUES ($1, 'scale') ON CONFLICT (org_id) DO UPDATE SET plan = 'scale'",
                uuid.UUID(org))
    k = await owner.post(f"/orgs/{org}/api-keys", json={"name": "Integration", "scope": "write"})
    assert k.status_code == 201, k.text
    h = {"Authorization": f"Bearer {k.json()['key']}"}
    r = await client.get(f"/v1/ventures/{dv}/leads", headers=h)
    assert r.status_code == 200, r.text
    body = {"name": "Idempotent lead"}
    one = await client.post(f"/v1/ventures/{dv}/leads", json=body, headers={**h, "Idempotency-Key": "abc-1"})
    two = await client.post(f"/v1/ventures/{dv}/leads", json=body, headers={**h, "Idempotency-Key": "abc-1"})
    assert one.status_code == 201 and two.status_code == 201 and two.json()["id"] == one.json()["id"], (one.text, two.text)
    assert two.headers.get("idempotent-replayed") == "true"
    other = await client.post(f"/v1/ventures/{dv}/leads", json={"name": "Different"}, headers={**h, "Idempotency-Key": "abc-1"})
    assert other.status_code == 422 and other.json()["status"] == 422
    bad = await client.post(f"/v1/ventures/{dv}/invoices", json={"amount_paise": "lots"}, headers=h)
    assert bad.status_code == 422
    e = bad.json()
    assert isinstance(e["detail"], str) and e["status"] == 422 and e["errors"]
    assert len(await admin("SELECT 1 FROM leads WHERE name = 'Idempotent lead' AND venture_id = $1", uuid.UUID(dv))) == 1
    # without /v1 the app's own error format is unchanged
    assert isinstance((await client.post(f"/ventures/{dv}/invoices", json={"amount_paise": "lots"}, headers=h)).json()["detail"], list)


# ------------------------------------------------------------------------------------- P10 --
async def test_migrations_take_one_lock_and_a_rerun_does_nothing():
    from conftest import OWNER_DSN

    from kritvia_api.db.migrate import migrate
    a, b = await asyncio.gather(migrate(OWNER_DSN), migrate(OWNER_DSN))
    assert a == [] and b == []


# ----------------------------------------------------------------- found by the e2e run (sign-up race) --
async def test_every_endpoint_commits_before_its_response_is_sent():
    from kritvia_api.deps import AnonDB, TenantDB
    for dep in (TenantDB, AnonDB):
        assert dep.__metadata__[0].scope == "function"      # FastAPI's default committed after the response
