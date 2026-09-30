"""Optional speaker-separation sidecar (pyannote.audio).

POST /diarize (multipart 'file') -> {"turns": [{"start", "end", "speaker"}]}
Runs on the VM; audio never leaves it. Requires a Hugging Face token with the
pyannote model licence accepted (HF_TOKEN). CPU inference on ARM is slow
(roughly real-time); fine for uploaded meetings processed in the background.
"""
from __future__ import annotations

import hmac
import os
import tempfile

from fastapi import FastAPI, File, Header, HTTPException, UploadFile

app = FastAPI(title="Kritvia diarization", version="1.0.0")
TOKEN = os.environ.get("DIARIZATION_TOKEN", "")
_pipeline = None


def pipeline():
    global _pipeline
    if _pipeline is None:
        from pyannote.audio import Pipeline
        _pipeline = Pipeline.from_pretrained(os.environ.get("PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1"),
                                             use_auth_token=os.environ["HF_TOKEN"])
    return _pipeline


@app.post("/diarize")
async def diarize(file: UploadFile = File(...), authorization: str | None = Header(default=None)) -> dict:
    if not TOKEN or not hmac.compare_digest((authorization or "").removeprefix("Bearer ").strip(), TOKEN):
        raise HTTPException(401, "bad token")
    data = await file.read(200 * 1024 * 1024 + 1)
    if len(data) > 200 * 1024 * 1024:
        raise HTTPException(413, "file too large")
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename or "a.wav")[1]) as tmp:
        tmp.write(data)
        tmp.flush()
        result = pipeline()(tmp.name)
    turns = [{"start": round(t.start, 2), "end": round(t.end, 2), "speaker": spk}
             for t, _, spk in result.itertracks(yield_label=True)]
    return {"turns": turns}


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok"}
