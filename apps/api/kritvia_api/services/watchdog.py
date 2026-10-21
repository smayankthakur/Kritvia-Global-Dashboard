"""Always on: the in-app half of keeping Kritvia working 24x7 (the server's watchdog, infra/scripts/healthcheck.sh,
and the outside monitor, infra/cloudflare/uptime-worker.js, are the other two).

  heartbeat(name)   each worker writes one every 30 s (system_heartbeats); /livez shows their ages and the
                    server's watchdog restarts a worker whose heartbeat is older than 3 minutes
  check()           every minute in the worker: re-dispatches runs that should be running, and tells Kritvia's
                    team (STAFF_EMAILS, else the founder) when something keeps failing:
                      backlog     runs waiting more than 10 minutes to start
                      stuck       runs whose worker vanished more than 5 minutes ago
                      failures    10+ runs failed in 15 minutes (after their automatic retries)
                      ai          half or more of 5+ AI calls failed in 15 minutes
                      priority    the priority worker's heartbeat is more than 3 minutes old
                      spend       AI cost in the last 24 hours passed AI_DAILY_SPEND_ALERT_USD (checked every
                                  15 minutes; AI_PAUSED=true in .env is the kill switch)
                    each at most once an hour while it lasts, and once when it recovers
Runs that fail for a passing reason are retried by themselves (engine/runner.passing, 2 / 10 / 60 minutes).
Counts only: no business data is read or sent.
"""
from __future__ import annotations

import json
import logging

from sqlalchemy import text

log = logging.getLogger("kritvia.watchdog")

STALE_S = 180
WORDS = {"backlog": "Runs are waiting to start", "stuck": "Runs lost their worker",
         "failures": "Many runs are failing", "ai": "AI calls are failing", "priority": "The priority worker stopped",
         "spend": "AI spending is high"}


async def heartbeat(name: str, worker_id: str, info: dict | None = None) -> None:
    from kritvia_api.db.session import tenant_tx
    async with tenant_tx(None, "system") as conn:
        await conn.execute(text("SELECT private.heartbeat(:n, :w, CAST(:i AS jsonb))"),
                           {"n": name, "w": worker_id[:120], "i": json.dumps(info or {})})


async def status(conn) -> dict:
    """What /livez shows: heartbeat ages and queue counts."""
    ages = {r.name: r.age_s for r in (await conn.execute(text("SELECT * FROM heartbeat_ages()"))).all()}
    s = (await conn.execute(text("SELECT * FROM watchdog_stats()"))).first()
    worker = ages.get("worker")
    return {"worker_age_s": worker, "priority_age_s": ages.get("worker-priority"),
            "queued": s.queued, "oldest_queued_s": s.oldest_queued_s, "stuck": s.stuck, "retrying": s.retrying,
            "failed_15m": s.failed_15m, "ai_calls_15m": s.ai_calls_15m, "ai_failed_15m": s.ai_failed_15m,
            "ok": worker is not None and worker < STALE_S and s.oldest_queued_s < 600 and s.stuck == 0}


def problems(st: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    if st["oldest_queued_s"] >= 600:
        out["backlog"] = f"{st['queued']} run(s) waiting; the oldest for {st['oldest_queued_s'] // 60} minutes"
    if st["stuck"]:
        out["stuck"] = f"{st['stuck']} run(s) lost their worker more than 5 minutes ago"
    if st["failed_15m"] >= 10:
        out["failures"] = f"{st['failed_15m']} runs failed in the last 15 minutes (after automatic retries)"
    if st["ai_calls_15m"] >= 5 and st["ai_failed_15m"] * 2 >= st["ai_calls_15m"]:
        out["ai"] = f"{st['ai_failed_15m']} of {st['ai_calls_15m']} AI calls failed in the last 15 minutes"
    if st["priority_age_s"] is not None and st["priority_age_s"] >= STALE_S:
        out["priority"] = f"the priority worker's last heartbeat was {st['priority_age_s'] // 60} minutes ago"
    return out


def _team() -> list[str]:
    from kritvia_api.config import FOUNDER_EMAIL, get_settings
    raw = get_settings().staff_emails.strip() or FOUNDER_EMAIL
    return [e.strip() for e in raw.split(",") if e.strip()][:5]


async def check(services, spend_check: bool = False) -> dict[str, str]:
    """One watchdog pass; returns the problems found. AI spend is looked at every 15 minutes (or when
    spend_check)."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.engine.runner import sweep
    from kritvia_api.services.mailer import get_mailer
    async with tenant_tx(None, "system") as conn:
        st = await status(conn)
    found = problems(st)
    from datetime import UTC, datetime
    from kritvia_api.config import get_settings
    limit = get_settings().ai_daily_spend_alert_usd
    if limit > 0 and (spend_check or datetime.now(UTC).minute % 15 == 0):
        async with tenant_tx(None, "system") as conn:
            sp = (await conn.execute(text("SELECT * FROM private.ai_spend_24h()"))).first()
        if sp is not None and float(sp.cost_usd) >= limit:
            found["spend"] = (f"${float(sp.cost_usd):.2f} on AI in the last 24 hours ({sp.calls} calls), over the "
                              f"${limit:.2f} alert. To stop all AI at once: AI_PAUSED=true in .env, then restart api and worker.")
    elif limit > 0:
        # between spend checks, keep an open spend alert open (don't report it recovered every minute)
        async with tenant_tx(None, "system") as conn:
            still = (await conn.execute(text("SELECT private.platform_alert_open('spend')"))).scalar()
        if still:
            found["spend"] = "still over the AI spending alert"
    if found.keys() & {"backlog", "stuck"}:
        try:
            n = await sweep(services, limit=200)        # heal first: put them back on the queue
            log.warning("watchdog re-dispatched %d run(s)", n)
        except Exception:  # noqa: BLE001
            log.exception("watchdog sweep failed")
    send: list[tuple[str, str]] = []
    async with tenant_tx(None, "system") as conn:
        for key, detail in found.items():
            if (await conn.execute(text("SELECT private.platform_alert(:k, :d, 60)"), {"k": key, "d": detail})).scalar():
                send.append((f"Kritvia: {WORDS[key]}", detail))
        resolved = (await conn.execute(text("SELECT * FROM private.platform_alerts_resolve(:o)"),
                                       {"o": list(found)})).scalars().all()
    for key in resolved:
        send.append((f"Kritvia recovered: {WORDS.get(key, key)}", "Back to normal."))
    for subject, body in send:
        log.warning("%s: %s", subject, body)
        for to in _team():
            try:
                await get_mailer().send(to, subject, body + "\n\nFrom Kritvia's watchdog (counts only).")
            except Exception:  # noqa: BLE001 - mail down: the server's watchdog and the outside monitor still alert
                log.exception("watchdog email failed")
    return found
