"""Client for the sandbox runner (services/sandbox).

HttpSandbox  production: POST to the runner, which starts a gVisor container per job.
LocalSandbox dev/tests: same allow-listed jobs in a subprocess with CPU/memory/time
             limits but WITHOUT network isolation — refuses to run in production.
"""
from __future__ import annotations

import asyncio
import json
import os
import resource
import sys
from typing import Any, Protocol

import httpx

from kritvia_api.config import ancestor

JOBS_PATH = ancestor(__file__, 4) / "services" / "sandbox" / "jobs"
ALLOWED = {"forecast", "bom", "echo", "net_probe"}


class SandboxError(Exception):
    pass


class SandboxClient(Protocol):
    isolated: bool

    async def run(self, job: str, payload: dict[str, Any], timeout_s: int = 60) -> dict[str, Any]: ...


class HttpSandbox:
    isolated = True

    def __init__(self, url: str, token: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._http = httpx.AsyncClient(base_url=url, headers={"Authorization": f"Bearer {token}"},
                                       transport=transport, timeout=660)

    async def run(self, job: str, payload: dict[str, Any], timeout_s: int = 60) -> dict[str, Any]:
        if job not in ALLOWED:
            raise SandboxError(f"job {job!r} is not allow-listed")
        r = await self._http.post("/run", json={"job": job, "input": payload, "timeout_s": timeout_s})
        if r.status_code != 200:
            raise SandboxError(f"sandbox {job} failed: HTTP {r.status_code} {r.text[:300]}")
        return r.json()["output"]


def _limits(memory_mb: int, cpu_s: int):  # pragma: no cover - runs in the child
    def apply() -> None:
        resource.setrlimit(resource.RLIMIT_AS, (memory_mb * 1024 * 1024,) * 2)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s))
        resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))
    return apply


class LocalSandbox:
    isolated = False

    def __init__(self, environment: str, memory_mb: int = 1024) -> None:
        if environment == "production":
            raise SandboxError("LocalSandbox has no network isolation; set SANDBOX_URL in production")
        self.memory_mb = memory_mb

    async def run(self, job: str, payload: dict[str, Any], timeout_s: int = 60) -> dict[str, Any]:
        if job not in ALLOWED:
            raise SandboxError(f"job {job!r} is not allow-listed")
        env = {"PYTHONPATH": str(JOBS_PATH), "PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"}
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", "-c",
            f"import sys; sys.path.insert(0, {str(JOBS_PATH)!r}); import runpy;"
            f" sys.argv=['kritvia_jobs', {job!r}]; runpy.run_module('kritvia_jobs', run_name='__main__')",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, preexec_fn=_limits(self.memory_mb, timeout_s))
        try:
            out, err = await asyncio.wait_for(proc.communicate(json.dumps(payload).encode()), timeout_s)
        except TimeoutError:
            proc.kill()
            raise SandboxError(f"job {job} timed out") from None
        if proc.returncode != 0:
            raise SandboxError(f"job {job} failed: {err.decode()[-500:]}")
        return json.loads(out)
