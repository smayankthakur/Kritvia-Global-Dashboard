"""Voice: transcript cleanup, vocabulary, auto-learn, Sarvam routing, hints privacy, insights."""
from __future__ import annotations

import io
import json
import uuid
from pathlib import Path
from datetime import date

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, FAKE_LLM, make_actor
from kritvia_api.routers.voice import streak
from kritvia_api.services import speech
from kritvia_api.services.model_router import ModelRouter, TierConfig, speech_candidates


def audio():
    # unique bytes: documents are de-duplicated by content hash
    return {"file": ("note.webm", io.BytesIO(b"\x1aE\xdf\xa3voice-" + uuid.uuid4().bytes), "audio/webm")}


def speech_calls():
    return [c for c in FAKE_LLM.calls if c["kind"] == "speech"]


# ----------------------------------------------------------------- pure logic --
def test_cleanup_filters_match_scribe_behaviour():
    assert speech.strip_annotations("[BLANK_AUDIO]. Okay.") == "Okay."
    assert speech.strip_annotations("(dramatic music) *cough*") == ""
    assert speech.strip_annotations("Thank you.") == "Thank you."   # never reject real short dictation
    assert speech.remove_fillers("Uh, hello um world") == "Hello world"
    assert speech.remove_fillers("Yes, um, fine") == "Yes, fine"
    assert speech.remove_fillers("It's an umbrella, errand, summer") == "It's an umbrella, errand, summer"
    assert speech.remove_fillers("hmm, ah I see") == "hmm, ah I see"
    assert speech.mask_profanity("what the shit in Assam") == "what the **** in Assam"
    looped = " ".join(["send the deck"] * 8)
    assert speech.trim_stuck_loops(looped) == "send the deck send the deck"


def test_vocabulary_replacement_is_whole_word_longest_first_and_indic_safe():
    k, s = uuid.uuid4(), uuid.uuid4()
    vocab = [speech.VocabEntry(k, "Kritvia", ("kreet via", "critvia")),
             speech.VocabEntry(s, "Sitelytc", ("site lytic",)),
             speech.VocabEntry(None, "₹", ("rupees",))]
    out, used = speech.apply_vocabulary("send the kreet via deck to site lytic; critvia costs 5 rupees", vocab)
    assert out == "send the Kritvia deck to Sitelytc; Kritvia costs 5 ₹"
    assert set(used) == {k, s}
    # casing of the term itself is enforced; inside other words nothing changes
    assert speech.apply_vocabulary("kritvia and kritvianess", vocab)[0] == "Kritvia and kritvianess"
    # Devanagari combining marks are part of the word: "क" must not match inside "कि"
    assert speech.apply_vocabulary("मैं कि", [speech.VocabEntry(None, "X", ("क",))])[0] == "मैं कि"
    assert speech.apply_vocabulary("शर्मा जी", [speech.VocabEntry(None, "Sharma ji", ("शर्मा जी",))])[0] == "Sharma ji"


def test_auto_learn_diff():
    assert speech.single_diff_region("send it to wisper team.", "send it to VSPR team.") == ("wisper", "VSPR")
    assert speech.single_diff_region("kritvia is great", "Kritvia is great") == ("kritvia", "Kritvia")
    assert speech.single_diff_region("hello world", "hello big world") is None      # insertion
    assert speech.single_diff_region("same text", "same text") is None
    assert speech.is_learnable("kreet via", "Kritvia")
    assert not speech.is_learnable("a b c d e", "the whole sentence was rewritten here")


def test_hints_respect_data_policy():
    h = speech.Hints(local=["Kritvia", "Acme Corp", "Ravi Sharma", "kritvia"], cloud=[])
    assert h.for_policy(local_ok=True) == ["Kritvia", "Acme Corp", "Ravi Sharma"]
    assert h.for_policy(local_ok=False) == []
    assert speech.whisper_prompt(["Kritvia", "Sitelytc"]) == "Glossary: Kritvia, Sitelytc."


