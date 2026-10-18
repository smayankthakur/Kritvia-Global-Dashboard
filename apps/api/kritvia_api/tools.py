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

    # ------------------------------------------------------- the business itself (assistant) --
    async def _tz(conn, venture_id):
        from zoneinfo import ZoneInfo
        tz = (await conn.execute(text("SELECT timezone FROM venture_settings WHERE venture_id = :v"),
                                 {"v": venture_id})).scalar()
        try:
            return ZoneInfo(tz or "Asia/Kolkata")
        except Exception:
            return ZoneInfo("Asia/Kolkata")

    @reg.tool("business.numbers", Capability.READ,
              "The business's numbers for a period: money received, invoices issued, still to collect and overdue "
              "(largest first), bookings, new and won leads, drafts waiting")
    async def business_numbers(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        from datetime import datetime

        from kritvia_api.services import automations as au
        period = str(p.get("period") or "this_month").strip().lower().replace(" ", "_")
        if period not in au.PERIODS:
            period = "this_month"
        async with ctx.tx() as conn:
            tz = await _tz(conn, ctx.venture_id)
            start, end = au.period_range(period, tz, datetime.now(tz))
            lines = await au.facts(conn, ctx.venture_id, start, end)
        return {"period": au.PERIOD_WORDS[period], "numbers": lines}

    @reg.tool("tasks.search", Capability.READ,
              "Look up the business's tasks (cards on its task boards): what is open, who has it, when it is due")
    async def tasks_search(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        from kritvia_api.services import memory
        q = str(p.get("query") or "").strip().lower()[:100]
        who = str(p.get("person") or "").strip().lower()[:100]
        show = str(p.get("show") or "open")
        where = "c.venture_id = :v AND c.archived_at IS NULL"
        where += {"done": " AND c.done_at IS NOT NULL", "all": ""}.get(show, " AND c.done_at IS NULL")
        async with ctx.tx() as conn:
            rows = (await conn.execute(text(
                "SELECT c.title_enc, f.statement_enc, c.due_date, c.done_at, c.assignee_id, b.name AS board"
                " FROM task_cards c JOIN task_boards b ON b.id = c.board_id"
                f" LEFT JOIN facts f ON f.id = c.fact_id WHERE {where}"
                " ORDER BY c.due_date NULLS LAST, c.updated_at DESC LIMIT 200"), {"v": ctx.venture_id})).all()
            people = {r.user_id: r for r in (await conn.execute(
                text("SELECT user_id, full_name, email FROM venture_people(:v)"), {"v": ctx.venture_id})).all()}
            crypto = ctx.crypto(conn)
            out = []
            for r in rows:
                title = await crypto.decrypt_str(ctx.venture_id, "task_cards.title", r.title_enc)
                if title is None and r.statement_enc is not None:
                    title = (await crypto.decrypt(ctx.venture_id, memory.FACT_PURPOSE, r.statement_enc)).decode()
                title = title or "(untitled)"
                if q and q not in title.lower():
                    continue
                p_ = people.get(r.assignee_id)
                if who and (p_ is None or who not in f"{p_.full_name or ''} {p_.email or ''}".lower()):
                    continue
                out.append({"task": title[:200], "board": r.board, "who": (p_.full_name or p_.email) if p_ else None,
                            "due": r.due_date.isoformat() if r.due_date else None, "done": r.done_at is not None})
                if len(out) >= 30:
                    break
        return {"tasks": out}

    @reg.tool("approvals.waiting", Capability.READ, "What is waiting for a yes on the approval board (titles only)")
    async def approvals_waiting(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        async with ctx.tx() as conn:
            rows = (await conn.execute(text(
                "SELECT agent, action, title, created_at FROM approvals WHERE venture_id = :v AND status = 'pending'"
                " AND NOT sensitive ORDER BY created_at LIMIT 30"), {"v": ctx.venture_id})).all()
            n = (await conn.execute(text("SELECT count(*) FROM approvals WHERE venture_id = :v AND status = 'pending'"),
                                    {"v": ctx.venture_id})).scalar()
        from kritvia_api.plans import AGENT_NAMES
        return {"waiting": int(n or 0), "drafts": [{"by": AGENT_NAMES.get(r.agent, r.agent), "what": r.title,
                                                    "since": r.created_at.date().isoformat()} for r in rows]}

    @reg.tool("tasks.create", Capability.WRITE, "Add a task to the business's task board, optionally for a person with a due date")
    async def tasks_create(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        from datetime import date
        title = str(p.get("title") or "").strip()[:300]
        if not title:
            raise ValueError("a task needs a title")
        due = None
        if p.get("due"):
            due = date.fromisoformat(str(p["due"])[:10])
        who = str(p.get("person") or "").strip().lower()
        async with ctx.tx() as conn:
            board = (await conn.execute(text("SELECT default_task_board(:v)"), {"v": ctx.venture_id})).scalar()
            lst = (await conn.execute(text("SELECT id FROM task_lists WHERE board_id = :b AND NOT is_done"
                                           " ORDER BY position LIMIT 1"), {"b": board})).scalar()
            assignee = None
            if who:
                people = (await conn.execute(text("SELECT user_id, full_name, email FROM venture_people(:v)"),
                                             {"v": ctx.venture_id})).all()
                hits = [r.user_id for r in people if who == (r.email or "").lower() or who in (r.full_name or "").lower()]
                if len(hits) == 1:
                    assignee = hits[0]
            enc = await ctx.crypto(conn).encrypt(ctx.venture_id, "task_cards.title", title)
            pos = (await conn.execute(text("SELECT coalesce(max(position), 0) + 1024 FROM task_cards WHERE list_id = :l"),
                                      {"l": lst})).scalar()
            cid = (await conn.execute(text(
                "INSERT INTO task_cards (org_id, venture_id, board_id, list_id, title_enc, position, assignee_id, due_date)"
                " VALUES (:o, :v, :b, :l, :t, :p, :a, :d) RETURNING id"),
                {"o": ctx.org_id, "v": ctx.venture_id, "b": board, "l": lst, "t": enc, "p": pos, "a": assignee,
                 "d": due})).scalar_one()
        return {"task_id": str(cid), "assigned": assignee is not None, "due": due.isoformat() if due else None}

    @reg.tool("leads.create", Capability.WRITE, "Add a new lead (a possible customer) to the business's leads")
    async def leads_create(ctx: RunContext, p: dict[str, Any], ok: ApprovedAction | None) -> dict[str, Any]:
        import re
        name = str(p.get("name") or "").strip()[:200]
        if not name:
            raise ValueError("a lead needs a name")
        email = str(p.get("email") or "").strip().lower()[:200] or None
        if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
            raise ValueError("that email address doesn't look right")
        phone = re.sub(r"[^0-9+]", "", str(p.get("phone") or ""))[:20] or None
        async with ctx.tx() as conn:
            lid = (await conn.execute(text(
                "INSERT INTO leads (org_id, venture_id, name, email, company, phone, source)"
                " VALUES (:o, :v, :n, :e, :c, :ph, 'assistant') RETURNING id"),
                {"o": ctx.org_id, "v": ctx.venture_id, "n": name, "e": email,
                 "c": str(p.get("company") or "").strip()[:200] or None, "ph": phone})).scalar_one()
        return {"lead_id": str(lid)}

    @reg.tool("indiamart.enquiries", Capability.READ,
              "The business's recent IndiaMART enquiries (they also arrive as leads by themselves)")
    async def indiamart_enquiries(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        async with ctx.tx() as conn:
            on = (await conn.execute(text("SELECT status FROM connectors WHERE venture_id = :v AND provider = 'indiamart'"),
                                     {"v": ctx.venture_id})).scalar()
            rows = (await conn.execute(text(
                "SELECT name, company, email, phone, status, score, created_at FROM leads WHERE venture_id = :v"
                " AND source = 'indiamart' ORDER BY created_at DESC LIMIT 20"), {"v": ctx.venture_id})).all()
        if on is None:
            return {"connected": False, "note": "IndiaMART isn't connected (Settings → Connectors → IndiaMART)"}
        return {"connected": on == "active", "enquiries": [
            {"name": r.name, "company": r.company, "email": r.email, "phone": r.phone, "status": r.status,
             "score": r.score, "came_in": r.created_at.date().isoformat()} for r in rows]}

    @reg.tool("team.handoff", Capability.READ,
              "Hand work to another lead of the business's team (front_desk, sales, accounts or ops); they start on it now")
    async def team_handoff(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        from kritvia_api.services import team
        return await team.handoff(ctx, str(p.get("to") or "").strip().lower(), str(p.get("note") or ""))

    @reg.tool("web.browse", Capability.READ,
              "Look something up on websites (a price, a rate, opening hours, a rule on an official site). "
              "Only reads pages; it can't sign in or send forms")
    async def web_browse(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        from kritvia_api.services import browser_agent as ba
        from kritvia_api.services.quota import PlanRestricted, require_agent
        task = str(p.get("task") or "").strip()[:1500]
        if len(task) < 5:
            return {"ok": False, "why": "say what to look up"}
        async with ctx.tx() as conn:
            row = (await conn.execute(text(
                "SELECT coalesce(s.kind, 'general') AS kind, coalesce(c.enabled, true) AS enabled FROM ventures v"
                " LEFT JOIN venture_settings s ON s.venture_id = v.id LEFT JOIN workflow_configs c"
                " ON c.venture_id = v.id AND c.workflow = 'browser' WHERE v.id = :v"), {"v": ctx.venture_id})).first()
            try:
                await require_agent(conn, ctx.venture_id, "browser", row.kind if row else None)
            except PlanRestricted as exc:
                return {"ok": False, "why": str(exc)}
        if row is not None and not row.enabled:
            return {"ok": False, "why": "the browser agent is switched off for this business"}
        try:
            out = await ba.browse(ctx, ctx.services.browser, task, (str(p.get("url") or "").strip() or None),
                                  max_actions=8, may_submit=False)
        except ba.BrowserError as exc:
            return {"ok": False, "why": str(exc)}
        return {"ok": True, "answer": out.answer, "pages": out.sources}

    @reg.tool("browser.submit", Capability.SEND, "Send a website form exactly as the person approved it")
    async def browser_submit(ctx: RunContext, p: dict[str, Any], _: ApprovedAction | None) -> dict[str, Any]:
        page = await ctx.services.browser.submit(
            str(p["url"]), [{"selector": f["selector"], "value": f["value"], "kind": f.get("kind", "fill")}
                            for f in p.get("fields") or []], str(p["button"]["selector"]))
        return {"sent": True, "url": page.get("url"), "title": page.get("title"),
                "text": (page.get("text") or "")[:1500]}

    return reg
