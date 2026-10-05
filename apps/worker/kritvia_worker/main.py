"""Kritvia worker (arq on Valkey).

Jobs
  execute_run(run_id)     advance one workflow run (enqueued by API, sweeper, approvals)
Cron (IST)
  every minute            fire_schedules   start workflows whose configured HH:MM is now (kitchen 23:30)
                          sweep            re-dispatch queued runs and runs with expired leases
                          expire_approvals expire overdue drafts and wake their runs
  every 5 minutes         poll_gmail       new inquiries, aggregator reports, emailed loan documents
  every 15 minutes        reembed          embed chunks whose embedding was deferred (Ollama down)
  03:15 daily             purge_expired    retention: delete documents past their deadline
  06:30 daily             morning_check    alert (audit + log) if a scheduled plan is missing or failed

A failing job never takes the worker down; failures are logged, visible in the
run timeline, and retried by the sweeper where safe.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import text

from kritvia_api.db.session import dispose_engine, tenant_tx
from kritvia_api.engine.bootstrap import build_services
from kritvia_api.engine.context import set_services
from kritvia_api.engine.runner import DuplicateTrigger, advance_run, start_run, sweep as sweep_runs
from kritvia_api.services.quota import PlanRestricted

IST = timezone(timedelta(hours=5, minutes=30))
log = logging.getLogger("kritvia.worker")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")


async def startup(ctx: dict) -> None:
    services = build_services(dispatch_mode="arq")
    set_services(services)
    ctx["services"] = services
    log.info("worker %s started", services.worker_id)


async def shutdown(ctx: dict) -> None:
    svc = ctx.get("services")
    if svc is not None:
        await svc.router.aclose()
        close = getattr(svc.dispatcher, "close", None)
        if close:
            await close()
    await dispose_engine()


async def execute_run(ctx: dict, run_id: str) -> str | None:
    import uuid
    return await advance_run(ctx["services"], uuid.UUID(run_id))


async def fire_schedules(ctx: dict, now: datetime | None = None) -> int:
    """Start every enabled workflow whose schedule (HH:MM IST) is this minute.
    Idempotent per day: the trigger key is workflow + date, so a restarted worker
    that fires twice in the same minute starts one run."""
    now = (now or datetime.now(IST)).astimezone(IST)
    hhmm = now.strftime("%H:%M")
    async with tenant_tx(None, "system") as conn:
        due = (await conn.execute(text("SELECT * FROM private.scheduled_workflows(:t)"), {"t": hhmm})).all()
    started = 0
    for d in due:
        inp = {}
        if d.workflow == "kitchen_daily":
            inp["target_date"] = (now.date() + timedelta(days=1)).isoformat()
        try:
            await start_run(ctx["services"], actor_user_id=d.run_as, actor_type="agent", venture_id=d.venture_id,
                            workflow=d.workflow, input=inp, trigger_kind="schedule",
                            dedupe=("schedule", f"{d.workflow}:{now.date().isoformat()}:{hhmm}"),
                            title=f"Scheduled {hhmm} IST")
            started += 1
        except DuplicateTrigger:
            continue
        except PlanRestricted:
            continue   # the plan doesn't include it (or the free trial has ended): skip quietly
        except Exception:
            log.exception("could not start scheduled %s for %s", d.workflow, d.venture_id)
    return started


async def sweep(ctx: dict) -> int:
    return await sweep_runs(ctx["services"])


async def expire_approvals(ctx: dict) -> int:
    async with tenant_tx(None, "system") as conn:
        n = (await conn.execute(text("SELECT private.expire_approvals()"))).scalar()
    if n:
        await sweep_runs(ctx["services"])
    return n or 0


async def poll_gmail(ctx: dict) -> dict:
    from kritvia_api.services.pollers import poll_gmail_all
    return await poll_gmail_all(ctx["services"])


async def reembed(ctx: dict) -> int:
    import uuid

    from kritvia_api.engine.context import RunContext
    from kritvia_api.services.memory import reembed_pending

    svc = ctx["services"]
    async with tenant_tx(None, "system") as conn:
        ventures = (await conn.execute(text("SELECT * FROM private.ventures_with_pending_embeddings()"))).all()
    total = 0
    for v in ventures:
        rc = RunContext(run_id=uuid.uuid4(), org_id=v.org_id, venture_id=v.venture_id, run_as=v.run_as,
                        workflow="reembed", services=svc, agent="ingestion")
        try:
            total += await reembed_pending(rc)
        except Exception as exc:
            log.warning("reembed deferred for %s: %s", v.venture_id, exc)
    return total


async def purge_expired(ctx: dict) -> int:
    async with tenant_tx(None, "system") as conn:
        n = (await conn.execute(text("SELECT private.purge_expired_documents(1000)"))).scalar()
        orgs = (await conn.execute(text("SELECT private.purge_closed_orgs(30)"))).scalar()
        ventures = (await conn.execute(text("SELECT private.purge_removed_ventures(30)"))).scalar()
        support = (await conn.execute(text("SELECT private.purge_support(730)"))).scalar()
        privacy = (await conn.execute(text("SELECT private.purge_privacy_requests(1095)"))).scalar()
    log.info("retention purge removed %s document(s), %s closed organisation(s), %s removed business(es),"
             " %s old support message(s) and %s closed privacy request(s)", n, orgs, ventures, support, privacy)
    return n or 0


async def morning_check(ctx: dict) -> list[str]:
    """The overnight kitchen plan must exist before the manager starts the day."""
    today = datetime.now(IST).date()
    async with tenant_tx(None, "system") as conn:
        problems = (await conn.execute(text("SELECT * FROM private.overnight_plan_problems(:d)"), {"d": today})).all()
    msgs = []
    for p in problems:
        msg = f"venture {p.venture_id}: {p.workflow} for {today} is {p.state}"
        log.error("MORNING CHECK: %s", msg)
        async with tenant_tx(p.run_as, "agent", "monitor") as conn:
            await conn.execute(text("SELECT audit_event(:o, :v, 'alert.overnight_plan', 'workflow_runs', NULL,"
                                    " CAST(:d AS jsonb))"),
                               {"o": p.org_id, "v": p.venture_id,
                                "d": f'{{"state": "{p.state}", "date": "{today}"}}'})
        msgs.append(msg)
    return msgs


def _every(minutes: int) -> set[int]:
    return set(range(0, 60, minutes))


class WorkerSettings:
    functions = [execute_run]
    cron_jobs = [
        cron(fire_schedules, second=5, run_at_startup=False),
        cron(sweep, second=35),
        cron(expire_approvals, second=50),
        cron(poll_gmail, minute=_every(5), second=20),
        cron(reembed, minute=_every(15), second=40),
        cron(purge_expired, hour={3}, minute={15}),
        cron(morning_check, hour={6}, minute={30}),
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    timezone = IST
    max_jobs = int(os.environ.get("WORKER_MAX_JOBS", "8"))
    job_timeout = 1800
    keep_result = 0          # lets the same run be re-enqueued as soon as a job finishes
    allow_abort_jobs = True
