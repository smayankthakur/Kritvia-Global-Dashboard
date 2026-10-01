"""Meeting digest: recording -> transcript -> speakers -> decisions & tasks.

  transcribe (speech tier) -> diarize (pyannote sidecar, optional)
  -> ingest transcript (chunks carry start/end + speaker)
  -> extraction focused on decisions / tasks / commitments, each cited to a timestamp.
"""
from __future__ import annotations

import json
import uuid

import httpx
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import Finish, Goto, Workflow, registry
from kritvia_api.services import memory, speech
from kritvia_api.services.memory import RAW_PURPOSE

async def _authorize(conn, venture_id: uuid.UUID, inp: dict) -> None:
    try:
        doc_id = uuid.UUID(str(inp.get("document_id")))
    except ValueError:
        raise LookupError("recording not found") from None
    ok = (await conn.execute(text("SELECT 1 FROM documents WHERE id = :d AND venture_id = :v AND kind = 'meeting'"),
                             {"d": doc_id, "v": venture_id})).first()
    if ok is None:
        raise LookupError("recording not found")


wf = registry.register(Workflow(
    "meeting_digest", title="Meeting digest", start="transcribe", authorize_input=_authorize,
    description="Transcribes an uploaded recording, separates speakers and extracts decisions, owners and tasks "
                "with timestamp citations."))


async def diarize(audio: bytes, filename: str) -> list[dict]:
    """Optional pyannote sidecar (services/diarization). Returns [{start, end, speaker}] or []."""
    import os
    url = os.environ.get("DIARIZATION_URL")
    if not url:
        return []
    async with httpx.AsyncClient(timeout=900) as client:
        r = await client.post(f"{url}/diarize", files={"file": (filename, audio)},
                              headers={"Authorization": f"Bearer {os.environ.get('DIARIZATION_TOKEN', '')}"})
        r.raise_for_status()
        return r.json().get("turns", [])


def assign_speakers(segments: list[dict], turns: list[dict]) -> list[dict]:
    """Give each transcript segment the speaker whose turn overlaps it most."""
    if not turns:
        return segments
    out = []
    for s in segments:
        best, overlap = None, 0.0
        for t in turns:
            o = min(s["end"], t["end"]) - max(s["start"], t["start"])
            if o > overlap:
                best, overlap = t["speaker"], o
        out.append({**s, "speaker": best or s.get("speaker")})
    return out


@wf.step("transcribe", agent="transcription")
async def transcribe(ctx: RunContext, state: dict) -> Goto | Finish:
    doc_id = uuid.UUID(state["input"]["document_id"])
    async with ctx.tx() as conn:
        doc = (await conn.execute(text("SELECT title, raw_enc, sensitive, meta, access_roles FROM documents"
                                       " WHERE id = :id AND kind = 'meeting'"), {"id": doc_id})).first()
        if doc is None or doc.raw_enc is None:
            return Finish("recording_not_found")
        audio = await ctx.crypto(conn).decrypt(ctx.venture_id, RAW_PURPOSE, doc.raw_enc)
        # Shared venture vocabulary: spelling hints for the model, then sounds-like replacement.
        vocab = await speech.load_vocabulary(conn, ctx.venture_id, personal=False)
        hints, share_people = await speech.load_hints(conn, ctx.venture_id, vocab)
    filename = doc.meta.get("filename", "meeting.webm")
    cfg = ctx.services.router.config
    tr = await ctx.transcribe(audio, filename, sensitive=doc.sensitive,
                              hints_for=lambda d: hints.for_policy(cfg.is_private(d), share_people))
    opts = speech.CleanupOptions(remove_fillers=True, profanity_filter=False, vocabulary=vocab)
    tr.text, used = speech.clean_transcript(tr.text, opts)
    tr.segments = speech.clean_segments(tr.segments, opts)
    if used:
        ctx.note(f"vocabulary corrected {len(used)} term(s)")
    try:
        turns = await diarize(audio, filename)
    except Exception as exc:
        turns = []
        ctx.note(f"speaker separation unavailable ({type(exc).__name__})")
    segments = assign_speakers(tr.segments, turns) if tr.segments else []
    names = state["input"].get("speaker_names") or {}
    for s in segments:
        if s.get("speaker") in names:
            s["speaker"] = names[s["speaker"]]
    duration = max((s["end"] for s in segments), default=0)
    return Goto("digest", update={"transcript": tr.text, "segments": segments, "language": tr.language,
                                  "sensitive": doc.sensitive, "access_roles": doc.access_roles, "title": doc.title, "duration_s": duration},
                note=f"{len(segments)} segments, {len({s.get('speaker') for s in segments if s.get('speaker')})} "
                     f"speaker(s), {int(duration // 60)} min")


@wf.step("digest", agent="extraction")
async def digest(ctx: RunContext, state: dict) -> Finish:
    doc_id = uuid.UUID(state["input"]["document_id"])
    res = await memory.ingest(
        ctx, title=f"Transcript — {state['title']}", kind="transcript", text_override=state["transcript"],
        segments=state["segments"] or None, sensitive=state["sensitive"], extraction_focus="meeting",
        access_roles=state.get("access_roles"),
        meta={"meeting_document_id": str(doc_id), "language": state.get("language"),
              "duration_s": state.get("duration_s")})
    async with ctx.tx() as conn:
        counts = (await conn.execute(text(
            "SELECT kind, count(*) AS n FROM facts f JOIN chunks c ON c.id = f.source_chunk_id"
            " WHERE c.document_id = :d GROUP BY kind"), {"d": res.document_id})).all()
        await conn.execute(text("UPDATE documents SET status = 'ready', meta = meta || CAST(:m AS jsonb) WHERE id = :id"),
                           {"m": json.dumps({"transcript_document_id": str(res.document_id),
                                             "duration_s": state.get("duration_s")}), "id": doc_id})
    by = {r.kind: r.n for r in counts}
    return Finish("completed", update={"summary": {"transcript_document_id": str(res.document_id), **by}},
                  note=f"{by.get('decision', 0)} decision(s), {by.get('task', 0)} task(s)")