def test_large_vocabulary_is_fast_and_safe():
    import time
    big = [speech.VocabEntry(uuid.uuid4(), f"Term{i}", tuple(f"form{i} x{j}" for j in range(20))) for i in range(1000)]
    t0 = time.perf_counter()
    for _ in range(20):
        out, _ = speech.apply_vocabulary("please say form7 x3 and term99 " * 30, big)
    assert time.perf_counter() - t0 < 3
    assert out.startswith("please say Term7 and Term99")
    # placeholder code points in the input can't be turned into terms
    assert speech.apply_vocabulary("hello \U000F0000 kritvia", [speech.VocabEntry(None, "Kritvia")])[0] == "hello  Kritvia"
    # dictated parentheses survive; caption cues don't
    assert speech.strip_annotations("Budget (3 lakh) (dramatic music) ok") == "Budget (3 lakh) ok"


def test_streak_counts_back_from_today_or_yesterday():
    t = date(2026, 10, 1)
    assert streak([date(2026, 10, 1), date(2026, 9, 30), date(2026, 9, 28)], t) == 2
    assert streak([date(2026, 9, 30), date(2026, 9, 29)], t) == 2
    assert streak([date(2026, 9, 25)], t) == 0


def test_engine_choice_orders_candidates_and_policy_wins():
    from kritvia_api.config import get_settings
    cfg = TierConfig.load(get_settings().tiers_config_path)
    assert cfg.engine("sarvam-saaras") == "sarvam" and cfg.engine("local-whisper") == "local"
    assert speech_candidates(cfg, "dictation", sensitive=False) == ["groq-whisper", "local-whisper"]
    assert speech_candidates(cfg, "dictation", sensitive=False, engine="whisper")[0] == "groq-whisper"
    assert speech_candidates(cfg, "dictation", sensitive=False, engine="local") == ["local-whisper"]
    # Sarvam does not do Spanish
    assert "sarvam-saaras" not in speech_candidates(cfg, "dictation", sensitive=False, language="es")
    # sensitive audio never reaches a hosted engine, whatever the user picked
    assert speech_candidates(cfg, "dictation", sensitive=True, engine="sarvam") == ["local-whisper"]


# --------------------------------------------------------------------- Sarvam --
@pytest.fixture
def sarvam(services):
    """Swap in a router that has a Sarvam key for one test."""
    old = services.router
    services.router = ModelRouter(old.config, "http://litellm", "k", transport=httpx.MockTransport(FAKE_LLM),
                                  sarvam_api_key="sk-sarvam-test")
    yield services.router
    services.router = old


async def test_sarvam_stays_out_of_dictation_even_with_a_key(world, fake_llm, sarvam):
    """Sarvam's standard terms allow training on inputs, so it is not in any chain (see tiers.yaml)."""
    mayank, v = world["mayank"], world["site"]
    await mayank.post(f"/ventures/{v}/vocabulary", json={"term": "Kritvia", "sounds_like": ["kreet via"],
                                                         "scope": "shared"})
    await mayank.put(f"/ventures/{v}/settings", json={"speech_people_hints": True})  # allow hints to hosted models
    fake_llm.transcript = {"text": "kreet via ka demo kal bhejna hai", "segments": []}
    fake_llm.calls.clear()
    r = await mayank.post(f"/ventures/{v}/voice/dictate", files=audio(),
                          data={"language": "hi", "duration_ms": "3000", "engine": "sarvam"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["text"] == "Kritvia ka demo kal bhejna hai" and out["deployment"] == "groq-whisper"
    assert out["fallback"] is True                              # asked for Sarvam, got Whisper
    assert [c["model"] for c in speech_calls()] == ["groq-whisper"]
    assert "Kritvia" in speech_calls()[-1]["prompt"]          # Whisper gets the glossary prompt
    await mayank.put(f"/ventures/{v}/settings", json={"speech_people_hints": False})


async def test_without_sarvam_key_it_is_skipped(world, fake_llm):
    alice, v = world["alice"], world["site"]
    fake_llm.transcript = {"text": "hello there", "segments": []}
    r = await alice.post(f"/ventures/{v}/voice/dictate", files=audio())
    assert r.status_code == 200 and r.json()["deployment"] == "groq-whisper"
    assert [c["model"] for c in speech_calls()] == ["groq-whisper"]
    opts = (await alice.get("/voice/options")).json()
    assert {e["engine"]: e["available"] for e in opts["engines"]}["sarvam"] is False


async def test_local_engine_never_falls_back_to_cloud(world, fake_llm):
    alice, v = world["alice"], world["site"]
    fake_llm.transcript = {"text": "private note", "segments": []}
    fake_llm.fail["local-whisper"] = 503
    r = await alice.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"engine": "local"})
    assert r.status_code == 503
    assert [c["model"] for c in speech_calls()] == ["local-whisper"]


