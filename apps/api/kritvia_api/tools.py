"""Built-in tools. Each declares its capability class; the policy engine
(engine/tools.py) decides whether it runs silently, needs an approval, or must
run in the sandbox."""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from kritvia_api.engine.tools import ApprovedAction, Capability, ToolRegistry

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext


def build_tools() -> ToolRegistry:
    reg = ToolRegistry()

    @reg.tool("gmail.send", Capability.SEND, "Send an email from the venture's connected Gmail account")
    async def gmail_send(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        assert ok is not None
        attachments = None
        if p.get("attachment_text"):
            attachments = [(p.get("attachment_name", "attachment.txt"), "text/plain",
                            p["attachment_text"].encode())]
        return await ctx.services.messaging.send_email(
            ctx, ok.id, to=p["to"], subject=p["subject"], body=p["body"], cc=p.get("cc"),
            thread_id=p.get("thread_id"), attachments=attachments)

    @reg.tool("calendar.create_event", Capability.SEND, "Create a calendar event and invite attendees")
    async def calendar_create(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        assert ok is not None
        return await ctx.services.messaging.create_event(
            ctx, ok.id, summary=p["summary"], start=p["start"], end=p["end"],
            attendees=p.get("attendees", []), description=p.get("description", ""))

    @reg.tool("crm.update_lead", Capability.WRITE, "Change a lead's status or score")
    async def crm_update(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        sets, params = ["updated_at = now()"], {"id": uuid.UUID(p["lead_id"]), "v": ctx.venture_id}
        for key in ("status", "score"):
            if key in p:
                sets.append(f"{key} = :{key}")
                params[key] = p[key]
        async with ctx.tx() as conn:
            res = await conn.execute(text(f"UPDATE leads SET {', '.join(sets)} WHERE id = :id AND venture_id = :v"),
                                     params)
        return {"updated": res.rowcount}

    @reg.tool("sandbox.forecast", Capability.EXECUTE, "Statistical demand forecast (runs in the sandbox)")
    async def sandbox_forecast(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        return await ctx.services.sandbox.run("forecast", p, timeout_s=120)

    @reg.tool("sandbox.bom", Capability.EXECUTE, "Recipe BOM x forecast -> purchase orders (sandbox)")
    async def sandbox_bom(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        return await ctx.services.sandbox.run("bom", p, timeout_s=60)

    @reg.tool("knowledge.search", Capability.READ, "Semantic search over the venture's knowledge base")
    async def knowledge_search(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        from kritvia_api.services.memory import search_as_agent
        hits = await search_as_agent(ctx, p["query"], k=int(p.get("k", 6)),
                                     kinds=p.get("kinds"), sensitive=bool(p.get("sensitive", False)))
        return {"hits": hits}

    return reg
