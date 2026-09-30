"""Regression tests for the pre-dogfood security review. Each test is a former
proof-of-concept exploit, now asserting that the attack FAILS."""
from __future__ import annotations

import io
import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, APP_DSN, join, make_actor

RAW_APP_DSN = APP_DSN.replace("+asyncpg", "")
LOCAL = {"ollama-qwen-7b", "ollama-bge-m3", "local-whisper"}


@pytest.fixture(scope="module")
async def poc(client):
    owner = await make_actor(client, "powner")
    vadmin = await make_actor(client, "pvadmin")      # venture_admin of both ventures, NOT loan_officer
    op = await make_actor(client, "pop")
    viewer = await make_actor(client, "pviewer")
    officer = await make_actor(client, "pofficer")
    approver = await make_actor(client, "papprover")
    slug = uuid.uuid4().hex[:8]
    org = (await owner.post("/orgs", json={"name": "PoC", "slug": f"poc-{slug}"})).json()["id"]
    soft = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Soft", "slug": "soft"})).json()["id"]
    fin = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Fin", "slug": "fin"})).json()["id"]
    await owner.put(f"/ventures/{soft}/settings", json={"kind": "software"})
    await owner.put(f"/ventures/{fin}/settings", json={"kind": "finance"})
    for who, v, role in ((vadmin, soft, "venture_admin"), (vadmin, fin, "venture_admin"), (op, soft, "operator"),
                         (op, fin, "operator"), (viewer, soft, "viewer"), (officer, fin, "loan_officer"),
                         (approver, soft, "approver")):
        await join(owner, who, org, v, role)
    await owner.put(f"/ventures/{soft}/rate-card", json={"items": [
        {"code": "web_nextjs", "name": "Next.js website", "unit": "project", "rate_inr": "150000"}]})
    return dict(owner=owner, vadmin=vadmin, op=op, viewer=viewer, officer=officer, approver=approver,
                org=org, soft=soft, fin=fin)


async def test_restricted_knowledge_never_reaches_drafts_or_hosted_models(poc, fake_llm):
    vadmin, op, viewer, approver, v = poc["vadmin"], poc["op"], poc["viewer"], poc["approver"], poc["soft"]
    secret = "TOPSECRET-MARGIN-42 internal cost floor for nextjs website automation catering orders"
    r = await vadmin.post(f"/ventures/{v}/documents",
                          data={"restricted_to": "venture_admin", "sensitive": "true", "title": "Internal costing"},
                          files={"file": ("costing.txt", io.BytesIO(secret.encode()), "text/plain")})
    assert r.status_code == 201, r.text
    fake_llm.on("You triage inbound inquiries", {
        "contact_name": "Eve", "company": "Evil Co", "summary": "Evil Co wants a nextjs website automation",
        "requirements": ["nextjs website", "automation for catering orders"],
        "scope": [{"code": "web_nextjs", "qty": 1}], "urgency": "high", "is_spam": False})
    fake_llm.on("Assess how well this inquiry fits", {"fit": "strong", "reason": "x"})

    def writer(messages):  # a model that quotes its sources verbatim
        src = messages[-1]["content"].split("[1]", 1)[-1][:300]
        return {"subject": "Proposal", "email_body": "Hi", "proposal": "Based on [1]: " + src, "used_sources": [1]}
    fake_llm.on("proposal writer", writer)
    fake_llm.calls.clear()
    r = await op.post(f"/ventures/{v}/leads/inquiry", json={
        "from_name": "Eve", "from_email": "eve@evil.example", "company": "Evil Co", "subject": "site",
        "body": "Need a nextjs website with automation for catering orders"})
    assert r.status_code == 202, r.text
    assert not [c for c in fake_llm.chat_calls("TOPSECRET-MARGIN-42") if c["model"] not in LOCAL]
    inbox = [a for a in (await viewer.get("/approvals/inbox")).json() if a["run_id"] == r.json()["run_id"]]
    assert inbox and "TOPSECRET" not in inbox[0]["payload"]["body"]

    # the at-most-once execution stamp can't be cleared, even with raw SQL as the app role
    d = await approver.post(f"/ventures/{v}/approvals/{inbox[0]['id']}/decision", json={"decision": "approve"})
    assert d.status_code == 200, d.text
    admin = await asyncpg.connect(ADMIN_DSN)
    svc = await admin.fetchval("SELECT run_as FROM workflow_runs WHERE id = $1", uuid.UUID(r.json()["run_id"]))
    await admin.close()
    app = await asyncpg.connect(RAW_APP_DSN)
    try:
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(svc))
            with pytest.raises(asyncpg.PostgresError, match="already executed"):
                await app.execute("UPDATE approvals SET executed_at = NULL WHERE id = $1", uuid.UUID(inbox[0]["id"]))
    finally:
        await app.close()


