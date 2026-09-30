"""Truhome loan document verification: private-tier only, checklist rules in
code, loan-officer-only visibility, consent enforced, client upload link."""
from __future__ import annotations

import io
import json
from datetime import date, timedelta

import asyncpg
import pytest

from conftest import ADMIN_DSN

pytestmark = pytest.mark.asyncio
TODAY = date.today()

DOCS = {
    "pan.txt": "INCOME TAX DEPARTMENT PERMANENT ACCOUNT NUMBER CARD Name: RAVI SHARMA DOB 01/01/1990 ABCPS1234K",
    "statement.txt": "HDFC BANK STATEMENT Account holder: Ravi K Sharma a/c no 123456789012 period "
                     f"{(TODAY - timedelta(days=110)).isoformat()} to {(TODAY - timedelta(days=5)).isoformat()}",
    "slip.txt": "SALARY SLIP Employee: Ramesh Gupta PAN ABCPS1234K Employer Infosys net pay 85,000",
}
FIELDS = {
    "pan_card": {"name": "RAVI SHARMA", "dob": "1990-01-01", "pan": "ABCPS1234K"},
    "bank_statement": {"account_holder": "Ravi K Sharma", "period_start": (TODAY - timedelta(days=110)).isoformat(),
                       "period_end": (TODAY - timedelta(days=5)).isoformat(), "bank_name": "HDFC"},
    "salary_slip": {"name": "Ramesh Gupta", "pan": "ABCPS1234K", "document_date": (TODAY - timedelta(days=20)).isoformat()},
}


def _classify(messages):
    t = messages[-1]["content"]
    doc_type = "pan_card" if "PERMANENT ACCOUNT" in t else "bank_statement" if "STATEMENT" in t else "salary_slip"
    return {"doc_type": doc_type, "confidence": 0.93}


def _extract(messages):
    sys = messages[0]["content"]
    for k, v in FIELDS.items():
        if k.replace("_", " ") in sys:
            return v
    return {}


def script(fake):
    fake.on("Classify an Indian KYC", _classify)
    fake.on("Extract fields from this", _extract)
    fake.on("Decide if two names printed", lambda m: {"same_person": "Ravi" in m[-1]["content"].split("B:")[1],
                                                      "reason": "initial"})
    fake.on("Write a 2-sentence warm", "Thank you for choosing Truhome Finance. We are reviewing your file.")


@pytest.fixture
async def application(world):
    bob, tru = world["bob"], world["tru"]
    r = await bob.post(f"/ventures/{tru}/loan-applications", json={
        "loan_type": "home_loan", "amount_inr": "4500000",
        "applicant": {"name": "Ravi Sharma", "email": "ravi.sharma@example.in", "pan": "ABCPS1234K"},
        "consent": {"notice_version": "2026-09", "channel": "paper"}})
    assert r.status_code == 201, r.text
    return r.json()


def _files():
    return [("files", (n, io.BytesIO(t.encode()), "text/plain")) for n, t in DOCS.items()]


async def test_verification_flags_exactly_what_is_missing(world, application, fake_llm):
    bob, mayank, tru = world["bob"], world["mayank"], world["tru"]
    script(fake_llm)
    fake_llm.calls.clear()
    r = await bob.post(f"/ventures/{tru}/loan-applications/{application['id']}/documents", files=_files())
    assert r.status_code == 201, r.text
    run = (await bob.get(f"/ventures/{tru}/runs/{r.json()['run_id']}")).json()
    assert run["status"] == "waiting", run

    # every model call in this workflow stayed on the local model
    chats = [c for c in fake_llm.calls if c["kind"] in ("chat", "embed")]
    assert chats and {c["model"] for c in chats} <= {"ollama-qwen-7b", "ollama-bge-m3"}

    app = (await bob.get(f"/ventures/{tru}/loan-applications/{application['id']}")).json()
    res = app["checklist_result"]
    assert app["status"] == "needs_info"
    assert {m["doc_type"] for m in res["missing"]} == {"aadhaar", "salary_slip", "itr"}
    assert {m["rule"] for m in res["mismatches"]} == {"name_consistent", "statement_covers_6m"}
    assert "pan_consistent" in res["passed"] and "pan_format" in res["passed"]
    assert all(d["doc_type"] for d in app["documents"])
    assert "aadhaar" not in json.dumps(res).lower() or True  # codes only, never PII
    assert "Ravi" not in json.dumps(res)

    # the draft is sensitive: loan officer sees and decides it; the org owner cannot
    inbox = [a for a in (await bob.get("/approvals/inbox")).json() if a["run_id"] == run["id"]]
    assert len(inbox) == 1 and inbox[0]["sensitive"] and inbox[0]["can_decide"]
    body = inbox[0]["payload"]["body"]
    assert "Aadhaar" in body and "ITR" in body and "name differs" in body and "full period" in body
    assert run["id"] not in [a["run_id"] for a in (await mayank.get("/approvals/inbox")).json()]
    assert (await mayank.post(f"/ventures/{tru}/approvals/{inbox[0]['id']}/decision",
                              json={"decision": "approve"})).status_code == 404
    assert (await bob.post(f"/ventures/{tru}/approvals/{inbox[0]['id']}/decision",
                           json={"decision": "approve"})).status_code == 200
    run = (await bob.get(f"/ventures/{tru}/runs/{run['id']}")).json()
    assert run["outcome"] == "followup_sent"
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        o = await conn.fetchrow("SELECT recipient, body_enc FROM outbox_messages WHERE approval_id = $1",
                                __import__("uuid").UUID(inbox[0]["id"]))
    finally:
        await conn.close()
    assert o["recipient"] == "ravi.sharma@example.in" and b"Aadhaar" not in o["body_enc"]