# ------------------------------------------------------------ hints privacy --
async def _entities(v: str, rows: list[tuple]) -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        org = await conn.fetchval("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
        for etype, name, roles, sensitive in rows:
            eid = await conn.fetchval(
                "INSERT INTO entities (org_id, venture_id, type, name, canonical, access_roles)"
                " VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", org, uuid.UUID(v), etype, name, name.lower(), roles)
            doc = await conn.fetchval(
                "INSERT INTO documents (org_id, venture_id, title, kind, sha256, size_bytes, sensitive, status)"
                " VALUES ($1,$2,$3,'note',$4,1,$5,'ready') RETURNING id",
                org, uuid.UUID(v), f"src {name}", uuid.uuid4().hex, sensitive)
            chunk = await conn.fetchval(
                "INSERT INTO chunks (org_id, venture_id, document_id, ord, text_enc, char_count, access_roles, sensitive)"
                " VALUES ($1,$2,$3,0,'\\x00',1,$4,$5) RETURNING id", org, uuid.UUID(v), doc, roles, sensitive)
            await conn.execute(
                "INSERT INTO facts (org_id, venture_id, kind, statement_enc, subject_id, source_chunk_id, access_roles)"
                " VALUES ($1,$2,'fact','\\x00',$3,$4,$5)", org, uuid.UUID(v), eid, chunk, roles)
    finally:
        await conn.close()


async def test_hints_never_leak_restricted_or_sensitive_names(world, fake_llm):
    mayank, bob, v = world["mayank"], world["bob"], world["tru"]
    await _entities(v, [("company", "Zentrix Labs", None, False),
                        ("person", "Priyanka Venkatesh", None, False),
                        ("company", "Quietcorp Holdings", None, True),          # only ever in a sensitive file
                        ("person", "Applicant Secretname", ["loan_officer"], False)])
    # the loan officer can see the restricted name, but it is never suggested (shared terms are public)
    sug = [s["term"] for s in (await bob.get(f"/ventures/{v}/vocabulary/suggestions")).json()]
    assert "Zentrix Labs" in sug and "Applicant Secretname" not in sug
    # ...and typing it in as a term doesn't turn it into a hint
    await bob.post(f"/ventures/{v}/vocabulary", json={"term": "Applicant Secretname", "scope": "shared"})
    await bob.post(f"/ventures/{v}/vocabulary", json={"term": "Bob Private Client", "scope": "personal"})
    fake_llm.transcript = {"text": "call zentrix", "segments": []}

    # default: hosted models get no hints at all
    await bob.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"engine": "whisper"})
    assert speech_calls()[-1]["prompt"] == ""
    # local models get vocabulary and names, never restricted ones
    fake_llm.calls.clear()
    await bob.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"engine": "local"})
    p = speech_calls()[-1]["prompt"]
    assert all(x in p for x in ("Zentrix Labs", "Priyanka Venkatesh", "Bob Private Client", "Quietcorp"))
    assert "Secretname" not in p
    # opted in: hosted models get vocabulary + names, minus restricted and sensitive-only ones
    r = await mayank.put(f"/ventures/{v}/settings", json={"speech_people_hints": True})
    assert r.json()["speech_people_hints"] is True
    fake_llm.calls.clear()
    await bob.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"engine": "whisper"})
    p = speech_calls()[-1]["prompt"]
    assert "Zentrix Labs" in p and "Priyanka Venkatesh" in p and "Bob Private Client" in p
    assert "Secretname" not in p and "Quietcorp" not in p
    await mayank.put(f"/ventures/{v}/settings", json={"speech_people_hints": False})


