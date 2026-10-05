"""Days 31–45 exit criteria: cited answers with working source links; voice and
meetings produce decisions/tasks cited to timestamps; PII is masked; restricted
documents are invisible outside their role (enforced by the database)."""
from __future__ import annotations

import io
import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN

from kritvia_api.services import pii
from kritvia_api.services.memory import chunk_text


PROPOSAL_NOTE = (
    "Proposal to Zenith Dental, March 2026.\n\n"
    "Scope: Next.js clinic website with online booking, WhatsApp reminders, and an AI receptionist workflow.\n\n"
    "Price quoted: 3.2 lakh plus GST. Timeline eight weeks. Outcome: accepted, project delivered in May.")


def script_extraction(fake):
    fake.on("You build a company knowledge graph", {
        "entities": [{"name": "Zenith Dental", "type": "company"}, {"name": "Sitelytc", "type": "company"}],
        "edges": [{"src": "Zenith Dental", "dst": "Sitelytc", "type": "client of", "source": 0}],
        "facts": [{"statement": "Sitelytc proposed a Next.js clinic website with booking to Zenith Dental",
                   "kind": "fact", "subject": "Zenith Dental", "source": 0},
                  {"statement": "An uncited claim", "kind": "fact", "source": 99}]})


async def test_ingest_extract_and_cited_answer(world, fake_llm):
    alice, v = world["alice"], world["site"]
    script_extraction(fake_llm)
    r = await alice.post(f"/ventures/{v}/notes", json={"title": "Zenith Dental proposal", "text": PROPOSAL_NOTE,
                                                       "kind": "proposal"})
    assert r.status_code == 201, r.text
    res = r.json()
    assert res["chunks"] >= 1 and res["embedded"] and res["facts"] == 1   # the uncited fact was discarded
    doc_id = res["document_id"]

    # duplicate upload is recognised
    again = (await alice.post(f"/ventures/{v}/notes", json={"title": "dup", "text": PROPOSAL_NOTE,
                                                            "kind": "proposal"})).json()
    assert again["duplicate"] and again["document_id"] == doc_id

    fake_llm.on("You answer questions for a business owner",
                "We proposed a Next.js clinic website with online booking and an AI receptionist [1]. "
                "It was accepted [1]. Irrelevant [7].")
    ans = (await alice.post(f"/ventures/{v}/ask", json={"question": "What did we propose to Zenith Dental?"})).json()
    assert ans["supported"] and ans["tier"] == "reason"
    assert "[7]" not in ans["answer"]                     # citations to non-existent sources are stripped
    cite = ans["citations"][0]
    assert cite["document_id"] == doc_id and "Zenith Dental" in cite["excerpt"]
    # the source link works
    d = await alice.get(f"/ventures/{v}/documents/{doc_id}?chunk_id={cite['chunk_id']}")
    assert d.status_code == 200 and cite["chunk_id"] in [c["id"] for c in d.json()["chunks"]]

    ents = (await alice.get(f"/ventures/{v}/entities?q=zenith")).json()
    assert ents and ents[0]["name"] == "Zenith Dental"
    detail = (await alice.get(f"/ventures/{v}/entities/{ents[0]['id']}")).json()
    assert detail["edges"][0]["type"] == "CLIENT_OF" and detail["facts"][0]["document_id"] == doc_id

    # Bob (Truhome) sees none of it
    bob = world["bob"]
    assert (await bob.get(f"/ventures/{v}/documents/{doc_id}")).status_code == 404
    assert (await bob.post(f"/ventures/{v}/ask", json={"question": "Zenith Dental?"})).status_code == 404


async def test_answer_without_citations_is_flagged(world, fake_llm):
    alice, v = world["alice"], world["site"]
    fake_llm.on("You answer questions for a business owner", "Probably about five clients.")
    ans = (await alice.post(f"/ventures/{v}/ask", json={"question": "How many dental clients?"})).json()
    assert ans["supported"] is False and ans["citations"] == []


def test_pii_masking():
    # 2345 6789 0124 is not a valid Aadhaar (Verhoeff); 4991 1122 3344 passes? compute a valid one
    from kritvia_api.services.pii import verhoeff_ok
    base = "49911122334"
    valid = next(base + str(d) for d in range(10) if verhoeff_ok(base + str(d)))
    invalid = next(base + str(d) for d in range(10) if not verhoeff_ok(base + str(d))).replace("4991", "2345", 1)
    invalid = invalid if not verhoeff_ok(invalid) else invalid[:-1] + str((int(invalid[-1]) + 1) % 10)
    inv = f"{invalid[:4]} {invalid[4:8]} {invalid[8:]}"
    text = (f"Aadhaar: {valid[:4]} {valid[4:8]} {valid[8:]} PAN ABCPS1234K card 4111 1111 1111 1111 "
            f"a/c no: 123456789012 call 98765 43210 order {inv}")
    r = pii.mask(text)
    assert valid not in text.replace(" ", "") or f"XXXX-XXXX-{valid[-4:]}" in r.text
    assert f"XXXX-XXXX-{valid[-4:]}" in r.text
    assert "XXXX-XXXX-XXXX-1111" in r.text and "XXXXXXXX9012" in r.text
    if not verhoeff_ok(invalid):
        assert inv in r.text                         # invalid checksum -> not an Aadhaar, untouched
    assert r.sensitive and {"aadhaar", "pan", "card", "bank_account", "phone"} <= set(r.tags)