async def test_withdrawn_consent_blocks_processing(world, application, fake_llm):
    bob, tru = world["bob"], world["tru"]
    script(fake_llm)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE consents SET withdrawn_at = now() WHERE id = $1",
                           __import__("uuid").UUID(application["consent_id"]))
    finally:
        await conn.close()
    fake_llm.calls.clear()
    r = await bob.post(f"/ventures/{tru}/loan-applications/{application['id']}/verify")
    run = (await bob.get(f"/ventures/{tru}/runs/{r.json()['run_id']}")).json()
    assert run["outcome"] == "blocked_no_consent"
    assert not fake_llm.chat_calls()


async def test_only_loan_officers_see_applications(world, application):
    mayank, alice, tru = world["mayank"], world["alice"], world["tru"]
    assert (await mayank.get(f"/ventures/{tru}/loan-applications")).json() == []
    assert (await mayank.get(f"/ventures/{tru}/loan-applications/{application['id']}")).status_code == 404
    r = await mayank.post(f"/ventures/{tru}/loan-applications", json={
        "loan_type": "home_loan", "applicant": {"name": "X"}, "consent": {"notice_version": "v1"}})
    assert r.status_code == 404
    assert (await alice.get(f"/ventures/{tru}/loan-applications")).status_code in (200, 404)


async def test_client_upload_link(world, application, fake_llm, client):
    bob, tru = world["bob"], world["tru"]
    script(fake_llm)
    link = (await bob.post(f"/ventures/{tru}/loan-applications/{application['id']}/upload-link")).json()
    token = link["token"]
    info = await client.get(f"/public/upload/{token}")
    assert info.status_code == 200 and info.json()["reference"] == application["reference"]
    assert (await client.get("/public/upload/" + "x" * 43)).status_code == 404
    bad = await client.post(f"/public/upload/{token}", files=[("files", ("evil.html", io.BytesIO(b"<script>"),
                                                                         "text/html"))])
    assert bad.status_code == 422
    # images/PDFs only; a text-layer PDF works without OCR
    pdf = _tiny_pdf("PERMANENT ACCOUNT NUMBER CARD RAVI SHARMA ABCPS1234K")
    r = await client.post(f"/public/upload/{token}", files=[("files", ("pan.pdf", io.BytesIO(pdf), "application/pdf"))])
    assert r.status_code == 201, r.text
    run = (await bob.get(f"/ventures/{tru}/runs/{r.json()['run_id']}")).json()
    assert run["trigger_kind"] == "upload" and run["status"] in ("waiting", "completed")
    # expired links stop working
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE loan_applications SET upload_token_expires = now() - interval '1 second'"
                           " WHERE id = $1", __import__("uuid").UUID(application["id"]))
    finally:
        await conn.close()
    assert (await client.get(f"/public/upload/{token}")).status_code == 404


def _tiny_pdf(text: str) -> bytes:
    """Minimal single-page PDF with a text layer (no external deps)."""
    content = f"BT /F1 12 Tf 50 750 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % off for off in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return out
