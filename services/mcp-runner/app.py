"""Kritvia MCP runner: hosts MCP servers that speak stdio (npm, PyPI or container-image packages) for the App
store, one sandboxed container per installed app, and lets Kritvia talk to them over HTTP.

Only packages Kritvia's team approved reach here (the API checks the App store's review before it asks), at the
exact version approved. Every instance runs with:

  1. Kernel isolation   gVisor (runtime runsc): the app's syscalls hit a user-space kernel, not the host's.
  2. Container limits   read-only root, small tmpfs home, all capabilities dropped, no-new-privileges, uid 65534,
                        memory/CPU/pids caps, its own container.
  3. Network            an internal Docker network with no route out; the only way out is this runner's egress
                        proxy (guard.py), with the instance's own credentials and only the sites approved for it
                        (plus the package registry it installs from). No access to Kritvia's database, cache,
                        model gateway or other services.
  4. Secrets            the app's settings (API keys) arrive with each start, pass to the container through the
                        environment of the docker command (never its arguments), and are never logged.

HTTP (internal network only, bearer MCP_RUNNER_TOKEN):
  PUT    /instances/{id}   start (or keep) an instance: {package, egress_hosts, env}
  DELETE /instances/{id}   stop it
  POST   /mcp/{id}         one JSON-RPC message (MCP Streamable HTTP, JSON answers); 409 when not running
  GET    /healthz

The bridge answers `initialize` itself from the instance's first handshake, so every Kritvia request can open a
"session" without restarting the app. Instances idle for 15 minutes are stopped (and started again on the next
call); at most MAX_INSTANCES run at once (the least recently used is stopped first).
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import socket
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

import guard

log = logging.getLogger("kritvia.mcp_runner")
TOKEN = os.environ.get("MCP_RUNNER_TOKEN", "")
RUNTIME = os.environ.get("MCP_RUNTIME", "runsc")
NETWORK = os.environ.get("MCP_NETWORK", "kritvia_mcp-sandbox")
PROXY_HOST = os.environ.get("MCP_PROXY_HOST", "mcp-runner")
PROXY_PORT = int(os.environ.get("MCP_PROXY_PORT", "8301"))
MAX_INSTANCES = int(os.environ.get("MCP_MAX_INSTANCES", "20"))
IDLE_S = int(os.environ.get("MCP_IDLE_S", "900"))
START_S = int(os.environ.get("MCP_START_S", "120"))
CALL_S = 60
LOCAL = os.environ.get("MCP_RUNNER_LOCAL") == "1"      # tests: no docker
MAX_LINE = 4 * 1024 * 1024
NODE_IMAGE = os.environ.get("MCP_NODE_IMAGE", "node:24-slim")
UV_IMAGE = os.environ.get("MCP_UV_IMAGE", "ghcr.io/astral-sh/uv:python3.12-bookworm-slim")
REGISTRY_HOSTS = {"npm": ["registry.npmjs.org"], "pypi": ["pypi.org", "files.pythonhosted.org"], "oci": []}
ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
PKG_RE = {"npm": re.compile(r"^(@[a-z0-9][a-z0-9._\-]*/)?[a-z0-9][a-z0-9._\-]*$"),
          "pypi": re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$"),
          "oci": re.compile(r"^[a-z0-9][a-z0-9._\-/:]*[a-z0-9]$")}
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-+]{0,59}$")
ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
RESERVED_ENV = {"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "HOME", "PATH",
                "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "LD_PRELOAD", "PYTHONPATH", "UV_CACHE_DIR"}



class Package(BaseModel):
    registryType: str = Field(pattern=r"^(npm|pypi|oci)$")
    identifier: str = Field(max_length=200)
    version: str = Field(max_length=60)
    env: list[dict[str, Any]] = Field(default_factory=list)


class StartIn(BaseModel):
    package: Package
    egress_hosts: list[str] = Field(default_factory=list, max_length=30)
    env: dict[str, str] = Field(default_factory=dict)


@dataclass
class Instance:
    id: str
    config_hash: str
    proc: asyncio.subprocess.Process
    grant: guard.Grant
    init_result: dict[str, Any] | None = None
    used_at: float = field(default_factory=time.monotonic)
    pending: dict[int, asyncio.Future] = field(default_factory=dict)
    next_id: int = 0
    reader: asyncio.Task | None = None
    stderr_tail: list[str] = field(default_factory=list)

    @property
    def alive(self) -> bool:
        return self.proc.returncode is None


INSTANCES: dict[str, Instance] = {}
_locks: dict[str, asyncio.Lock] = {}
_proxy: guard.EgressProxy | None = None
app = FastAPI(title="Kritvia MCP runner", version="1.0.0")


def _lookup(user: str) -> guard.Grant | None:
    inst = INSTANCES.get(user)
    return inst.grant if inst else None


def config_hash(cfg: StartIn) -> str:
    return hashlib.sha256(json.dumps(cfg.model_dump(), sort_keys=True).encode()).hexdigest()


def validate(cfg: StartIn) -> None:
    p = cfg.package
    if not PKG_RE[p.registryType].match(p.identifier) or ".." in p.identifier:
        raise HTTPException(422, "that package name isn't allowed")
    if p.registryType != "oci" and not VERSION_RE.match(p.version):
        raise HTTPException(422, "that package version isn't allowed")
    for k, v in cfg.env.items():
        if not ENV_RE.match(k) or k in RESERVED_ENV or len(v) > 4000 or "\n" in v or "\0" in v:
            raise HTTPException(422, f"setting {k[:40]!r} isn't allowed")
    for h in cfg.egress_hosts:
        if not re.fullmatch(r"(\*\.)?([a-z0-9-]{1,63}\.)+[a-z]{2,63}", h):
            raise HTTPException(422, f"{h[:60]!r} isn't a site name")


def image_and_command(p: Package) -> tuple[str, list[str], dict[str, str]]:
    if p.registryType == "npm":
        return NODE_IMAGE, ["npx", "--yes", f"{p.identifier}@{p.version}"], {
            "NODE_USE_ENV_PROXY": "1", "npm_config_cache": "/home/app/.npm", "npm_config_update_notifier": "false"}
    if p.registryType == "pypi":
        return UV_IMAGE, ["uvx", f"{p.identifier}=={p.version}"], {
            "UV_CACHE_DIR": "/home/app/.cache/uv", "UV_TOOL_DIR": "/home/app/.local/uv"}
    ref = p.identifier if ":" in p.identifier.rsplit("/", 1)[-1] or p.version in ("", "latest") \
        else f"{p.identifier}:{p.version}"
    return ref, [], {}


_proxy_ip: str | None = None


def proxy_address() -> str:
    """This runner's address on the sandbox network. An IP, not a name: under gVisor the app containers can't use
    Docker's embedded DNS, and they need nothing else resolved (the proxy connects to sites by name)."""
    global _proxy_ip
    if _proxy_ip or LOCAL:
        return _proxy_ip or PROXY_HOST
    import subprocess
    try:
        out = subprocess.run(["docker", "inspect", "-f",
                              '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % NETWORK, socket.gethostname()],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", out):
            _proxy_ip = out
    except (OSError, subprocess.SubprocessError):
        pass
    return _proxy_ip or PROXY_HOST


def argv_for(inst_id: str, cfg: StartIn, proxy_secret: str) -> tuple[list[str], dict[str, str]]:
    """The docker command, and the environment it runs with (secrets go in the environment, not argv)."""
    image, cmd, extra = image_and_command(cfg.package)
    proxy = f"http://{inst_id}:{proxy_secret}@{proxy_address()}:{PROXY_PORT}"
    env = {**extra, "HTTPS_PROXY": proxy, "HTTP_PROXY": proxy, "https_proxy": proxy,
           "http_proxy": proxy, "NO_PROXY": "", **cfg.env}
    argv = ["docker", "run", "--rm", "-i", "--name", f"kv-mcp-{inst_id}", f"--runtime={RUNTIME}",
            f"--network={NETWORK}", "--read-only",
            "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
            "--tmpfs", "/home/app:rw,nosuid,nodev,exec,size=512m,uid=65534,gid=65534",
            "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "65534:65534",
            "--memory=768m", "--memory-swap=768m", "--cpus=0.5", "--pids-limit=128",
            "--ulimit", "nofile=1024:1024", "--label", "kritvia.mcp=1", "--workdir", "/home/app",
            "--env", "HOME=/home/app"]
    for k in env:
        argv += ["--env", k]
    argv.append(image)
    argv += cmd
    return argv, env


def _auth(authorization: str | None) -> None:
    if not TOKEN:
        raise HTTPException(503, "MCP_RUNNER_TOKEN not configured")
    if not hmac.compare_digest((authorization or "").removeprefix("Bearer ").strip(), TOKEN):
        raise HTTPException(401, "bad token")


async def _send(inst: Instance, msg: dict[str, Any]) -> None:
    assert inst.proc.stdin is not None
    inst.proc.stdin.write(json.dumps(msg, separators=(",", ":")).encode() + b"\n")
    await inst.proc.stdin.drain()


async def _read_loop(inst: Instance) -> None:
    assert inst.proc.stdout is not None
    while True:
        try:
            line = await inst.proc.stdout.readline()
        except (ValueError, asyncio.LimitOverrunError):
            log.warning("instance %s sent an over-long line", inst.id)
            break
        if not line:
            break
        try:
            msg = json.loads(line)
        except ValueError:
            continue          # some servers print logs to stdout
        if not isinstance(msg, dict):
            continue
        if "method" in msg and "id" in msg:      # the server asks something of the client
            reply: dict[str, Any] = {"jsonrpc": "2.0", "id": msg["id"]}
            if msg["method"] == "ping":
                reply["result"] = {}
            else:
                reply["error"] = {"code": -32601, "message": "not supported by Kritvia"}
            with contextlib.suppress(Exception):
                await _send(inst, reply)
            continue
        fut = inst.pending.pop(msg.get("id"), None) if isinstance(msg.get("id"), int) else None
        if fut and not fut.done():
            fut.set_result(msg)
    for fut in inst.pending.values():
        if not fut.done():
            fut.set_exception(ConnectionError("the app stopped"))
    inst.pending.clear()


async def _stderr_loop(inst: Instance) -> None:
    assert inst.proc.stderr is not None
    while True:
        line = await inst.proc.stderr.readline()
        if not line:
            break
        inst.stderr_tail.append(line.decode("utf-8", "replace").rstrip()[:300])
        del inst.stderr_tail[:-20]


async def request(inst: Instance, method: str, params: dict[str, Any] | None, timeout: float = CALL_S) -> dict:
    inst.next_id += 1
    rid = inst.next_id
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    inst.pending[rid] = fut
    await _send(inst, {"jsonrpc": "2.0", "id": rid, "method": method, **({"params": params} if params is not None else {})})
    try:
        return await asyncio.wait_for(fut, timeout)
    finally:
        inst.pending.pop(rid, None)


async def spawn(argv: list[str], env: dict[str, str]) -> asyncio.subprocess.Process:
    """Starts the process (tests replace this to run a local stdio server)."""
    return await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/root"), **env},
        limit=MAX_LINE)


async def stop(inst_id: str) -> None:
    inst = INSTANCES.pop(inst_id, None)
    if inst is None:
        return
    if inst.alive:
        with contextlib.suppress(ProcessLookupError):
            inst.proc.terminate()
        try:
            await asyncio.wait_for(inst.proc.wait(), 10)
        except (TimeoutError, asyncio.TimeoutError):
            with contextlib.suppress(ProcessLookupError):
                inst.proc.kill()
    if not LOCAL:                                         # make sure the container is gone
        rm = await asyncio.create_subprocess_exec("docker", "rm", "-f", f"kv-mcp-{inst_id}",
                                                  stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await rm.wait()
    if inst.reader:
        inst.reader.cancel()


async def start(inst_id: str, cfg: StartIn) -> Instance:
    while len(INSTANCES) >= MAX_INSTANCES:
        oldest = min(INSTANCES.values(), key=lambda i: i.used_at)
        await stop(oldest.id)
    secret = secrets.token_urlsafe(24)
    hosts = sorted(set(cfg.egress_hosts) | set(REGISTRY_HOSTS[cfg.package.registryType]))
    argv, env = argv_for(inst_id, cfg, secret)
    proc = await spawn(argv, env)
    inst = Instance(id=inst_id, config_hash=config_hash(cfg), proc=proc, grant=guard.Grant(secret=secret, hosts=hosts))
    INSTANCES[inst_id] = inst
    inst.reader = asyncio.create_task(_read_loop(inst))
    asyncio.create_task(_stderr_loop(inst))
    try:
        res = await request(inst, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                 "clientInfo": {"name": "Kritvia", "version": "1.0"}}, timeout=START_S)
        if "error" in res:
            raise RuntimeError(str(res["error"].get("message", ""))[:200])
        inst.init_result = res.get("result") or {}
        await _send(inst, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    except (TimeoutError, asyncio.TimeoutError, ConnectionError, RuntimeError, BrokenPipeError) as exc:
        tail = " | ".join(inst.stderr_tail[-3:]) or str(exc) or type(exc).__name__
        blocked = "; blocked: " + ", ".join(inst.grant.blocked[-3:]) if inst.grant.blocked else ""
        await stop(inst_id)
        raise HTTPException(502, f"the app didn't start: {tail[:300]}{blocked[:300]}") from None
    return inst


@app.put("/instances/{inst_id}")
async def put_instance(inst_id: str, cfg: StartIn, authorization: str | None = Header(default=None)) -> dict:
    _auth(authorization)
    if not ID_RE.match(inst_id):
        raise HTTPException(422, "bad instance id")
    validate(cfg)
    lock = _locks.setdefault(inst_id, asyncio.Lock())
    async with lock:
        inst = INSTANCES.get(inst_id)
        if inst and inst.alive and inst.config_hash == config_hash(cfg):
            inst.used_at = time.monotonic()
            return {"status": "running"}
        if inst:
            await stop(inst_id)
        await start(inst_id, cfg)
    return {"status": "started"}


@app.delete("/instances/{inst_id}")
async def delete_instance(inst_id: str, authorization: str | None = Header(default=None)) -> Response:
    _auth(authorization)
    await stop(inst_id)
    return Response(status_code=204)


@app.post("/mcp/{inst_id}")
async def mcp(inst_id: str, request_: Request, authorization: str | None = Header(default=None)) -> Response:
    _auth(authorization)
    inst = INSTANCES.get(inst_id)
    if inst is None or not inst.alive or inst.init_result is None:
        if inst is not None:
            await stop(inst_id)
        return JSONResponse({"detail": "not running"}, status_code=409)
    raw = await request_.body()
    if len(raw) > 1_000_000:
        raise HTTPException(413, "too large")
    try:
        msg = json.loads(raw)
    except ValueError:
        raise HTTPException(400, "not JSON") from None
    if not isinstance(msg, dict) or not isinstance(msg.get("method"), str):
        raise HTTPException(400, "not a JSON-RPC request")
    inst.used_at = time.monotonic()
    method = msg["method"]
    if "id" not in msg:                                   # a notification
        if method != "notifications/initialized":
            with contextlib.suppress(Exception):
                await _send(inst, {"jsonrpc": "2.0", "method": method, **({"params": msg["params"]} if "params" in msg else {})})
        return Response(status_code=202)
    if method == "initialize":
        return JSONResponse({"jsonrpc": "2.0", "id": msg["id"], "result": inst.init_result})
    try:
        res = await request(inst, method, msg.get("params"))
    except (TimeoutError, asyncio.TimeoutError):
        return JSONResponse({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32001, "message": "the app took too long"}})
    except (ConnectionError, BrokenPipeError):
        await stop(inst_id)
        return JSONResponse({"detail": "the app stopped"}, status_code=409)
    out = {"jsonrpc": "2.0", "id": msg["id"]}
    out.update({k: res[k] for k in ("result", "error") if k in res})
    if inst.grant.blocked and "result" in out and isinstance(out["result"], dict) and out["result"].get("isError"):
        out["result"].setdefault("content", []).append(
            {"type": "text", "text": "Kritvia's guard blocked: " + "; ".join(inst.grant.blocked[-3:])})
    return JSONResponse(out)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "instances": len(INSTANCES), "runtime": RUNTIME}


async def _reaper() -> None:
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        for inst in list(INSTANCES.values()):
            if not inst.alive or now - inst.used_at > IDLE_S:
                await stop(inst.id)


async def _clean_old_containers() -> None:
    """Containers left from a previous run of the runner (it restarted): remove them."""
    with contextlib.suppress(Exception):
        p = await asyncio.create_subprocess_exec("docker", "ps", "-aq", "--filter", "label=kritvia.mcp=1",
                                                 stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await p.communicate()
        ids = out.decode().split()
        if ids:
            rm = await asyncio.create_subprocess_exec("docker", "rm", "-f", *ids, stdout=asyncio.subprocess.DEVNULL,
                                                      stderr=asyncio.subprocess.DEVNULL)
            await rm.wait()


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    global _proxy
    if not LOCAL:
        await _clean_old_containers()
    _proxy = guard.EgressProxy(lookup=_lookup, port=PROXY_PORT)
    await _proxy.start()
    reaper = asyncio.create_task(_reaper())
    try:
        yield
    finally:
        reaper.cancel()
        for i in list(INSTANCES):
            await stop(i)
        await _proxy.close()


app.router.lifespan_context = lifespan