async def test_dictation_does_not_reveal_who_said_what(world, fake_llm):
    alice, vera, v = world["alice"], world["vera"], world["site"]
    t = (await alice.post(f"/ventures/{v}/vocabulary", json={"term": "Zorblax Deal", "sounds_like": ["zor blacks deal"],
                                                             "scope": "shared"})).json()
    fake_llm.transcript = {"text": "update the zor blacks deal", "segments": []}
    out = (await alice.post(f"/ventures/{v}/voice/dictate", files=audio())).json()
    assert out["text"] == "update the Zorblax Deal"
    terms = {x["id"]: x for x in (await vera.get(f"/ventures/{v}/vocabulary")).json()}
    assert terms[t["id"]]["uses"] == 1                       # the count is visible...
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        n = await conn.fetchval("SELECT count(*) FROM audit_log WHERE entity_table IN ('vocabulary_terms', 'vocabulary_usage')"
                                " AND action LIKE '%update' AND entity_id = $1", t["id"])
        u = await conn.fetchval("SELECT count(*) FROM audit_log WHERE entity_table = 'vocabulary_usage'")
    finally:
        await conn.close()
    assert n == 0 and u == 0                                 # ...but not who used it, or when


async def test_vocabulary_limits(world):
    vera, v = world["vera"], world["site"]
    r = await vera.post(f"/ventures/{v}/vocabulary", json={"term": "x", "sounds_like": ["y" * 65]})
    assert r.status_code == 422
    r = await vera.post(f"/ventures/{v}/vocabulary/import", json={"terms": [{"term": f"t{i}"} for i in range(501)]})
    assert r.status_code == 422


# ---------------------------------------------------------- vocabulary access --
async def test_vocabulary_scopes_and_permissions(world):
    mayank, alice, vera, mallory, v = world["mayank"], world["alice"], world["vera"], world["mallory"], world["site"]
    # viewer: personal yes, shared no
    r = await vera.post(f"/ventures/{v}/vocabulary", json={"term": "Vera's Client", "scope": "personal"})
    assert r.status_code == 201 and r.json()["scope"] == "personal"
    r = await vera.post(f"/ventures/{v}/vocabulary", json={"term": "Nope", "scope": "shared"})
    assert r.status_code == 403
    # operator: shared terms; same spelling merges sounds-like forms
    a = await alice.post(f"/ventures/{v}/vocabulary", json={"term": "Sitelytc", "sounds_like": ["site lytic"],
                                                             "scope": "shared"})
    b = await alice.post(f"/ventures/{v}/vocabulary", json={"term": "sitelytc", "sounds_like": ["sight lit sea"],
                                                             "scope": "shared"})
    assert a.json()["id"] == b.json()["id"]
    assert set(b.json()["sounds_like"]) == {"site lytic", "sight lit sea"}
    # personal terms are private, even from the org owner
    p = await alice.post(f"/ventures/{v}/vocabulary", json={"term": "Alice Private", "scope": "personal"})
    owner_view = {t["term"] for t in (await mayank.get(f"/ventures/{v}/vocabulary")).json()}
    assert "Sitelytc" in owner_view and "Alice Private" not in owner_view and "Vera's Client" not in owner_view
    assert (await mayank.delete(f"/ventures/{v}/vocabulary/{p.json()['id']}")).status_code == 404
    # shared terms are visible to viewers, editable only by writers
    assert "Sitelytc" in {t["term"] for t in (await vera.get(f"/ventures/{v}/vocabulary")).json()}
    assert (await vera.patch(f"/ventures/{v}/vocabulary/{a.json()['id']}",
                             json={"case_sensitive": True})).status_code == 404
    # outsiders see nothing
    assert (await mallory.get(f"/ventures/{v}/vocabulary")).status_code == 404
    assert (await mallory.post(f"/ventures/{v}/vocabulary", json={"term": "x"})).status_code == 404
    # edit and delete own
    e = await alice.patch(f"/ventures/{v}/vocabulary/{p.json()['id']}", json={"sounds_like": ["alis private"]})
    assert e.json()["sounds_like"] == ["alis private"]
    assert (await alice.delete(f"/ventures/{v}/vocabulary/{p.json()['id']}")).status_code == 204
    imp = await alice.post(f"/ventures/{v}/vocabulary/import",
                           json={"terms": [{"term": "Next.js"}, {"term": "VAPT", "sounds_like": ["vee apt"]}]})
    assert imp.json() == {"imported": 2}


