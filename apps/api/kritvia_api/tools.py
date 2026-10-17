"""Built-in tools. Each declares its capability class; the policy engine
(engine/tools.py) decides whether it runs silently, needs an approval, or must
run in the sandbox."""
from __future__ import annotations

import dataclasses
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

    @reg.tool("whatsapp.send", Capability.SEND, "Send a WhatsApp message from the venture's business number")
    async def whatsapp_send(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        assert ok is not None
        return await ctx.services.messaging.send_whatsapp(ctx, ok.id, to=p["to"], body=p["body"])

    @reg.tool("telegram.send", Capability.SEND, "Answer a customer from the business's Telegram bot")
    async def telegram_send(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        assert ok is not None
        return await ctx.services.messaging.send_telegram(ctx, ok.id, to=str(p["to"]), body=p["body"])

    @reg.tool("whatsapp.template", Capability.SEND,
              "Send one of the business's approved WhatsApp templates to someone who agreed to hear from it")
    async def whatsapp_template(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        assert ok is not None
        return await ctx.services.messaging.send_whatsapp_template(
            ctx, ok.id, to=str(p["to"]), template_id=str(p["template_id"]), params=list(p.get("params") or []))

    @reg.tool("whatsapp.templates", Capability.READ,
              "List the business's approved WhatsApp templates (for writing first or after 24 hours)")
    async def whatsapp_templates(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        from kritvia_api.services import wa_templates
        async with ctx.tx() as conn:
            found = await wa_templates.approved(conn, ctx.venture_id)
        return {"templates": [{"template": t.title, "language": t.language, "blanks": t.params,
                               "text": t.body, "example_blanks": t.examples} for t in found]}

    @reg.tool("invoices.search", Capability.READ, "Look up the business's invoices: who owes how much, and since when")
    async def invoices_search(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        from datetime import datetime

        from kritvia_api.workflows.collections import nice_date, rupees
        from kritvia_api.workflows.common import IST
        show = str(p.get("show") or "unpaid")
        where = {"overdue": "status = 'open' AND due_on < :today", "paid": "status = 'paid'"}.get(show, "status = 'open'")
        q = str(p.get("customer") or "").strip()
        params: dict[str, Any] = {"v": ctx.venture_id, "today": datetime.now(IST).date()}
        if q:
            where += " AND customer_name ILIKE :q"
            params["q"] = f"%{q}%"
        async with ctx.tx() as conn:
            rows = (await conn.execute(text(
                "SELECT number, customer_name, amount_paise, paid_paise, due_on, status, paid_on, reminders_sent,"
                f" reminders_paused FROM invoices WHERE venture_id = :v AND {where} ORDER BY due_on LIMIT 30"),
                params)).all()
        today = params["today"]
        return {"invoices": [{
            "customer": r.customer_name, "invoice": r.number or "(no number)", "total": rupees(r.amount_paise),
            "still_due": rupees(r.amount_paise - r.paid_paise), "due": nice_date(r.due_on),
            "days_overdue": max(0, (today - r.due_on).days) if r.status == "open" else 0, "status": r.status,
            "paid_on": nice_date(r.paid_on) if r.paid_on else None, "reminders_sent": r.reminders_sent,
            "reminders_paused": r.reminders_paused} for r in rows],
            "total_still_due": rupees(sum(r.amount_paise - r.paid_paise for r in rows if r.status == "open"))
            if rows else rupees(0)}

    @reg.tool("shipments.search", Capability.READ, "Look up the business's shipment files: stage, dates, documents still needed, alerts")
    async def shipments_search(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        from datetime import datetime

        from kritvia_api.services import trade as tr
        from kritvia_api.workflows.common import IST
        q = str(p.get("query") or "").strip()
        where = "" if str(p.get("show") or "open") == "all" else " AND stage NOT IN ('closed', 'cancelled')"
        params: dict[str, Any] = {"v": ctx.venture_id}
        if q:
            where += (" AND (number ILIKE :q OR party_name ILIKE :q OR coalesce(reference, '') ILIKE :q"
                      " OR coalesce(bl_no, '') ILIKE :q OR coalesce(containers, '') ILIKE :q OR coalesce(customs_no, '') ILIKE :q)")
            params["q"] = f"%{q}%"
        async with ctx.tx() as conn:
            rows = (await conn.execute(text(f"SELECT * FROM shipments WHERE venture_id = :v{where}"
                                            " ORDER BY updated_at DESC LIMIT 25"), params)).all()
            docs: dict = {r.id: [] for r in rows}
            if rows:
                for d in (await conn.execute(text("SELECT * FROM shipment_docs WHERE shipment_id = ANY (:ids)"),
                                             {"ids": list(docs)})).all():
                    docs[d.shipment_id].append(d)
        today = datetime.now(IST).date()
        return {"shipments": [{
            "file": r.number, "kind": ("C&F job, " if r.for_client else "") + r.direction, "party": r.party_name,
            "reference": r.reference, "stage": tr.stage_label(r.direction, r.stage), "mode": r.mode,
            "incoterm": r.incoterm, "from": r.port_loading, "to": r.port_discharge, "vessel": r.vessel,
            "bl_awb": r.bl_no, "containers": r.containers, "customs_no": r.customs_no,
            "etd": str(r.etd) if r.etd else None, "eta": str(r.eta) if r.eta else None,
            "value": tr.money(r.value_minor, r.currency), "received": tr.money(r.received_minor, r.currency),
            "documents_still_needed": [d.name for d in docs[r.id] if d.status == "needed"],
            "needs_attention": [a.text for a in tr.alerts(r, docs[r.id], today)]} for r in rows]}

    @reg.tool("places.search", Capability.READ, "Search Google Maps (Places API) for businesses")
    async def places_search(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        from kritvia_api.services.places import PlacesError
        from kritvia_api.services.places_keys import key_problem, places_for, record
        async with ctx.tx() as conn:
            access = await places_for(conn, ctx.services, ctx.venture_id)
        if access.client is None:
            raise PlacesError(access.problem or "Google Maps is not set up")
        try:
            found = await access.client.search(str(p["query"]), max_results=int(p.get("max_results", 60)))
        except PlacesError as exc:
            if key_problem(str(exc)):
                async with ctx.tx() as conn:
                    await record(conn, access, str(exc))
            raise
        async with ctx.tx() as conn:
            await record(conn, access, None)
        return {"places": [{**dataclasses.asdict(x), "website_kind": x.website_kind} for x in found]}

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

    @reg.tool("leads.search", Capability.READ, "Look up the business's leads by name, company, email or phone")
    async def leads_search(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        q = str(p.get("query") or "").strip()[:100]
        status = str(p.get("status") or "").strip().lower()[:20]
        where, params = ["venture_id = :v", "opted_out_at IS NULL"], {"v": ctx.venture_id}
        if q:
            where.append("(name ILIKE :q OR company ILIKE :q OR email ILIKE :q OR coalesce(phone, '') ILIKE :q)")
            params["q"] = "%" + q.replace("\\", "").replace("%", "").replace("_", " ") + "%"
        if status:
            where.append("status = :s")
            params["s"] = status
        async with ctx.tx() as conn:
            rows = (await conn.execute(text(
                "SELECT id, name, company, email, phone, status, score, source, created_at FROM leads"
                f" WHERE {' AND '.join(where)} ORDER BY created_at DESC LIMIT 20"), params)).all()
        return {"leads": [{"id": str(r.id), "name": r.name, "company": r.company, "email": r.email,
                           "phone": r.phone, "status": r.status, "score": r.score, "source": r.source,
                           "added": r.created_at.date().isoformat()} for r in rows]}

    @reg.tool("mcp.call", Capability.SEND, "Use a tool of a connected app (MCP) that changes something")
    async def mcp_call(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        assert ok is not None
        from kritvia_api.services import mcp
        result = await mcp.call(ctx, str(p.get("mcp_tool") or ""), p)
        return {"status": "done", "result": result[:2000]}

    @reg.tool("knowledge.search", Capability.READ, "Semantic search over the venture's knowledge base")
    async def knowledge_search(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        from kritvia_api.services.memory import search_as_agent
        hits = await search_as_agent(ctx, p["query"], k=int(p.get("k", 6)),
                                     kinds=p.get("kinds"), sensitive=bool(p.get("sensitive", False)))
        return {"hits": hits}

    return reg
