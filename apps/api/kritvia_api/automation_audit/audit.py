"""Checks the catalogue against the real code and scores how much of the business Kritvia runs by itself.

    python -m kritvia_api.automation_audit                 print the scorecard
    python -m kritvia_api.automation_audit --json out.json  also write it as JSON
    python -m kritvia_api.automation_audit --write-baseline save today's levels as the floor

The test suite (tests/test_automation_audit.py) fails when an evidence pointer stops resolving, when a
job claims more than its evidence shows, when a new agent or tool isn't classified, or when a job's level
drops below the saved baseline.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from kritvia_api.automation_audit.catalogue import DOMAINS, JOBS, LEVELS, PLATFORM, Job

PACKAGE = Path(__file__).resolve().parent
REPO = PACKAGE.parents[3]
BASELINE = PACKAGE / "baseline.json"
WORKER = REPO / "apps/worker/kritvia_worker/main.py"
WEB_AGENTS = REPO / "apps/web/components/settings/workflows.tsx"

# Tools that are plumbing for other tools rather than a business job of their own.
INFRA_TOOLS = frozenset({"whatsapp.templates", "leads.search", "tasks.search", "shipments.search",
                         "indiamart.enquiries"})


@dataclass
class Check:
    ref: str
    ok: bool | None          # None: can't be checked here (e.g. the worker's code isn't in this image)
    detail: str = ""


@dataclass
class Index:
    workflows: dict[str, Any]
    tools: set[str]
    routes: dict[str, set[str]]    # path -> methods
    crons: set[str] | None         # None when the worker's code isn't available

    @classmethod
    def build(cls, openapi: dict[str, Any] | None = None) -> Index:
        from kritvia_api.engine.core import registry
        from kritvia_api.tools import build_tools
        import kritvia_api.workflows  # noqa: F401  (registers every workflow)
        if openapi is None:
            from kritvia_api.main import app
            openapi = app.openapi()
        routes = {p: {m.upper() for m in ops} for p, ops in openapi.get("paths", {}).items()}
        src = WORKER.read_text() if WORKER.exists() else None
        # cron(job, ...) entries, and the daily jobs run by daily_jobs from the DAILY table ("name", "fn", h, m, ...)
        # ...and the heartbeats, which run from their own task (_beat_forever(ctx, heartbeat))
        crons = (set(re.findall(r"cron\((\w+)", src)) | set(re.findall(r'^\s*\("\w+", "(\w+)", \d+, \d+', src, re.M))
                 | set(re.findall(r"_beat_forever\(ctx, (\w+)\)", src)) if src is not None else None)
        # Kritvia's own workflows (tests may register throwaway ones in the same registry)
        ours = {w.name: w for w in registry.all()
                if any(s.fn.__module__.startswith("kritvia_api.") for s in w.steps.values())}
        return cls(ours, {t["name"] for t in build_tools().catalogue()}, routes, crons)


def resolve(ref: str, ix: Index) -> Check:
    kind, _, rest = ref.partition(":")
    if kind == "wf":
        return Check(ref, rest in ix.workflows, "" if rest in ix.workflows else "no such workflow")
    if kind == "tool":
        return Check(ref, rest in ix.tools, "" if rest in ix.tools else "no such tool")
    if kind == "route":
        methods, _, path = rest.partition(" ")
        have = ix.routes.get(path)
        if have is None:
            return Check(ref, False, "no such route")
        missing = {m for m in methods.split(",")} - have
        return Check(ref, not missing, f"missing {','.join(sorted(missing))}" if missing else "")
    if kind == "cron":
        if ix.crons is None:
            return Check(ref, None, "worker code not available")
        return Check(ref, rest in ix.crons, "" if rest in ix.crons else "no such cron job")
    if kind == "code":
        file, _, needle = rest.partition("::")
        p = REPO / file
        if not p.exists():
            return Check(ref, None, "file not available")
        return Check(ref, needle in p.read_text(), "" if needle in p.read_text() else "text not found")
    return Check(ref, False, "unknown evidence kind")


def starts_by_itself(ref: str, ix: Index) -> bool:
    """Evidence that the job starts without a person: a clock or event workflow, a cron job, a webhook
    route, or a database trigger."""
    kind, _, rest = ref.partition(":")
    if kind == "wf":
        wf = ix.workflows.get(rest)
        return bool(wf) and wf.starts != "request"
    if kind == "cron":
        return True
    if kind == "route":
        path = rest.partition(" ")[2]
        return path.startswith("/hooks/") or path.startswith("/public/")
    if kind == "code":
        return "TRIGGER" in rest or "/hooks/" in rest or "def turn" in rest
    return False


def job_problems(job: Job, ix: Index, checks: list[Check]) -> list[str]:
    out = [f"{c.ref}: {c.detail}" for c in checks if c.ok is False]
    if job.level not in LEVELS:
        out.append(f"unknown level {job.level}")
    if job.domain not in DOMAINS:
        out.append(f"unknown domain {job.domain}")
    if not 0 <= job.level <= job.ceiling or job.target > job.ceiling or job.target < job.level:
        out.append("levels must satisfy level <= target <= ceiling")
    if job.level >= 1 and not job.evidence:
        out.append("a job Kritvia does needs evidence in the code")
    if job.level >= 2 and not any(r.startswith(("wf:", "tool:")) or "complete_json" in r or starts_by_itself(r, ix)
                                  for r in job.evidence):
        out.append("level 2+ needs an agent, a tool or something that runs by itself")
    if job.level >= 3 and not any(starts_by_itself(r, ix) for r in job.evidence):
        out.append("level 3+ needs evidence that it starts by itself (a clock or event agent, cron, webhook)")
    if job.level == 0 and job.evidence:
        out.append("a level-0 job shouldn't point at code")
    if job.target > job.level and not job.next:
        out.append("say what would take it to its target (next)")
    return out


def integrity(ix: Index) -> list[dict[str, Any]]:
    """Ways an automation can look on and still never run."""
    found: list[dict[str, Any]] = []
    for wf in ix.workflows.values():
        if wf.starts == "clock" and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", wf.default_schedule or ""):
            found.append({"check": "clock agents have a default time", "workflow": wf.name,
                          "problem": "runs on a clock but has no default time, so switching it on can leave it idle"})
        if wf.starts != "clock" and wf.default_schedule:
            found.append({"check": "only clock agents have a time", "workflow": wf.name,
                          "problem": "has a default time but starts on events or requests"})
    if WEB_AGENTS.exists():
        web = dict(re.findall(r"^\s+(\w+): \{ at: \"(\d\d:\d\d)\"", WEB_AGENTS.read_text(), re.M))
        server = {w.name: w.default_schedule for w in ix.workflows.values() if w.starts == "clock"}
        if web != server:
            found.append({"check": "the Agents page shows the same times as the server", "workflow": "*",
                          "problem": f"web {web} != server {server}"})
    return found


def classify_coverage(ix: Index) -> dict[str, list[str]]:
    refs = {r for j in JOBS for r in j.evidence} | {r for c in PLATFORM for r in c.evidence}
    return {
        "workflows": sorted(n for n in ix.workflows if f"wf:{n}" not in refs),
        "tools": sorted(t for t in ix.tools if f"tool:{t}" not in refs and t not in INFRA_TOOLS),
    }


def run(ix: Index | None = None) -> dict[str, Any]:
    ix = ix or Index.build()
    jobs: list[dict[str, Any]] = []
    for j in JOBS:
        checks = [resolve(r, ix) for r in j.evidence]
        jobs.append({**asdict(j), "level_name": LEVELS[j.level], "evidence": [asdict(c) for c in checks],
                     "problems": job_problems(j, ix, checks),
                     "self_starting": any(starts_by_itself(r, ix) for r in j.evidence)})
    platform = [{**asdict(c), "evidence": [asdict(resolve(r, ix)) for r in c.evidence]} for c in PLATFORM]

    def score(rows: list[dict[str, Any]]) -> dict[str, Any]:
        w = sum(r["impact"] for r in rows) or 1
        return {
            "jobs": len(rows),
            "autonomy": round(100 * sum(r["level"] * r["impact"] for r in rows) / (4 * w)),
            "target": round(100 * sum(r["target"] * r["impact"] for r in rows) / (4 * w)),
            "runs_by_itself": sum(r["level"] >= 3 for r in rows),
            "fully": sum(r["level"] == 4 for r in rows),
            "not_in_kritvia": sum(r["level"] == 0 for r in rows),
        }

    by_domain = {d: {"name": n, **score([r for r in jobs if r["domain"] == d])} for d, n in DOMAINS.items()}
    roadmap = sorted((r for r in jobs if r["target"] > r["level"]),
                     key=lambda r: (-(r["target"] - r["level"]) * r["impact"], -r["impact"], r["key"]))
    return {
        "levels": LEVELS,
        "summary": {**score(jobs), "levels": {n: sum(r["level"] == n for r in jobs) for n in LEVELS}},
        "domains": by_domain,
        "jobs": jobs,
        "platform": platform,
        "integrity": integrity(ix),
        "unclassified": classify_coverage(ix),
        "roadmap": [{"key": r["key"], "title": r["title"], "domain": r["domain"], "from": r["level"],
                     "to": r["target"], "impact": r["impact"], "next": r["next"]} for r in roadmap],
        "workflows": {n: {"title": w.title, "starts": w.starts, "default_schedule": w.default_schedule,
                          "trigger": w.trigger} for n, w in sorted(ix.workflows.items())},
    }


def baseline() -> dict[str, int]:
    return json.loads(BASELINE.read_text()) if BASELINE.exists() else {}


def regressions(report: dict[str, Any]) -> list[str]:
    base = baseline()
    now = {j["key"]: j["level"] for j in report["jobs"]}
    out = [f"{k}: level {now[k]} < baseline {v}" for k, v in base.items() if k in now and now[k] < v]
    out += [f"{k}: in the baseline but no longer in the catalogue" for k in base if k not in now]
    out += [f"{k}: new job, not in the baseline (run --write-baseline)" for k in now if k not in base]
    return out


def markdown(report: dict[str, Any]) -> str:
    s = report["summary"]
    lines = ["# Kritvia automation scorecard",
             "",
             f"Autonomy {s['autonomy']}/100 (target {s['target']}). {s['jobs']} business jobs: "
             f"{s['fully']} run by themselves, {s['runs_by_itself'] - s['fully']} on autopilot with a yes, "
             f"{s['not_in_kritvia']} not in Kritvia yet.", "",
             "| Area | Jobs | Autonomy | Target |", "|---|---|---|---|"]
    lines += [f"| {d['name']} | {d['jobs']} | {d['autonomy']} | {d['target']} |" for d in report["domains"].values()]
    lines += ["", "| Job | Level | Target | Next |", "|---|---|---|---|"]
    lines += [f"| {j['title']} | {j['level']} {j['level_name']} | {j['target']} | {j['next'] or '-'} |"
              for j in report["jobs"]]
    if report["integrity"]:
        lines += ["", "## Integrity problems"] + [f"- {i['workflow']}: {i['problem']}" for i in report["integrity"]]
    return "\n".join(lines) + "\n"