async def test_auto_learn(world, fake_llm):
    alice, v = world["alice"], world["site"]
    peek = await alice.post(f"/ventures/{v}/vocabulary/learn",
                            json={"original": "send it to wisper team", "edited": "send it to VSPR team",
                                  "save": False})
    assert peek.json() == {"learned": False, "heard": "wisper", "correct": "VSPR", "term": None}
    r = await alice.post(f"/ventures/{v}/vocabulary/learn", json={"heard": "wisper", "correct": "VSPR"})
    body = r.json()
    assert body["learned"] and body["term"]["source"] == "auto_learn" and body["term"]["sounds_like"] == ["wisper"]
    # next dictation uses it
    fake_llm.transcript = {"text": "Um, ask wisper for the logo", "segments": []}
    out = (await alice.post(f"/ventures/{v}/voice/dictate", files=audio())).json()
    assert out["text"] == "Ask VSPR for the logo" and out["vocabulary_applied"] == 1
    # rewrites of whole sentences are not "learned"
    r = await alice.post(f"/ventures/{v}/vocabulary/learn",
                         json={"original": "a b c d e f", "edited": "completely different words that are many more"})
    assert r.json()["learned"] is False


# ------------------------------------------------------- settings & dictation --
async def test_settings_filters_modes_and_insights(world, fake_llm):
    vera, alice, v = world["vera"], world["alice"], world["site"]
    me = await make_actor(alice.c, "dictator")
    assert (await me.get("/me/voice-settings")).json()["engine"] == "auto"
    s = {"engine": "whisper", "language": "hi", "remove_fillers": False, "profanity_filter": True,
         "auto_learn": True, "hotkey": "AltRight", "widget_enabled": True}
    assert (await vera.put("/me/voice-settings", json=s)).json() == s
    assert (await vera.put("/me/voice-settings", json={**s, "language": "klingon"})).status_code == 422
    assert (await vera.put("/me/voice-settings", json={**s, "hotkey": "a; DROP"})).status_code == 422

    fake_llm.transcript = {"text": "Um, this shit works", "segments": []}
    out = (await vera.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"duration_ms": "6000"})).json()
    assert out["text"] == "Um, this **** works"               # fillers kept, profanity masked (Vera's choice)
    assert speech_calls()[-1]["language"] == "hi"

    # accidental taps are ignored without calling a model
    fake_llm.calls.clear()
    short = (await vera.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"duration_ms": "300"})).json()
    assert short["status"] == "too_short" and not speech_calls()

    # silence -> no_speech, nothing recorded
    fake_llm.transcript = {"text": "[BLANK_AUDIO]", "segments": []}
    assert (await vera.post(f"/ventures/{v}/voice/dictate", files=audio())).json()["status"] == "no_speech"

    # a viewer cannot save notes; a writer can
    fake_llm.transcript = {"text": "Remember to call Acme about the renewal", "segments": []}
    r = await vera.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"mode": "note"})
    assert r.status_code == 403
    r = await alice.post(f"/ventures/{v}/voice/dictate", files=audio(), data={"mode": "note", "surface": "desktop",
                                                                             "duration_ms": "4000"})
    doc = r.json()["note_document_id"]
    d = (await alice.get(f"/ventures/{v}/documents/{doc}")).json()
    assert d["kind"] == "note" and d["title"].startswith("Voice note")

    ins = (await vera.get("/me/dictation/insights")).json()
    assert ins["dictations"] == 1 and ins["words"] == 4 and ins["streak_days"] == 1
    assert ins["avg_wpm"] == 40 and ins["by_engine"][0]["key"] == "whisper"
    assert ins["days"][-1]["words"] == 4
    a_ins = (await alice.get("/me/dictation/insights")).json()
    assert {b["key"] for b in a_ins["by_surface"]} >= {"desktop"} and {b["key"] for b in a_ins["by_mode"]} >= {"note"}
    # stats are private: nobody else's events, and you can clear yours
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        total = await conn.fetchval("SELECT count(*) FROM dictation_events WHERE user_id = $1", vera.id)
        cols = {r["column_name"] for r in await conn.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'dictation_events'")}
    finally:
        await conn.close()
    assert total == 1 and not ({"text", "transcript", "audio"} & cols)
    assert (await vera.delete("/me/dictation/history")).status_code == 204
    assert (await vera.get("/me/dictation/insights")).json()["dictations"] == 0
    assert (await alice.get("/me/dictation/insights")).json()["dictations"] >= 1


async def test_meeting_transcript_uses_shared_vocabulary(world, fake_llm):
    mayank, v = world["mayank"], world["site"]
    await mayank.post(f"/ventures/{v}/vocabulary", json={"term": "Truhome", "sounds_like": ["true home"],
                                                         "scope": "shared"})
    await mayank.post(f"/ventures/{v}/vocabulary", json={"term": "MayankOnly", "sounds_like": ["true home"],
                                                         "scope": "personal"})
    fake_llm.transcript = {"text": "Uh, true home launch is Friday.", "language": "en",
                           "segments": [{"start": 0, "end": 4, "text": "Uh, true home launch is Friday."}]}
    fake_llm.on("meeting transcript", {"entities": [], "edges": [], "facts": []})
    await mayank.put(f"/ventures/{v}/settings", json={"speech_people_hints": True})
    r = await mayank.post(f"/ventures/{v}/meetings", files=audio(), data={"title": "Vocab standup"})
    await mayank.put(f"/ventures/{v}/settings", json={"speech_people_hints": False})
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['run_id']}")).json()
    assert run["status"] == "completed", run
    assert "Truhome" in speech_calls()[-1]["prompt"]
    doc = (await mayank.get(f"/ventures/{v}/documents")).json()
    t = next(d for d in doc if d["title"] == "Transcript — Vocab standup")
    detail = (await mayank.get(f"/ventures/{v}/documents/{t['id']}")).json()
    body = json.dumps(detail)
    assert "Truhome launch is Friday." in body and "MayankOnly" not in body and "Uh," not in body


def test_ancestor_tolerates_shallow_install(tmp_path):
    """The Docker image installs the package at /app/kritvia_api — repo-relative paths must not crash."""
    from kritvia_api.config import ancestor

    f = tmp_path / "a" / "b.py"
    assert ancestor(f, 1) == tmp_path
    assert ancestor("/app/kritvia_api/config.py", 3) == Path("/")
