"""Kritvia worker (arq on Valkey).

Jobs
  execute_run(run_id)     advance one workflow run (enqueued by API, sweeper, approvals)
Cron (IST)
  every minute            fire_schedules   start workflows whose configured HH:MM is now (kitchen 23:30)
                          sweep            re-dispatch queued runs and runs with expired leases
                          expire_approvals expire overdue drafts and wake their runs
                          fire_automations automations made in plain words whose time has come,
                                           custom workflows' daily checks, and skills (scheduled
                                           ones, and event skills' daily checks)
  every 5 minutes         poll_gmail       new inquiries, aggregator reports, emailed loan documents
  every 10 minutes        poll_indiamart   new IndiaMART enquiries -> Lead triage (IndiaMART allows a call
                                           every 5 minutes)
  every 15 minutes        reembed          embed chunks whose embedding was deferred (Ollama down)
  daily (DAILY, IST)      daily_jobs       each once a day after its time, caught up the same day if the
                                           worker was busy or down then; claimed in the database:
    03:15                 purge_expired    retention: documents past their deadline, old runs, usage rows
    06:30                 morning_check    alert (audit + log) if a scheduled plan is missing or failed
    08:40                 self_check       tell each business's owners what is stuck in their automation
  every 30 minutes        nudge_expiring   tell owners about drafts that expire within the next hours
  hourly (:17)            sync_app_store   the official MCP Registry into the App store

Priority worker (PriorityWorkerSettings, service `worker-priority`): runs only the runs of plans with
priority processing (Scale, Enterprise), from their own queue, and keeps a heartbeat in Valkey so the
API knows it is there (engine/dispatch.py). No cron jobs: those stay on the main worker.

A failing job never takes the worker down; failures are logged, visible in the
run timeline, and retried by the sweeper where safe. Runs and scheduled jobs don't compete for slots
(RUN_SLOTS), and the heartbeat comes from its own task, not a job.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

from arq import cron
from arq.connections import RedisSettings
from sqlalchemy import text

from kritvia_api.db.session import dispose_engine, tenant_tx
from kritvia_api.engine.bootstrap import build_services
from kritvia_api.engine.context import set_services
from kritvia_api.engine.dispatch import PRIORITY_HEARTBEAT, PRIORITY_QUEUE
from kritvia_api.engine.runner import DuplicateTrigger, advance_run, resume_budget_paused, start_run, sweep as sweep_runs
from kritvia_api.services.quota import PlanRestricted

IST = timezone(timedelta(hours=5, minutes=30))
log = logging.getLogger("kritvia.worker")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")


# How many workflow runs one worker executes at once. arq's own job limit is this plus room for the
# scheduled jobs, and a run that finds every run slot taken returns at once (it stays queued; the sweeper
# brings it back within a minute) instead of holding a job slot: so scheduled jobs (the schedules, the
# sweeper, approvals expiring, the daily jobs) never wait behind long runs.
RUN_SLOTS = int(os.environ.get("WORKER_MAX_RUNS") or os.environ.get("WORKER_MAX_JOBS") or "8")
CRON_SLOTS = 6
_runs: asyncio.Semaphore | None = None
HEARTBEAT_EVERY = 30


def _run_slots() -> asyncio.Semaphore:
    global _runs
    if _runs is None:
        _runs = asyncio.Semaphore(RUN_SLOTS)
    return _runs


async def _beat_forever(ctx: dict, beat) -> None:
    """The worker's heartbeat, from its own task rather than an arq job, so a worker busy with long runs
    still reports it is alive (the server's watchdog restarts a worker whose heartbeat stops)."""
    while True:
        try:
            await beat(ctx)
        except Exception:  # noqa: BLE001 - try again next time
            log.warning("heartbeat failed", exc_info=True)
        await asyncio.sleep(HEARTBEAT_EVERY)


async def startup(ctx: dict) -> None:
    services = build_services(dispatch_mode="arq")
    set_services(services)
    ctx["services"] = services
    from kritvia_api import logredact
    logredact.install()
    ctx["heartbeat_task"] = asyncio.get_running_loop().create_task(_beat_forever(ctx, heartbeat))
    log.info("worker %s started (%d run slots)", services.worker_id, RUN_SLOTS)


async def shutdown(ctx: dict) -> None:
    task = ctx.pop("heartbeat_task", None)
    if task is not None:
        task.cancel()
    svc = ctx.get("services")
    if svc is not None:
        await svc.router.aclose()
        close = getattr(svc.dispatcher, "close", None)
        if close:
            await close()
    await dispose_engine()


async def execute_run(ctx: dict, run_id: str) -> str | None:
    import uuid
    slots = _run_slots()
    if slots.locked():
        return "busy"          # stays queued; the sweeper hands it out again when a slot is free
    async with slots:
        return await advance_run(ctx["services"], uuid.UUID(run_id))


def _scheduled_minute(ctx: dict) -> datetime | None:
    """The minute this cron job was due (arq's score), not when it got a slot."""
    score = ctx.get("score") if isinstance(ctx, dict) else None
    if not score:
        return None
    return datetime.fromtimestamp(score / 1000, IST).replace(second=0, microsecond=0)


async def fire_schedules(ctx: dict, now: datetime | None = None) -> int:
    """Start every enabled workflow whose schedule (HH:MM IST) has come. Uses the minute the job was due,
    and catches up on minutes missed while the worker was busy or restarting (up to 30, remembered in
    Valkey). Idempotent: the trigger key is workflow + date + HH:MM, so a minute fired twice starts one run."""
    if now is not None:
        return await _fire_minute(ctx, now.astimezone(IST))
    due = _scheduled_minute(ctx) or datetime.now(IST).replace(second=0, microsecond=0)
    minutes = [due]
    redis = ctx.get("redis")
    key = "kritvia:fire_schedules:last"
    if redis is not None:
        try:
            last = await redis.get(key)
            if last:
                prev = datetime.fromisoformat(last.decode() if isinstance(last, bytes) else last).astimezone(IST)
                gap = int((due - prev).total_seconds() // 60)
                if 1 < gap <= 30:
                    minutes = [prev + timedelta(minutes=i) for i in range(1, gap + 1)]
        except Exception:  # noqa: BLE001 - without the marker, just this minute
            log.warning("could not read the schedule marker", exc_info=True)
    started = 0
    for m in minutes:
        started += await _fire_minute(ctx, m)
    if redis is not None:
        try:
            await redis.set(key, due.isoformat(), ex=86400)
        except Exception:  # noqa: BLE001
            pass
    return started


async def _fire_minute(ctx: dict, now: datetime) -> int:
    hhmm = now.strftime("%H:%M")
    async with tenant_tx(None, "system") as conn:
        due = (await conn.execute(text("SELECT * FROM private.scheduled_workflows(:t)"), {"t": hhmm})).all()
    started = 0
    from kritvia_api.engine.core import registry
    for d in due:
        if d.workflow in registry and registry.get(d.workflow).starts != "clock":
            continue   # it starts on messages, uploads or requests: a clock run would start empty and fail
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


async def fire_automations(ctx: dict) -> int:
    """Automations made in plain words ("every Monday send me last week's sales") whose time has come."""
    from kritvia_api.services import custom_workflows
    from kritvia_api.services.automations import fire_due
    n = await fire_due(ctx["services"])
    try:
        n += await custom_workflows.fire_due(ctx["services"])     # custom workflows' daily checks (Scale+)
    except Exception:  # noqa: BLE001
        log.exception("custom workflows didn't start")
    try:
        from kritvia_api.services import skills
        n += await skills.fire_due(ctx["services"])              # skills on a schedule, and event skills' checks
    except Exception:  # noqa: BLE001
        log.exception("skills didn't start")
    try:
        from kritvia_api.services import team
        n += await team.fire_due(ctx["services"])                # team leads' check-ins
    except Exception:  # noqa: BLE001
        log.exception("team check-ins didn't start")
    return n


async def self_check(ctx: dict) -> int:
    """Kritvia checks its own agents every morning and tells the owner what is stuck (services/self_check.py)."""
    from kritvia_api.services import self_check as sc
    return await sc.morning(ctx["services"])


async def nudge_expiring(ctx: dict) -> int:
    """Drafts that would expire unseen: one message per business, the cards again in Telegram."""
    from kritvia_api.services import self_check as sc
    return await sc.nudge(ctx["services"])


async def bills_due(ctx: dict) -> int:
    """Supplier bills due within 3 days or overdue: the owners are told once a day (services/money_watch.py)."""
    from kritvia_api.services import money_watch
    return await money_watch.bills_due(ctx["services"])


async def gstr1_ready(ctx: dict) -> int:
    """On the 3rd: last month's GSTR-1 is ready to download."""
    from kritvia_api.services import money_watch
    return await money_watch.gstr1_ready(ctx["services"])


async def cash_week(ctx: dict) -> int:
    """Mondays 09:05 IST: the cash position for the next 30/60/90 days to each business's owners and admins."""
    from kritvia_api.services import cash
    return await cash.cash_week(ctx["services"])


async def dispatch_events(ctx: dict) -> int:
    """The business event stream: skills that start right after an event, and "tell me when" alerts."""
    from kritvia_api.services import events
    return (await events.dispatch(ctx["services"]))["events"]


async def attendance_check(ctx: dict) -> int:
    """At 12:05 IST: who hasn't checked in yet (services/people.py)."""
    from kritvia_api.services import people
    return await people.missing_today(ctx["services"])


async def purge_candidates(ctx: dict) -> int:
    """CVs are deleted 180 days after their role closes."""
    from sqlalchemy import text

    from kritvia_api.db.session import tenant_tx
    async with tenant_tx(None, "system") as conn:
        return int((await conn.execute(text("SELECT private.purge_old_candidates()"))).scalar() or 0)


async def sweep(ctx: dict) -> int:
    return await sweep_runs(ctx["services"])


async def expire_approvals(ctx: dict) -> int:
    async with tenant_tx(None, "system") as conn:
        n = (await conn.execute(text("SELECT private.expire_approvals()"))).scalar()
    if n:
        await sweep_runs(ctx["services"])
    return n or 0


async def resume_paused(ctx: dict) -> int:
    """Runs parked by an agent's monthly budget resume once there is budget again (raised, cleared,
    or a new month)."""
    return len(await resume_budget_paused(ctx["services"]))


async def poll_gmail(ctx: dict) -> dict:
    from kritvia_api.services.pollers import poll_gmail_all
    return await poll_gmail_all(ctx["services"])


async def poll_indiamart(ctx: dict) -> int:
    from kritvia_api.services.indiamart import pull_all
    return await pull_all(ctx["services"])


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


# Nightly retention: (label, SQL). Each in its own transaction, so one that fails (and is logged) never
# rolls back the others.
PURGES = (
    ("expired documents", "SELECT private.purge_expired_documents(1000)"),
    ("closed organisations", "SELECT private.purge_closed_orgs(30)"),
    ("removed businesses", "SELECT private.purge_removed_ventures(30)"),
    ("old support messages", "SELECT private.purge_support(730)"),
    ("closed privacy requests", "SELECT private.purge_privacy_requests(1095)"),
    ("security events over a year old", "SELECT private.purge_security_events(365)"),
    # Finished runs (with their steps, cards and board tickets) after 180 days, AI usage rows after 400
    # days (a full year of monthly usage stays), start records of old messages after 180 days.
    ("old finished runs", "SELECT private.purge_run_history(180, 5000)"),
    ("old AI usage rows", "SELECT private.purge_model_calls(400, 20000)"),
    ("old trigger records", "SELECT private.purge_trigger_events(180, 20000)"),
    ("expired idempotency keys", "SELECT private.purge_idempotency_keys()"),
)


async def purge_expired(ctx: dict) -> int:
    removed: dict[str, int] = {}
    for label, sql in PURGES:
        try:
            async with tenant_tx(None, "system") as conn:
                removed[label] = int((await conn.execute(text(sql))).scalar() or 0)
        except Exception:  # noqa: BLE001 - the next purge still runs
            log.exception("retention purge failed: %s", label)
    log.info("retention purge removed: %s", ", ".join(f"{n} {label}" for label, n in removed.items()) or "nothing")
    return removed.get("expired documents", 0)


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


# Daily jobs (IST): (name, function, hour, minute, weekday 0=Monday or None, day of month or None). They
# run from daily_jobs once their time has passed and they haven't run that day: a worker that was busy or
# down at that minute catches up later the same day, and two workers never both run one (the day is
# claimed in the database).
DAILY = (
    ("purge_expired", "purge_expired", 3, 15, None, None),
    ("purge_candidates", "purge_candidates", 3, 35, None, None),
    ("morning_check", "morning_check", 6, 30, None, None),
    ("self_check", "self_check", 8, 40, None, None),
    ("cash_week", "cash_week", 9, 5, 0, None),
    ("bills_due", "bills_due", 9, 15, None, None),
    ("gstr1_ready", "gstr1_ready", 9, 25, None, 3),
    ("attendance_check", "attendance_check", 12, 5, None, None),
)


async def daily_jobs(ctx: dict, now: datetime | None = None) -> list[str]:
    now = (now or datetime.now(IST)).astimezone(IST)
    ran = []
    for name, fn_name, hour, minute, weekday, mday in DAILY:
        if weekday is not None and now.weekday() != weekday:
            continue
        if mday is not None and now.day != mday:
            continue
        if (now.hour, now.minute) < (hour, minute):
            continue
        async with tenant_tx(None, "system") as conn:
            mine = (await conn.execute(text("SELECT private.claim_daily_job(:n, :d)"),
                                       {"n": name, "d": now.date()})).scalar()
        if not mine:
            continue
        try:
            await globals()[fn_name](ctx)
            ran.append(name)
        except Exception:  # noqa: BLE001 - one job's failure never stops the others
            log.exception("daily job %s failed", name)
    return ran


async def priority_startup(ctx: dict) -> None:
    services = build_services(dispatch_mode="arq")
    set_services(services)
    ctx["services"] = services
    from kritvia_api import logredact
    logredact.install()
    await priority_heartbeat(ctx)
    ctx["heartbeat_task"] = asyncio.get_running_loop().create_task(_beat_forever(ctx, priority_heartbeat))
    log.info("priority worker %s started (%d run slots)", services.worker_id, RUN_SLOTS)


async def priority_heartbeat(ctx: dict) -> None:
    await ctx["redis"].set(PRIORITY_HEARTBEAT, ctx["services"].worker_id, ex=90)
    from kritvia_api.services import watchdog
    await watchdog.heartbeat("worker-priority", ctx["services"].worker_id)


async def heartbeat(ctx: dict) -> None:
    """Every 30 s: this worker is alive (the server's watchdog restarts it if this stops)."""
    from kritvia_api.services import watchdog
    await watchdog.heartbeat("worker", ctx["services"].worker_id)


async def watchdog_check(ctx: dict) -> int:
    """Every minute: put runs that should be running back on the queue, and tell Kritvia's team when
    something keeps failing (services/watchdog.py)."""
    from kritvia_api.services import watchdog
    return len(await watchdog.check(ctx["services"]))


async def sync_app_store(ctx: dict) -> dict:
    """Hourly: the official MCP Registry into the App store (services/app_catalog.py)."""
    from kritvia_api.services import app_catalog
    try:
        return await app_catalog.sync_registry()
    except Exception:  # noqa: BLE001 - the store keeps what it had
        log.exception("MCP registry sync failed")
        return {}


async def priority_shutdown(ctx: dict) -> None:
    try:
        await ctx["redis"].delete(PRIORITY_HEARTBEAT)
    finally:
        await shutdown(ctx)


class WorkerSettings:
    functions = [execute_run]
    cron_jobs = [
        cron(fire_schedules, second=5, run_at_startup=False),
        cron(fire_automations, second=10, run_at_startup=False),
        cron(sweep, second=35),
        cron(expire_approvals, second=50),
        cron(poll_gmail, minute=_every(5), second=20),
        cron(poll_indiamart, minute=_every(10), second=45),
        cron(reembed, minute=_every(15), second=40),
        cron(resume_paused, minute=_every(10), second=25),
        cron(daily_jobs, second=55, run_at_startup=False),      # the DAILY jobs, with same-day catch-up
        cron(nudge_expiring, minute={7, 37}, second=15, run_at_startup=False),
        cron(watchdog_check, second=50, run_at_startup=False),
        cron(sync_app_store, minute={17}, second=30),
        cron(dispatch_events, second=20, run_at_startup=False),
    ]
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = RedisSettings.from_dsn(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))
    timezone = IST
    max_jobs = RUN_SLOTS + CRON_SLOTS
    job_timeout = 1800
    keep_result = 0          # lets the same run be re-enqueued as soon as a job finishes
    allow_abort_jobs = True


class PriorityWorkerSettings:
    """The reserved worker for priority processing: `arq kritvia_worker.main.PriorityWorkerSettings`."""
    queue_name = PRIORITY_QUEUE
    functions = [execute_run]
    cron_jobs: list = []                       # its heartbeat runs from its own task (priority_startup)
    on_startup = priority_startup
    on_shutdown = priority_shutdown
    redis_settings = WorkerSettings.redis_settings
    timezone = IST
    max_jobs = int(os.environ.get("WORKER_PRIORITY_MAX_JOBS", "4"))
    job_timeout = 1800
    keep_result = 0
    allow_abort_jobs = True
