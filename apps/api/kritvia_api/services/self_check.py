"""Kritvia checks its own automations and tells the owner what is stuck.

  morning(services)   every morning: for each business with an agent on, the automation health of the last
                      7 days (automation_audit/live.py). Things that need a person (an agent on but unable to
                      run, runs with nothing to work with, drafts expiring or waiting, failures) go to the owners
                      and admins by push, Telegram or email. The same news isn't repeated: it is sent again only
                      when something new turns up, or once a week while it lasts. Ideas (an agent ready to send
                      by itself) ride along when there is news.

  nudge(services)     every half hour: drafts that expire within the next few hours and nobody was told about.
                      One message per business; Telegram approvers get the drafts again as cards with buttons.

Read-only apart from automation_checks and approvals.nudged_at; nothing is approved, sent or changed.
"""
from __future__ import annotations

import hashlib
import json
import logging
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

log = logging.getLogger(__name__)

REMIND_EVERY = timedelta(days=7)
NUDGE_WITHIN = timedelta(hours=6)
MAX_LINES = 8


def digest(findings: list[dict]) -> str:
    """What the news is about, not its counts: a draft count changing every day isn't new news."""
    keys = sorted({f"{f['agent']}|{f['kind']}" for f in findings if f["level"] in ("fix", "check")})
    return hashlib.sha256("\n".join(keys).encode()).hexdigest()[:32] if keys else ""


def message(business: str, findings: list[dict]) -> tuple[str, str]:
    needs = [f for f in findings if f["level"] in ("fix", "check")]
    ideas = [f for f in findings if f["level"] == "idea"]
    order = {"fix": 0, "check": 1}
    lines = [f"- {f['text']}" for f in sorted(needs, key=lambda f: order[f["level"]])[:MAX_LINES]]
    if len(needs) > MAX_LINES:
        lines.append(f"- and {len(needs) - MAX_LINES} more in Kritvia.")
    if ideas:
        lines += ["", "Could do more by itself:"] + [f"- {f['text']}" for f in ideas[:3]]
    subject = f"{business}: {len(needs)} thing{'s' if len(needs) != 1 else ''} need{'s' if len(needs) == 1 else ''} you"
    return subject, "Kritvia's morning check of your agents:\n\n" + "\n".join(lines)


async def morning(services, now: datetime | None = None) -> int:
    """Returns how many businesses were told something."""
    from kritvia_api.automation_audit.live import health
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.owner_news import tell_admins
    now = now or datetime.now(UTC)
    async with tenant_tx(None, "system") as conn:
        targets = (await conn.execute(text("SELECT * FROM private.self_check_targets()"))).all()
    told = 0
    for t in targets:
        if t.run_as is None:
            continue
        try:
            async with tenant_tx(t.run_as, "user") as conn:
                h = await health(conn, t.venture_id, days=7, now=now)
                prev = (await conn.execute(text(
                    "SELECT digest, notified_at FROM automation_checks WHERE venture_id = :v"),
                    {"v": t.venture_id})).first()
                business = (await conn.execute(text(
                    "SELECT coalesce(nullif(s.business_name, ''), v.name) FROM ventures v"
                    " LEFT JOIN venture_settings s ON s.venture_id = v.id WHERE v.id = :v"),
                    {"v": t.venture_id})).scalar() or "Your business"
                d = digest(h["findings"])
                news = bool(d) and (prev is None or prev.digest != d or prev.notified_at is None
                                    or prev.notified_at < now - REMIND_EVERY)
                sent = False
                if news:
                    subject, body = message(business, h["findings"])
                    first = next(f for f in h["findings"] if f["level"] in ("fix", "check"))
                    r = await tell_admins(services, conn, t.venture_id, subject=subject, body=body,
                                          path=first["path"], tag=f"self-check-{t.venture_id}")
                    sent = r.anyone
                    told += int(sent)
                await conn.execute(text("SELECT private.record_self_check(:v, CAST(:f AS jsonb), :d, :t)"),
                                   {"v": t.venture_id, "f": json.dumps(h["findings"]), "d": d, "t": sent})
        except Exception:  # noqa: BLE001 - one business's problem never stops the others' check
            log.exception("self-check failed for %s", t.venture_id)
    return told


async def nudge(services, now: datetime | None = None) -> int:
    """Drafts about to expire: tell each business once. Returns the number of drafts nudged."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services import chat_approvals
    from kritvia_api.services.owner_news import tell_admins
    now = now or datetime.now(UTC)
    async with tenant_tx(None, "system") as conn:
        due = (await conn.execute(text("SELECT * FROM private.claim_expiring_approvals(:n, :w)"),
                                  {"n": now, "w": NUDGE_WITHIN})).all()
        owners = {}
        for v in {d.venture_id for d in due}:
            owners[v] = (await conn.execute(text(
                "SELECT run_as FROM private.self_check_targets() WHERE venture_id = :v"), {"v": v})).scalar()
    by_venture: dict = defaultdict(list)
    for d in due:
        by_venture[d.venture_id].append(d)
    for v, drafts in by_venture.items():
        if owners.get(v) is None:
            continue
        drafts.sort(key=lambda d: d.expires_at)
        first = drafts[0].expires_at
        hours = max(1, round((first - now).total_seconds() / 3600))
        lines = [f"- {d.title}" for d in drafts[:6]] + ([f"- and {len(drafts) - 6} more"] if len(drafts) > 6 else [])
        body = (f"{len(drafts)} draft{'s' if len(drafts) != 1 else ''} will expire in about {hours} hour"
                f"{'s' if hours != 1 else ''} if nobody approves {'them' if len(drafts) != 1 else 'it'}:\n"
                + "\n".join(lines))
        try:
            async with tenant_tx(owners[v], "user") as conn:
                await tell_admins(services, conn, v, subject="Drafts about to expire", body=body,
                                  path=f"/v/{v}/board", tag=f"expiring-{v}")
                chats = (await conn.execute(text(
                    "SELECT external_id FROM approver_links WHERE venture_id = :v AND channel = 'telegram'"),
                    {"v": v})).scalars().all()
            for chat in chats:      # the cards again, with their buttons, so one tap decides
                for d in drafts[:6]:
                    try:
                        await chat_approvals.telegram_card_to(v, d.approval_id, chat)
                    except Exception:  # noqa: BLE001
                        log.info("nudge: card not sent", exc_info=True)
        except Exception:  # noqa: BLE001
            log.exception("nudge failed for %s", v)
    return len(due)
