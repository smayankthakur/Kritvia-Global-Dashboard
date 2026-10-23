"""The agent team: a lead for each role on the board (migration 0056).

Each role (Front desk, Sales, Accounts, Operations) can have a lead with a goal. On its check-in days at
its time, the lead runs the Kritvia assistant as the business's agent with a brief: who it is, its goal,
the agents in its area, and what to do. It looks things up, does up to a few useful things (every send,
booking or change is a draft for a yes, as always), hands work that belongs to another role to that
role's lead (team.handoff), and ends with a short report for the owner.

Guards:
  - a role's monthly token budget covers its agents and its lead; a lead over budget doesn't check in
  - hand-offs: only to a lead that is switched on, at most 2 deep (a lead handed work can hand it on once),
    at most HANDOFFS_PER_DAY a day per business
  - the lead's runs are tickets on the board under its role, so their cost shows there
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text

from kritvia_api.services import automations as au

log = logging.getLogger(__name__)
GOAL = "team_roles.goal"
REPORT = "team_reports.body"
ROLES = ("front_desk", "sales", "accounts", "ops")
TITLES = {"front_desk": "Front desk", "sales": "Sales", "accounts": "Accounts", "ops": "Operations"}
DEFAULT_GOALS = {
    "front_desk": "Every customer message gets a helpful reply within the hour, and every booking is confirmed and reminded.",
    "sales": "Every new enquiry is answered the same day, every quiet lead is followed up, and proposals go out fast.",
    "accounts": "Money owed comes in on time: invoices go out, reminders are polite and timely, and payments are recorded.",
    "ops": "Work gets done on time: tasks have owners and dates, and nothing waits on the team for long.",
}
HANDOFFS_PER_DAY = 20
MAX_DEPTH = 2


def describe(t: dict[str, Any]) -> str:
    days = sorted(t.get("weekdays") or [])
    if days == [0, 1, 2, 3, 4, 5, 6]:
        when = "Every day"
    elif days == [0, 1, 2, 3, 4, 5]:
        when = "Monday to Saturday"
    elif days == [0, 1, 2, 3, 4]:
        when = "Monday to Friday"
    else:
        when = "Every " + ", ".join(au.WEEKDAYS[d] for d in days)
    return f"{when} at {t['at_time']}"


def next_time(t: dict[str, Any], tz, after: datetime) -> datetime:
    return au.next_run("weekly", list(t["weekdays"]), None, t["at_time"], tz, after)


def area(conn_rows: list[Any], role: str) -> list[str]:
    """The agents on the board in this role (switched on)."""
    from kritvia_api.engine.core import registry
    return [registry.get(r.workflow).title for r in conn_rows if r.role == role and r.enabled and r.workflow in registry]


def check_in_request(role: str, goal: str, agents: list[str]) -> str:
    team = ", ".join(f"{TITLES[r]}" for r in ROLES if r != role)
    return (f"You are the {TITLES[role]} lead of this business. Your goal: {goal.strip()[:600]}\n"
            f"The agents in your area: {', '.join(agents) if agents else 'none switched on yet'}.\n"
            "It is your check-in. Do this:\n"
            "1. Look at how your area is doing with the tools (business.numbers, leads.search, invoices.search, "
            "tasks.search, approvals.waiting: whatever fits your goal).\n"
            "2. Do at most 3 useful things towards your goal now (drafts wait for the owner's yes; tasks need an owner "
            "and a date).\n"
            f"3. If something belongs to another lead ({team}), hand it over with team.handoff; don't do their work.\n"
            "4. Finish with a report for the owner: at most 5 short lines, numbers first, then what you did, what "
            "waits for their yes, and anything you need from them. Use the owner's language.")


def handoff_request(from_role: str | None, to_role: str, note: str, goal: str) -> str:
    who = f"The {TITLES[from_role]} lead" if from_role in TITLES else "The owner's assistant"
    return (f"You are the {TITLES[to_role]} lead of this business. Your goal: {goal.strip()[:600]}\n"
            f"{who} handed you this:\n{note.strip()[:1500]}\n\n"
            "Do what it asks if it fits your goal (drafts wait for the owner's yes). Then report in at most 3 short lines "
            "what you did.")


async def load(conn, crypto, venture_id: uuid.UUID, role: str) -> dict[str, Any] | None:
    r = (await conn.execute(text("SELECT * FROM team_roles WHERE venture_id = :v AND role = :r"),
                            {"v": venture_id, "r": role})).first()
    if r is None:
        return None
    t = dict(r._mapping)
    t["goal"] = await crypto.decrypt_str(venture_id, GOAL, r.goal_enc) or DEFAULT_GOALS[role]
    return t


async def over_budget(conn, venture_id: uuid.UUID, t: dict[str, Any], local: list[str]) -> bool:
    if t.get("monthly_tokens") is None:
        return False
    used = (await conn.execute(text("SELECT role_usage(:v, :r, :l)"),
                               {"v": venture_id, "r": t["role"], "l": local})).scalar()
    return int(used or 0) >= int(t["monthly_tokens"])


async def _start(services, venture_id: uuid.UUID, run_as: uuid.UUID, role: str, request: str, *, ref: str,
                 title: str, team: dict[str, Any], actor_type: str = "agent") -> uuid.UUID:
    """One assistant run as the lead. Its board card goes under the lead's role before it is dispatched."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.engine.runner import start_run
    run_id = await start_run(services, actor_user_id=run_as, actor_type=actor_type, venture_id=venture_id,
                             workflow="assistant", input={"request": request[:3990], "team": team},
                             trigger_kind="schedule" if actor_type != "user" else "manual", trigger_ref=ref,
                             title=title[:140], dispatch=False)
    async with tenant_tx(run_as, actor_type, "team" if actor_type != "user" else None) as conn:  # type: ignore[arg-type]
        await conn.execute(text("UPDATE tickets SET role = :r WHERE run_id = :run"), {"r": role, "run": run_id})
    await services.dispatcher.enqueue_run(run_id)
    return run_id