def test_chunker_respects_size_and_overlap():
    text = "\n\n".join(f"Paragraph {i}. " + "word " * 150 for i in range(10))
    chunks = chunk_text(text, size=1200, overlap=150)
    assert all(len(c.text) <= 1200 for c in chunks)
    assert len(chunks) >= 7


async def test_restricted_document_is_invisible_outside_role(world, fake_llm):
    """Truhome raw documents: loan_officer only — even the org owner needs the role."""
    bob, mayank, tru = world["bob"], world["mayank"], world["tru"]
    files = {"file": ("salary.txt", io.BytesIO(b"Salary slip for Ravi Sharma, PAN ABCPS1234K, net pay 85,000"),
                      "text/plain")}
    r = await bob.post(f"/ventures/{tru}/documents", files=files,
                       data={"title": "Salary slip", "restricted_to": "loan_officer", "extract": "false"})
    assert r.status_code == 201, r.text
    doc = r.json()["document_id"]
    assert r.json()["sensitive"]
    assert (await bob.get(f"/ventures/{tru}/documents/{doc}")).status_code == 200
    assert (await mayank.get(f"/ventures/{tru}/documents/{doc}")).status_code == 404
    assert doc not in [d["id"] for d in (await mayank.get(f"/ventures/{tru}/documents")).json()]
    raw = await bob.get(f"/ventures/{tru}/documents/{doc}/raw")
    assert raw.status_code == 200 and b"Ravi Sharma" in raw.content
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        n = await conn.fetchval("SELECT count(*) FROM audit_log WHERE action = 'document.downloaded' AND entity_id = $1",
                                doc)
        stored = await conn.fetchval("SELECT raw_enc FROM documents WHERE id = $1", uuid.UUID(doc))
    finally:
        await conn.close()
    assert n == 1 and b"Ravi" not in stored          # encrypted at rest

    # questions touching sensitive chunks are answered by the local model only
    fake_llm.on("You answer questions for a business owner", "Net pay is listed [1].")
    ans = (await bob.post(f"/ventures/{tru}/ask", json={"question": "Ravi Sharma salary slip net pay"})).json()
    assert ans["tier"] == "private"
    assert fake_llm.chat_calls("You answer questions")[-1]["model"] == "ollama-qwen-7b"


async def test_meeting_recording_to_cited_tasks(world, fake_llm):
    alice, v = world["alice"], world["site"]
    fake_llm.transcript = {
        "text": "We agreed to launch on the 15th. Alice will send the design by Friday.",
        "language": "en",
        "segments": [{"start": 0.0, "end": 6.5, "text": "We agreed to launch on the 15th."},
                     {"start": 70.0, "end": 76.0, "text": "Alice will send the design by Friday."}]}
    fake_llm.on("meeting transcript", {
        "entities": [], "edges": [],
        "facts": [{"statement": "Launch date agreed for the 15th", "kind": "decision", "source": 0},
                  {"statement": "Send the design", "kind": "task", "owner": "Alice", "due_date": "2026-10-02",
                   "source": 1}]})
    files = {"file": ("standup.webm", io.BytesIO(b"\x1aE\xdf\xa3fake-audio"), "audio/webm")}
    r = await alice.post(f"/ventures/{v}/meetings", files=files, data={"title": "Weekly standup"})
    assert r.status_code == 202, r.text
    run = (await alice.get(f"/ventures/{v}/runs/{r.json()['run_id']}")).json()
    assert run["status"] == "completed", run
    tasks = (await alice.get(f"/ventures/{v}/facts?kind=task")).json()
    t = [x for x in tasks if x["statement"] == "Send the design"][0]
    assert t["owner"] == "Alice" and t["status"] == "open" and t["source_start_s"] == 70.0
    decisions = (await alice.get(f"/ventures/{v}/facts?kind=decision")).json()
    assert any(d["source_start_s"] == 0.0 for d in decisions)
    done = await alice.patch(f"/ventures/{v}/facts/{t['id']}", json={"status": "done"})
    assert done.json()["status"] == "done"


async def test_voice_note_transcribes(world, fake_llm):
    alice, v = world["alice"], world["site"]
    fake_llm.transcript = {"text": "Kal subah client ko proposal bhejna hai", "language": "hi", "segments": []}
    files = {"file": ("note.webm", io.BytesIO(b"\x1aE\xdf\xa3fake"), "audio/webm")}
    r = await alice.post(f"/ventures/{v}/transcribe", files=files)
    assert r.status_code == 200 and r.json()["text"].startswith("Kal subah")
    # sensitive voice notes never leave the VM
    fake_llm.calls.clear()
    r = await alice.post(f"/ventures/{v}/transcribe", files=files, data={"sensitive": "true"})
    assert r.status_code == 200
    assert [c["model"] for c in fake_llm.calls if c["kind"] == "speech"] == ["local-whisper"]