async def test_dpdp_access_export_respects_roles(poc):
    officer, vadmin, fin = poc["officer"], poc["vadmin"], poc["fin"]
    r = await officer.post(f"/ventures/{fin}/loan-applications", json={
        "loan_type": "home_loan", "applicant": {"name": "Ravi Sharma", "email": "ravi.poc@example.in",
                                                "pan": "ABCPS1234K", "dob": "1990-01-01"},
        "consent": {"notice_version": "2026-09"}})
    assert r.status_code == 201, r.text
    req = await vadmin.post(f"/ventures/{fin}/dpdp-requests", json={"identifier": "ravi.poc@example.in",
                                                                    "kind": "access"})
    ex = (await vadmin.post(f"/ventures/{fin}/dpdp-requests/{req.json()['id']}/execute")).json()
    assert ex["export"]["loan_applications"] == [] and "ABCPS1234K" not in str(ex)
    assert ex["export"]["restricted_records_not_exported"] == 1


async def test_operator_cannot_point_agents_at_restricted_records(poc, fake_llm):
    officer, op, fin = poc["officer"], poc["op"], poc["fin"]
    r = await officer.post(f"/ventures/{fin}/loan-applications", json={
        "loan_type": "home_loan", "applicant": {"name": "Sita Rao", "email": "sita.poc@example.in"},
        "consent": {"notice_version": "2026-09"}})
    run = await op.post(f"/ventures/{fin}/runs", json={"workflow": "loan_verification",
                                                       "input": {"application_id": r.json()["id"]}})
    assert run.status_code == 404
    run = await op.post(f"/ventures/{fin}/runs", json={"workflow": "meeting_digest",
                                                       "input": {"document_id": str(uuid.uuid4())}})
    assert run.status_code == 404
    ok = await officer.post(f"/ventures/{fin}/runs", json={"workflow": "loan_verification",
                                                           "input": {"application_id": r.json()["id"]}})
    assert ok.status_code == 201


async def test_no_existence_oracle_for_restricted_entities(poc, fake_llm):
    vadmin, op, v = poc["vadmin"], poc["op"], poc["soft"]

    def kg(messages):
        t = messages[-1]["content"]
        for name in ("Falcon Acquisition", "Eagle Acquisition"):
            if name in t:
                return {"entities": [{"name": name, "type": "project"}]}
        return {}
    fake_llm.on("You build a company knowledge graph", kg)
    r = await vadmin.post(f"/ventures/{v}/documents", data={"restricted_to": "venture_admin"},
                          files={"file": ("m.txt", io.BytesIO(b"Board memo: Falcon Acquisition target"), "text/plain")})
    assert r.status_code == 201, r.text
    hit = await op.post(f"/ventures/{v}/notes", json={"title": "n1", "text": "Falcon Acquisition"})
    miss = await op.post(f"/ventures/{v}/notes", json={"title": "n2", "text": "Eagle Acquisition"})
    assert hit.status_code == miss.status_code == 201