async def check_in(services, venture_id: uuid.UUID, run_as: uuid.UUID, t: dict[str, Any], agents: list[str], *,
                   actor_type: str = "agent") -> uuid.UUID:
    return await _start(services, venture_id, run_as, t["role"], check_in_request(t["role"], t["goal"], agents),
                        ref=f"team:{t['role']}", title=f"{TITLES[t['role']]} lead: check-in",
                        team={"role": t["role"], "depth": 0, "kind": "check_in"}, actor_type=actor_type)


async def fire_due(services, now: datetime | None = None) -> int:
    """Worker, every minute: leads whose check-in time has come."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.quota import PlanRestricted
    from kritvia_api.services.skills import tz_of
    now = now or datetime.now(UTC)
    async with tenant_tx(None, "system") as conn:
        due = (await conn.execute(text("SELECT * FROM private.claim_due_team(:n)"), {"n": now})).all()
    started = 0
    local = services.router.local_deployments()
    for d in due:
        # All of it inside the try, and the next time always set (the claim is a 15-minute lease).
        error, nxt = None, None
        try:
            async with tenant_tx(d.run_as, "agent", "team") as conn:
                role = (await conn.execute(text("SELECT role FROM team_roles WHERE id = :i"), {"i": d.team_role_id})).scalar()
                t = await load(conn, EnvelopeCrypto(conn, services.keys), d.venture_id, role) if role else None
                tz = await tz_of(conn, d.venture_id)
                over = t is not None and await over_budget(conn, d.venture_id, t, local)
                rows = (await conn.execute(text("SELECT * FROM board_roles(:v, :l)"), {"v": d.venture_id, "l": local})).all()
            if t is None or not t["enabled"]:
                continue
            nxt = next_time(t, tz, now)
            if over:
                error = "this role's monthly budget is used up"
            else:
                try:
                    await check_in(services, d.venture_id, d.run_as, t, area(rows, t["role"]))
                    started += 1
                except PlanRestricted as exc:
                    error = str(exc)[:300]
        except Exception as exc:  # noqa: BLE001
            log.exception("team lead %s didn't start", d.team_role_id)
            error = f"didn't start ({type(exc).__name__})"
        finally:
            async with tenant_tx(None, "system") as conn:
                await conn.execute(text("SELECT private.set_team_next(:i, :n, :e)"),
                                   {"i": d.team_role_id, "n": nxt or now + timedelta(minutes=15), "e": error})
    return started


async def handoff(ctx, to_role: str, note: str) -> dict[str, Any]:
    """team.handoff: the current run hands work to another role's lead (a new run, started now)."""
    from kritvia_api.services.crypto import EnvelopeCrypto
    if to_role not in ROLES:
        return {"handed_over": False, "why": f"no such lead; use one of {', '.join(ROLES)}"}
    if len(note.strip()) < 5:
        return {"handed_over": False, "why": "say what the other lead should do"}
    async with ctx.tx() as conn:
        ref = (await conn.execute(text("SELECT trigger_ref FROM workflow_runs WHERE id = :r"), {"r": ctx.run_id})).scalar() or ""
        parts = ref.split(":")
        from_role = parts[1] if len(parts) >= 2 and parts[0] == "team" and parts[1] in ROLES else None
        depth = int(parts[3]) if len(parts) == 4 and parts[2] == "handoff" and parts[3].isdigit() else 0
        if from_role == to_role:
            return {"handed_over": False, "why": "that is your own role"}
        if depth >= MAX_DEPTH:
            return {"handed_over": False, "why": "this work was already handed on twice; do it or report it to the owner"}
        if int((await conn.execute(text("SELECT team_handoffs_today(:v)"), {"v": ctx.venture_id})).scalar() or 0) >= HANDOFFS_PER_DAY:
            return {"handed_over": False, "why": "the team has handed over enough work today; report it to the owner"}
        t = await load(conn, EnvelopeCrypto(conn, ctx.services.keys), ctx.venture_id, to_role)
        if t is None or not t["enabled"]:
            return {"handed_over": False, "why": f"the {TITLES[to_role]} lead isn't switched on; tell the owner instead"}
        if await over_budget(conn, ctx.venture_id, t, ctx.services.router.local_deployments()):
            return {"handed_over": False, "why": f"the {TITLES[to_role]} lead's budget is used up this month"}
    run_id = await _start(ctx.services, ctx.venture_id, ctx.run_as, to_role,
                          handoff_request(from_role, to_role, note, t["goal"]),
                          ref=f"team:{to_role}:handoff:{depth + 1}", title=f"{TITLES[to_role]} lead: hand-off",
                          team={"role": to_role, "depth": depth + 1, "kind": "handoff", "from": from_role or "assistant"})
    return {"handed_over": True, "to": TITLES[to_role], "run_id": str(run_id)}


