"""Kritvia sandbox runner.

Three layers of defence in depth for every job:

  1. Kernel isolation   gVisor (runtime runsc): the job's syscalls hit a user-space
                        kernel, not the host's.
  2. Container limits   --network=none, read-only root, tmpfs /tmp (64 MB, noexec),
                        all capabilities dropped, no-new-privileges, uid 65534,
                        memory/CPU/pids caps, wall-clock timeout, fresh container per job.
  3. Job allow-list     only jobs baked into the kritvia-sandbox-jobs image can run
                        (no arbitrary code); input and output sizes are capped.

The runner is the only component with Docker access. It listens on the internal
compose network only and requires a shared bearer token.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
import time

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

JOBS = {"forecast", "bom", "echo", "net_probe"}
IMAGE = os.environ.get("SANDBOX_IMAGE", "kritvia-sandbox-jobs:latest")
RUNTIME = os.environ.get("SANDBOX_RUNTIME", "runsc")
TOKEN = os.environ.get("SANDBOX_TOKEN", "")
MAX_OUTPUT = 5 * 1024 * 1024

app = FastAPI(title="Kritvia sandbox runner", version="1.0.0")


class RunIn(BaseModel):
    job: str
    input: dict = Field(default_factory=dict)
    timeout_s: int = Field(default=60, ge=1, le=600)
    memory_mb: int = Field(default=512, ge=64, le=2048)
    cpus: float = Field(default=1.0, gt=0, le=2)


def docker_argv(req: RunIn) -> list[str]:
    return [
        "docker", "run", "--rm", "-i",
        f"--runtime={RUNTIME}",
        "--network=none",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user", "65534:65534",
        f"--memory={req.memory_mb}m", f"--memory-swap={req.memory_mb}m",
        f"--cpus={req.cpus}",
        "--pids-limit=64",
        "--ulimit", "nofile=256:256",
        "--env", "PYTHONDONTWRITEBYTECODE=1",
        IMAGE, "python", "-I", "-m", "kritvia_jobs", req.job,
    ]


def _auth(authorization: str | None) -> None:
    if not TOKEN:
        raise HTTPException(503, "SANDBOX_TOKEN not configured")
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(given, TOKEN):
        raise HTTPException(401, "bad token")


@app.post("/run")
async def run(req: RunIn, authorization: str | None = Header(default=None)) -> dict:
    _auth(authorization)
    if req.job not in JOBS:
        raise HTTPException(422, "job not allow-listed")
    data = json.dumps(req.input).encode()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "input too large")
    started = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        *docker_argv(req), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(data), timeout=req.timeout_s + 15)
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "job timed out") from None
    if proc.returncode != 0:
        raise HTTPException(500, f"job failed (exit {proc.returncode}): {err.decode()[-500:]}")
    if len(out) > MAX_OUTPUT:
        raise HTTPException(500, "output too large")
    return {"output": json.loads(out), "duration_ms": int((time.perf_counter() - started) * 1000)}


@app.get("/healthz")
async def healthz() -> dict:
    """Proves isolation: the probe job must NOT reach the network."""
    probe = await run(RunIn(job="net_probe", timeout_s=10), authorization=f"Bearer {TOKEN}")
    isolated = probe["output"].get("network") is False
    if not isolated:
        raise HTTPException(500, "SANDBOX NOT ISOLATED: probe reached the network")
    return {"status": "ok", "network_isolated": True, "runtime": RUNTIME}