async def test_invite_squatting_fails(poc, client):
    owner, org, v = poc["owner"], poc["org"], poc["soft"]
    target = f"new.hire.{uuid.uuid4().hex[:6]}@victimcorp.example"
    squatter = await client.post("/auth/register", json={"email": target, "full_name": "attacker",
                                                         "password": "attacker password 1"})
    h = {"Authorization": f"Bearer {squatter.json()['access_token']}"}
    # direct add by email is refused for people not already in the org
    r = await owner.post(f"/orgs/{org}/members", json={"user_email": target, "role": "viewer", "venture_id": v})
    assert r.status_code == 404
    # an invitation needs the secret token, which only the real invitee receives
    inv = (await owner.post(f"/orgs/{org}/invitations", json={"email": target, "role": "viewer",
                                                              "venture_id": v})).json()
    guess = await client.post("/invitations/accept", headers=h, json={"token": "x" * 43})
    assert guess.status_code == 404
    # and a token forwarded to the wrong account is refused
    other = await make_actor(client, "other")
    assert (await other.post("/invitations/accept", json={"token": inv["token"]})).status_code == 409
    assert (await client.get(f"/ventures/{v}/leads", headers=h)).json() == []


async def test_no_email_enumeration_via_members(poc, client):
    outsider = await make_actor(client, "enum")
    fake_org = uuid.uuid4()
    known = await outsider.post(f"/orgs/{fake_org}/members", json={"user_email": poc["owner"].email, "role": "viewer"})
    unknown = await outsider.post(f"/orgs/{fake_org}/members", json={"user_email": "nobody@example.com",
                                                                      "role": "viewer"})
    assert known.status_code == unknown.status_code == 404 and known.json() == unknown.json()


async def test_old_access_tokens_die_on_password_change(client):
    email = f"pw-{uuid.uuid4().hex[:6]}@example.com"
    t = (await client.post("/auth/register", json={"email": email, "full_name": "P",
                                                   "password": "correct horse battery"})).json()
    import asyncio
    await asyncio.sleep(1.1)   # tokens carry whole-second iat
    old = {"Authorization": f"Bearer {t['access_token']}"}
    new = (await client.post("/auth/password", headers=old, json={"current_password": "correct horse battery",
                                                                  "new_password": "a new long passphrase"})).json()
    assert (await client.get("/auth/me", headers=old)).status_code == 401
    assert (await client.get("/auth/me", headers={"Authorization": f"Bearer {new['access_token']}"})).status_code == 200


async def test_password_hashes_not_readable_by_app_role(poc):
    app = await asyncpg.connect(RAW_APP_DSN)
    try:
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(poc["owner"].id))
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await app.fetch("SELECT password_hash FROM users")
    finally:
        await app.close()


async def test_sensitive_drafts_cannot_be_forged_as_auto_approved(poc):
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        run = await admin.fetchrow("SELECT id, org_id, venture_id, run_as FROM workflow_runs WHERE venture_id = $1"
                                   " LIMIT 1", uuid.UUID(poc["soft"]))
        await admin.execute("INSERT INTO agent_trust (org_id, venture_id, agent, action, auto_run) VALUES"
                            " ($1, $2, 'proposal', 'gmail.send', true) ON CONFLICT (venture_id, agent, action)"
                            " DO UPDATE SET auto_run = true", run["org_id"], run["venture_id"])
    finally:
        await admin.close()
    app = await asyncpg.connect(RAW_APP_DSN)
    try:
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(run["run_as"]))
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await app.execute(
                    "INSERT INTO approvals (org_id, venture_id, run_id, step, agent, action, capability, title,"
                    " payload_enc, status, sensitive) VALUES ($1, $2, $3, 's', 'proposal', 'gmail.send', 'send', 't',"
                    " '\\x00', 'auto_approved', true)", run["org_id"], run["venture_id"], run["id"])
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(run["run_as"]))
            with pytest.raises(asyncpg.InsufficientPrivilegeError):   # an operator-decidable draft
                await app.execute(
                    "INSERT INTO approvals (org_id, venture_id, run_id, step, agent, action, capability, title,"
                    " payload_enc, required_roles) VALUES ($1, $2, $3, 's', 'x', 'gmail.send', 'send', 't', '\\x00',"
                    " '{operator}')", run["org_id"], run["venture_id"], run["id"])
    finally:
        await app.close()
        admin = await asyncpg.connect(ADMIN_DSN)
        await admin.execute("UPDATE agent_trust SET auto_run = false WHERE venture_id = $1", run["venture_id"])
        await admin.close()
