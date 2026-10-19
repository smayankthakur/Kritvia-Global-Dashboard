"""What a business's automation actually did: which agents can run, which are on but can't, what they did
in the last days, and how much went out without a person.

Read-only, in the asking person's own (RLS) transaction. Nothing is started, sent or changed.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text

from kritvia_api.engine.core import registry

# Where an event agent's work comes from: any one of these connected is enough.
SOURCES: dict[str, set[str]] = {
    "inbox_assistant": {"google", "whatsapp", "telegram", "email_in"},
    "lead_triage": {"google", "webhook", "whatsapp", "telegram", "email_in", "indiamart"},
}
# Event agents fed by uploads, records or their own settings in Kritvia: always have a source.
ALWAYS_FED = {"loan_verification", "meeting_digest", "automation", "custom"}
# Run outcomes that mean the agent ran but has nothing to work with until someone sets it up.
NOT_SET_UP = {
    "no_template": "choose a WhatsApp template in its settings",
    "no_reference_data": "add menu, recipes and stock on the Kitchen page (or switch it off if this isn't a kitchen)",
    "not_set_up": "finish its setup (for reviews: choose the Google Maps listing)",
    "places_not_set_up": "add a Google Places key",
}
# Outcomes where the agent did its part and the next step is a person's.
WAITING_ON_A_PERSON = {
    "whatsapp_ready": "first WhatsApp message(s) wait in Leads for one tap from your phone (WhatsApp only allows "
                      "a business to message someone first from its own phone)",
}


async def health(conn, venture_id: uuid.UUID, *, days: int = 30, now: datetime | None = None) -> dict[str, Any]:
    from kritvia_api.services.quota import plan_for_venture
    now = now or datetime.now(UTC)
    since = now - timedelta(days=days)
    p = {"v": venture_id, "s": since}
    kind = (await conn.execute(text("SELECT coalesce(kind, 'general') FROM venture_settings WHERE venture_id = :v"),
                               p)).scalar() or "general"
    plan = await plan_for_venture(conn, venture_id)
    configs = {r.workflow: r for r in (await conn.execute(text(
        "SELECT workflow, enabled, schedule FROM workflow_configs WHERE venture_id = :v"), p)).all()}
    sources = {r.provider for r in (await conn.execute(text(
        "SELECT DISTINCT provider FROM connectors WHERE venture_id = :v AND status = 'active'"), p)).all()}
    runs = {r.workflow: r for r in (await conn.execute(text(
        "SELECT workflow, count(*) AS n, count(*) FILTER (WHERE status = 'completed') AS completed,"
        " count(*) FILTER (WHERE status = 'failed') AS failed,"
        " count(*) FILTER (WHERE status IN ('queued', 'running', 'waiting')) AS open,"
        " count(*) FILTER (WHERE started_by IS NULL) AS by_itself, max(created_at) AS last_at,"
        " (array_agg(left(error, 160) ORDER BY created_at DESC) FILTER (WHERE status = 'failed'))[1] AS last_error"
        " FROM workflow_runs WHERE venture_id = :v AND created_at >= :s GROUP BY workflow"), p)).all()}
    outcomes: dict[str, dict[str, int]] = {}
    for r in (await conn.execute(text(
            "SELECT workflow, coalesce(outcome, status) AS outcome, count(*) AS n FROM workflow_runs"
            " WHERE venture_id = :v AND created_at >= :s GROUP BY 1, 2"), p)).all():
        outcomes.setdefault(r.workflow, {})[r.outcome] = int(r.n)
    drafts = {r.workflow: r for r in (await conn.execute(text(
        "SELECT r.workflow, count(*) AS n,"
        " count(*) FILTER (WHERE a.status = 'pending') AS waiting,"
        " count(*) FILTER (WHERE a.status = 'approved') AS approved,"
        " count(*) FILTER (WHERE a.status = 'edited') AS edited,"
        " count(*) FILTER (WHERE a.status = 'rejected') AS rejected,"
        " count(*) FILTER (WHERE a.status = 'auto_approved') AS by_itself,"
        " count(*) FILTER (WHERE a.status = 'expired') AS expired,"
        " count(*) FILTER (WHERE a.executed_at IS NOT NULL) AS done"
        " FROM approvals a JOIN workflow_runs r ON r.id = a.run_id"
        " WHERE a.venture_id = :v AND a.created_at >= :s GROUP BY r.workflow"), p)).all()}
    trusted = {(r.agent, r.action) for r in (await conn.execute(text(
        "SELECT agent, action FROM agent_trust WHERE venture_id = :v AND auto_run"), p)).all()}
    calls = (await conn.execute(text(
        "SELECT count(*) FILTER (WHERE direction = 'inbound' AND NOT test) AS answered,"
        " count(*) FILTER (WHERE direction = 'outbound' AND NOT test) AS made"
        " FROM calls WHERE venture_id = :v AND started_at >= :s"), p)).first()
    extras = (await conn.execute(text(
        "SELECT (SELECT count(*) FROM automations WHERE venture_id = :v AND enabled) AS automations,"
        " (SELECT count(*) FROM automations WHERE venture_id = :v AND enabled AND last_error IS NOT NULL) AS automations_failing,"
        " (SELECT count(*) FROM custom_workflows WHERE venture_id = :v AND enabled) AS custom,"
        " (SELECT count(*) FROM skills WHERE venture_id = :v AND enabled AND trigger <> 'manual') AS skills"), p)).first()

    agents: list[dict[str, Any]] = []
    findings: list[dict[str, str]] = []
    for wf in registry.all():
        cfg = configs.get(wf.name)
        on = bool(cfg and cfg.enabled)
        if not plan.allows_agent(wf.name, kind):
            state = "not_on_plan"
        elif not on:
            state = "off"
        elif wf.starts == "clock" and not cfg.schedule:
            state = "on_no_time"
            findings.append({"agent": wf.name, "level": "fix",
                             "text": f"{wf.title} is on but has no time set, so it never runs. Set a time "
                                     f"(usually {wf.default_schedule}) on the Agents page."})
        elif wf.name in SOURCES and not (SOURCES[wf.name] & sources):
            state = "on_no_source"
            findings.append({"agent": wf.name, "level": "fix",
                             "text": f"{wf.title} is on but nothing feeds it: connect Gmail, WhatsApp, Telegram or "
                                     "email forwarding."})
        else:
            state = "ready"
        r, d = runs.get(wf.name), drafts.get(wf.name)
        row = {
            "workflow": wf.name, "title": wf.title, "starts": wf.starts, "state": state,
            "schedule": cfg.schedule if cfg else None,
            "runs": int(r.n) if r else 0, "completed": int(r.completed) if r else 0,
            "failed": int(r.failed) if r else 0, "open": int(r.open) if r else 0,
            "started_by_itself": int(r.by_itself) if r else 0,
            "last_run_at": r.last_at.isoformat() if r and r.last_at else None,
            "last_error": r.last_error if r else None,
            "drafts": int(d.n) if d else 0, "waiting": int(d.waiting) if d else 0,
            "approved": int(d.approved) if d else 0, "edited": int(d.edited) if d else 0,
            "rejected": int(d.rejected) if d else 0, "sent_by_itself": int(d.by_itself) if d else 0,
            "expired": int(d.expired) if d else 0, "carried_out": int(d.done) if d else 0,
            "trusted_actions": sorted(a for (agent, a) in trusted if agent in {wf.name, *wf_agents(wf)}),
            "outcomes": dict(sorted(outcomes.get(wf.name, {}).items(), key=lambda kv: -kv[1])[:6]),
        }
        agents.append(row)
        if state == "ready" and wf.starts == "clock" and row["runs"] == 0 and days >= 2:
            findings.append({"agent": wf.name, "level": "check",
                             "text": f"{wf.title} is ready but hasn't run in {days} days."})
        for oc, fix in NOT_SET_UP.items():
            if row["outcomes"].get(oc) and state == "ready":
                findings.append({"agent": wf.name, "level": "fix",
                                 "text": f"{wf.title} ran {row['outcomes'][oc]} time(s) with nothing to work with: {fix}."})
        for oc, why in WAITING_ON_A_PERSON.items():
            if row["outcomes"].get(oc):
                findings.append({"agent": wf.name, "level": "check", "text": f"{wf.title}: {row['outcomes'][oc]} {why}."})
        if row["failed"]:
            findings.append({"agent": wf.name, "level": "fix",
                             "text": f"{wf.title}: {row['failed']} run(s) failed"
                                     + (f" (last: {row['last_error']})" if row["last_error"] else "") + "."})
        if row["expired"]:
            findings.append({"agent": wf.name, "level": "check",
                             "text": f"{wf.title}: {row['expired']} draft(s) expired waiting for a yes, so they "
                                     "never went out. Approve from your phone, or let this agent send routine "
                                     "messages by itself."})
        if row["drafts"] >= 10 and not row["sent_by_itself"] and not row["edited"] and not row["rejected"]:
            findings.append({"agent": wf.name, "level": "idea",
                             "text": f"{wf.title}: every one of {row['drafts']} drafts was approved unchanged. "
                                     "It may be ready to send routine messages without asking (Trust page)."})

    decided = sum(a["approved"] + a["edited"] + a["rejected"] + a["sent_by_itself"] for a in agents)
    total_runs = sum(a["runs"] for a in agents)
    return {
        "venture_id": str(venture_id), "days": days, "plan": plan.code, "kind": kind,
        "connected": sorted(sources),
        "summary": {
            "agents_ready": sum(a["state"] == "ready" for a in agents),
            "agents_on_but_stuck": sum(a["state"] in ("on_no_time", "on_no_source") for a in agents),
            "runs": total_runs,
            "runs_started_by_itself": sum(a["started_by_itself"] for a in agents),
            "drafts": sum(a["drafts"] for a in agents),
            "sent_by_itself": sum(a["sent_by_itself"] for a in agents),
            "approved_by_a_person": sum(a["approved"] + a["edited"] for a in agents),
            "expired": sum(a["expired"] for a in agents),
            "share_sent_by_itself": round(100 * sum(a["sent_by_itself"] for a in agents) / decided) if decided else None,
            "calls_answered": int(calls.answered or 0), "calls_made": int(calls.made or 0),
            "automations": int(extras.automations), "automations_failing": int(extras.automations_failing),
            "custom_workflows": int(extras.custom), "skills_running_by_themselves": int(extras.skills),
        },
        "agents": agents,
        "findings": findings,
    }


def wf_agents(wf) -> set[str]:
    """Approval agents a workflow's drafts are filed under (step agents, e.g. 'proposal', 'scheduler')."""
    return {s.agent for s in wf.steps.values()}