async def report(ctx, state: dict[str, Any], answer: str) -> None:
    """A lead's check-in (or hand-off) ended: keep the report and tell the person who set up the team."""
    from kritvia_api.services import front_door, push
    team = (state.get("input") or {}).get("team") or {}
    role = team.get("role")
    if role not in ROLES or not answer.strip():
        return
    async with ctx.tx() as conn:
        enc = await ctx.crypto(conn).encrypt(ctx.venture_id, REPORT, answer.strip()[:4000])
        await conn.execute(text("INSERT INTO team_reports (org_id, venture_id, role, run_id, body_enc)"
                                " VALUES (:o, :v, :r, :run, :b)"),
                           {"o": ctx.org_id, "v": ctx.venture_id, "r": role, "run": ctx.run_id, "b": enc})
        who = (await conn.execute(text("SELECT created_by FROM team_roles WHERE venture_id = :v AND role = :r"),
                                  {"v": ctx.venture_id, "r": role})).scalar()
        chats = (await conn.execute(text("SELECT channel, external_id FROM approver_links WHERE venture_id = :v"
                                         " AND user_id = :u AND channel IN ('telegram', 'whatsapp') ORDER BY channel"),
                                    {"v": ctx.venture_id, "u": who})).all() if who else []
    title = f"{TITLES[role]} lead: {'check-in' if team.get('kind') == 'check_in' else 'hand-off done'}"
    await push.notify_venture(ctx.venture_id, title=title, body=answer.strip()[:120],
                              url=f"/v/{ctx.venture_id}/board", tag=f"team-{role}")
    if chats and team.get("kind") == "check_in":
        c = chats[0]
        await front_door.reply(ctx.venture_id, {"channel": c.channel, "chat": c.external_id, "user": str(who)},
                               f"{title}\n\n{answer.strip()[:3500]}")
