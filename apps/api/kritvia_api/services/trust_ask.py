"""An agent asks for the right to send by itself, the moment it has earned it.

Every yes without a change adds one to the agent's clean streak for that kind of action; an edit or a
rejection resets it (decide_approval). When the streak reaches the business's trust threshold (30 by
default) the agent asks the owners and admins once: push, Telegram or email, linking to the Trust page,
where one tap lets it send those by itself. It asks again only if the streak is reset and earned again.
Drafts that are sensitive, quote a price the agent isn't sure of, or are always reviewed keep waiting for a
person whatever the trust.
"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import text

log = logging.getLogger(__name__)

ACTION_WORDS = {
    "gmail.send": "emails", "whatsapp.send": "WhatsApp replies", "whatsapp.template": "WhatsApp messages",
    "telegram.send": "Telegram replies", "calendar.create_event": "meeting invites",
    "crm.update_lead": "lead updates", "tasks.create": "tasks", "leads.create": "new leads",
    "web.browse_approved": "web look-ups", "mcp.call": "connected-app actions",
}


def agent_title(agent: str) -> str:
    from kritvia_api.engine.core import registry
    for w in registry.all():
        if w.name == agent or any(s.agent == agent for s in w.steps.values()):
            return w.title
    return agent.replace("_", " ").capitalize()


async def maybe_ask(services, user_id: uuid.UUID, venture_id: uuid.UUID, approval_id: uuid.UUID) -> bool:
    """After a yes: has this agent just earned trust for this kind of action? Ask once. Never raises."""
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services.owner_news import tell_admins
    from kritvia_api.services.quota import plan_for_venture
    try:
        async with tenant_tx(user_id) as conn:
            t = (await conn.execute(text(
                "SELECT t.agent, t.action, t.auto_run, t.consecutive_clean, coalesce(s.trust_threshold, 30) AS threshold"
                " FROM approvals a JOIN agent_trust t ON t.venture_id = a.venture_id AND t.agent = a.agent"
                "  AND t.action = a.action LEFT JOIN venture_settings s ON s.venture_id = a.venture_id"
                " WHERE a.id = :a AND a.venture_id = :v AND a.status = 'approved' AND NOT a.sensitive"),
                {"a": approval_id, "v": venture_id})).first()
            if t is None or t.auto_run or t.consecutive_clean != t.threshold:
                return False
            if not (await plan_for_venture(conn, venture_id)).autonomy:
                return False
            title, what = agent_title(t.agent), ACTION_WORDS.get(t.action, t.action)
            await tell_admins(
                services, conn, venture_id, subject=f"{title} asks: may it send {what} by itself?",
                body=(f"The last {t.threshold} {what} {title} drafted were approved without a change. Let it send "
                      "these by itself from now on? Anything sensitive, or with a price it isn't sure of, will "
                      "still wait for you, and you can take it back any time on the Trust page."),
                path=f"/v/{venture_id}/trust", tag=f"trust-{venture_id}-{t.agent}-{t.action}")
            await conn.execute(text("SELECT public.audit_event(v.org_id, v.id, 'autonomy.asked', 'agent_trust',"
                                    " :ref, CAST(:d AS jsonb)) FROM ventures v WHERE v.id = :v"),
                               {"v": venture_id, "ref": f"{t.agent}/{t.action}",
                                "d": f'{{"consecutive_clean": {int(t.consecutive_clean)}}}'})
            return True
    except Exception:  # noqa: BLE001 - asking is a courtesy; a decision must never fail because of it
        log.exception("trust ask failed")
        return False
