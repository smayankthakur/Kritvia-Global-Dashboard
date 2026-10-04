"""Inbound lead triage & proposal drafting (agencies and service businesses; built first for Sitelytc).

  extract -> upsert_lead -> retrieve -> score -> price -> draft
          -> [approval: gmail.send]  -> send_proposal
          -> invite -> [approval: calendar.create_event] -> send_invite

Prices come ONLY from the venture's rate card (code). The proposal agent writes
prose around a pricing table that code generates, and any currency amount the
model writes that isn't one of the computed figures is rejected.
"""
from __future__ import annotations

import json
import re
import uuid
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Option, Workflow, registry
from kritvia_api.services import pii
from kritvia_api.services.memory import canonical
from kritvia_api.workflows.common import CURRENCY_IN_TEXT, fmt_inr, money, next_business_slot, parse_inr

wf = registry.register(Workflow(
    "lead_triage", title="Lead triage & proposals", start="extract", venture_kinds=("software", "general"),
    trigger="New enquiry by email, website form or WhatsApp",
    description="Reads an enquiry, scores it, prices it from your rate card, drafts a proposal citing your past "
                "work and proposes a call — nothing is sent until you approve.",
    options=(
        Option("draft_proposal", "Draft a proposal for each qualified enquiry", "boolean", True,
               help="Off: the agent only scores the lead and files it in Leads."),
        Option("book_call", "Propose a discovery call after the proposal", "boolean", True),
        Option("gst_pct", "GST %", "number", 18, min=0, max=28),
        Option("min_budget_inr", "Minimum budget worth pursuing (₹)", "number", 50000, min=0),
        Option("meeting_hour_ist", "Call time (hour, IST)", "number", 11, min=8, max=20),
        Option("meeting_minutes", "Call length (minutes)", "number", 30, min=15, max=120),
        Option("dedupe_days", "Treat a repeat enquiry as the same lead within (days)", "number", 30, min=1, max=365),
    )))

DEFAULTS = {
    "source_weights": {"referral": 20, "webhook": 12, "email": 10, "manual": 8, "whatsapp": 10},
    # "sender_name": overrides the business profile's sign-off for proposals only
}


class ScopeItem(BaseModel):
    code: str = Field(description="rate card code from the allowed list")
    qty: float = Field(default=1, ge=0, le=1000, description="units stated or clearly implied, else 1")
    note: str = ""


class LeadExtract(BaseModel):
    contact_name: str | None = None
    company: str | None = None
    phone: str | None = None
    summary: str = Field(description="two-sentence neutral summary of what they want")
    requirements: list[str] = Field(default_factory=list)
    scope: list[ScopeItem] = Field(default_factory=list)
    budget_text: str | None = Field(default=None, description="budget exactly as written, e.g. '3-4 lakh'")
    timeline: str | None = None
    urgency: Literal["low", "medium", "high"] = "medium"
    is_spam: bool = False
    is_existing_client: bool = False


class FitAssessment(BaseModel):
    fit: Literal["strong", "partial", "poor"]
    reason: str


class ProposalDraft(BaseModel):
    subject: str
    email_body: str = Field(description="short cover email, plain text, no prices")
    proposal: str = Field(description="proposal in markdown: understanding, approach, scope, timeline, "
                                      "why us (reference past work by source number), next steps. NO prices.")
    used_sources: list[int] = Field(default_factory=list)


async def _settings(ctx: RunContext) -> dict[str, Any]:
    return {**DEFAULTS, **(await ctx.settings())}


async def _rate_card(ctx: RunContext) -> list[dict[str, Any]]:
    async with ctx.tx() as conn:
        rows = (await conn.execute(text(
            "SELECT code, name, description, unit, rate_inr, min_units FROM rate_cards"
            " WHERE venture_id = :v AND active ORDER BY code"), {"v": ctx.venture_id})).all()
    return [dict(r._mapping) for r in rows]


@wf.step("extract", agent="extraction")
async def extract(ctx: RunContext, state: dict) -> Goto | Finish:
    inp = state["input"]
    card = await _rate_card(ctx)
    codes = "\n".join(f"- {r['code']}: {r['name']} (per {r['unit']}) — {r['description']}" for r in card)
    # An enquiry carrying an ID, card or account number never leaves the server.
    held = pii.mask(f"{inp.get('subject') or ''}\n{inp.get('body') or ''}").sensitive
    ex = await ctx.llm_json(
        tier="private" if held else "extract", schema=LeadExtract, sensitive=held,
        system=(f"{await ctx.brief()}\nYou triage inbound inquiries for this business. "
                "Map what they ask for onto the allowed rate card codes; never invent codes. "
                "Mark marketing spam, SEO cold pitches and vendor solicitations as spam.\n"
                f"Allowed rate card codes:\n{codes or '- (none configured)'}"),
        prompt=(f"From: {inp.get('from_name') or ''} <{inp.get('from_email') or ''}>\n"
                f"Subject: {inp.get('subject') or ''}\n\n{(inp.get('body') or '')[:12000]}"))
    valid = {r["code"] for r in card}
    ex.scope = [s for s in ex.scope if s.code in valid]
    if ex.is_spam:
        ctx.note("classified as spam; no lead created")
        return Finish("spam", update={"summary": {"spam": True}})
    budget = parse_inr(ex.budget_text)
    return Goto("upsert_lead", update={"extract": ex.model_dump(), "budget_inr": str(budget) if budget else None,
                                       "input_sensitive": held},
                note=f"{len(ex.requirements)} requirements, {len(ex.scope)} scope items")


@wf.step("upsert_lead", agent="crm")
async def upsert_lead(ctx: RunContext, state: dict) -> Goto:
    inp, ex, cfg = state["input"], state["extract"], await _settings(ctx)
    email = (inp.get("from_email") or "").strip().lower() or None
    name = ex.get("contact_name") or inp.get("from_name") or email or "Unknown"
    company = ex.get("company") or inp.get("company")
    details = json.dumps({"requirements": ex["requirements"], "summary": ex["summary"],
                          "scope": ex["scope"], "timeline": ex.get("timeline"), "subject": inp.get("subject")})
    async with ctx.tx() as conn:
        existing = None
        if state.get("lead_id"):
            existing = (await conn.execute(text("SELECT id FROM leads WHERE id = :id"),
                                           {"id": uuid.UUID(state["lead_id"])})).first()
        if existing is None and (email or company):
            existing = (await conn.execute(text(
                "SELECT id FROM leads WHERE venture_id = :v AND status NOT IN ('won','lost','archived')"
                " AND last_inquiry_at > now() - make_interval(days => :d)"
                " AND ((CAST(:e AS text) IS NOT NULL AND lower(email) = :e)"
                "      OR (CAST(:c AS text) IS NOT NULL AND lower(company) = :c))"
                " ORDER BY last_inquiry_at DESC LIMIT 1"),
                {"v": ctx.venture_id, "d": int(cfg["dedupe_days"]), "e": email,
                 "c": canonical(company) if company else None})).first()
        enc = await ctx.crypto(conn).encrypt(ctx.venture_id, "leads.details", details)
        if existing:
            await conn.execute(text(
                "UPDATE leads SET inquiry_count = inquiry_count + 1, last_inquiry_at = now(), details_enc = :d,"
                " timeline = coalesce(:t, timeline), budget_inr = coalesce(:b, budget_inr),"
                " phone = coalesce(:p, phone), last_run_id = :r, updated_at = now() WHERE id = :id"),
                {"d": enc, "t": ex.get("timeline"), "b": state.get("budget_inr"), "p": ex.get("phone"),
                 "r": ctx.run_id, "id": existing.id})
            lead_id, dup = existing.id, True
        else:
            lead_id = (await conn.execute(text(
                "INSERT INTO leads (org_id, venture_id, name, email, company, source, phone, budget_inr, timeline,"
                " details_enc, last_run_id) VALUES (:o, :v, :n, :e, :c, :s, :p, :b, :t, :d, :r) RETURNING id"),
                {"o": ctx.org_id, "v": ctx.venture_id, "n": name[:200], "e": email,
                 "c": company and canonical(company) and company[:200], "s": inp.get("source", ctx.trigger_kind),
                 "p": ex.get("phone"), "b": state.get("budget_inr"), "t": ex.get("timeline"), "d": enc,
                 "r": ctx.run_id})).scalar_one()
            dup = False
    return Goto("retrieve", update={"lead_id": str(lead_id), "duplicate": dup,
                                    "summary": {"lead_id": str(lead_id), "duplicate": dup}},
                note="updated existing lead (duplicate inquiry)" if dup else "new lead created")


@wf.step("retrieve", agent="retrieval")
async def retrieve(ctx: RunContext, state: dict) -> Goto:
    ex = state["extract"]
    query = ex["summary"] + " " + "; ".join(ex["requirements"][:8])
    try:
        found = await ctx.invoke("knowledge.search", {"query": query, "k": 5,
                                                      "kinds": ["proposal", "upload", "drive", "note"]})
        hits = found["hits"]
    except Exception as exc:  # retrieval is an enhancement; never block triage on it
        ctx.note(f"retrieval unavailable ({type(exc).__name__})")
        hits = []
    codes = {s["code"] for s in ex["scope"]}
    async with ctx.tx() as conn:
        past = (await conn.execute(text(
            "SELECT id, title, line_items, total_inr, status FROM proposals WHERE venture_id = :v"
            " AND status IN ('sent','accepted') AND lead_id <> :l ORDER BY created_at DESC LIMIT 200"),
            {"v": ctx.venture_id, "l": uuid.UUID(state["lead_id"])})).all()
    similar = []
    for p in past:
        pc = {li["code"] for li in p.line_items}
        if codes and pc:
            j = len(codes & pc) / len(codes | pc)
            if j >= 0.5:
                similar.append({"id": str(p.id), "title": p.title, "total": str(p.total_inr),
                                "status": p.status, "similarity": round(j, 2)})
    similar.sort(key=lambda s: -s["similarity"])
    sources = [{"n": i + 1, "document_id": h["document_id"], "title": h["title"], "kind": h["kind"],
                "text": h["text"][:1500], "sensitive": bool(h.get("sensitive"))} for i, h in enumerate(hits[:5])]
    return Goto("score", update={"sources": sources, "similar": similar[:5]},
                note=f"{len(sources)} knowledge sources, {len(similar)} similar past proposals")


@wf.step("score", agent="lead_scoring")
async def score(ctx: RunContext, state: dict) -> Goto | Finish:
    ex, inp, cfg = state["extract"], state["input"], await _settings(ctx)
    try:
        held = bool(state.get("input_sensitive"))
        fit = await ctx.llm_json(
            tier="private" if held else "fast", schema=FitAssessment, sensitive=held,
            system=(f"{await ctx.brief()}\nAssess how well this inquiry fits what the business offers "
                    "(its description and rate card)."),
            prompt=ex["summary"] + "\n" + "\n".join(ex["requirements"]))
        fit_label, fit_reason = fit.fit, fit.reason[:200]
    except Exception:
        fit_label, fit_reason = ("partial" if ex["scope"] else "poor"), "fit model unavailable; rule-based"

    points, reasons = 0, []
    fit_pts = {"strong": 35, "partial": 18, "poor": 0}[fit_label]
    points += fit_pts
    reasons.append({"factor": "fit", "points": fit_pts, "detail": fit_label})
    scope_pts = min(15, 5 * len(ex["scope"]))
    points += scope_pts
    reasons.append({"factor": "scope_matched", "points": scope_pts, "detail": f"{len(ex['scope'])} rate-card items"})
    budget = Decimal(state["budget_inr"]) if state.get("budget_inr") else None
    if budget is None:
        b_pts, b_detail = 8, "not stated"
    elif budget >= Decimal(cfg["min_budget_inr"]) * 4:
        b_pts, b_detail = 25, "well above minimum"
    elif budget >= Decimal(cfg["min_budget_inr"]):
        b_pts, b_detail = 18, "above minimum"
    else:
        b_pts, b_detail = 0, "below minimum"
    points += b_pts
    reasons.append({"factor": "budget", "points": b_pts, "detail": b_detail})
    u_pts = {"high": 15, "medium": 8, "low": 2}[ex["urgency"]]
    points += u_pts
    reasons.append({"factor": "urgency", "points": u_pts, "detail": ex["urgency"]})
    src = inp.get("source", ctx.trigger_kind)
    s_pts = int(cfg["source_weights"].get(src, 5))
    points += s_pts
    reasons.append({"factor": "source", "points": s_pts, "detail": src})
    if state.get("duplicate"):
        points += 5
        reasons.append({"factor": "repeat_inquiry", "points": 5, "detail": "asked again"})
    total = max(0, min(100, points))
    priority = "hot" if total >= 70 else "warm" if total >= 40 else "cold"
    async with ctx.tx() as conn:
        await conn.execute(text(
            "UPDATE leads SET score = :s, priority = :p, score_reasons = CAST(:r AS jsonb),"
            " status = CASE WHEN status = 'new' AND :s >= 40 THEN 'qualified' ELSE status END, updated_at = now()"
            " WHERE id = :id"),
            {"s": total, "p": priority, "r": json.dumps(reasons), "id": uuid.UUID(state["lead_id"])})
    update = {"score": total, "priority": priority, "fit_reason": fit_reason,
              "summary": {**state.get("summary", {}), "score": total, "priority": priority}}
    if not cfg.get("draft_proposal", True):
        return Finish("scored", update=update, note=f"score {total} ({priority}); proposals are off for this business")
    return Goto("price", update=update, note=f"score {total} ({priority})")


@wf.step("price", agent="pricing")
async def price(ctx: RunContext, state: dict) -> Goto:
    cfg = await _settings(ctx)
    card = {r["code"]: r for r in await _rate_card(ctx)}
    lines, subtotal = [], Decimal(0)
    merged: dict[str, dict] = {}
    for s in state["extract"]["scope"]:
        m = merged.setdefault(s["code"], {"code": s["code"], "qty": 0.0, "notes": []})
        m["qty"] += float(s["qty"] or 1)
        if s.get("note"):
            m["notes"].append(s["note"])
    for code, m in merged.items():
        r = card[code]
        qty = max(Decimal(str(m["qty"])), Decimal(r["min_units"]))
        amount = money(Decimal(r["rate_inr"]) * qty)
        subtotal += amount
        lines.append({"code": code, "name": r["name"], "unit": r["unit"], "qty": str(qty.normalize()),
                      "rate": str(money(r["rate_inr"])), "amount": str(amount), "note": "; ".join(m["notes"])[:200]})
    gst = money(subtotal * Decimal(cfg["gst_pct"]) / 100)
    total = money(subtotal + gst)
    similar = state.get("similar", [])
    ref = {}
    if similar:
        totals = [Decimal(s["total"]) for s in similar]
        ref = {"count": len(totals), "min": str(min(totals)), "max": str(max(totals)),
               "ids": [s["id"] for s in similar]}
    pricing = {"lines": lines, "subtotal": str(money(subtotal)), "gst_pct": cfg["gst_pct"], "gst": str(gst),
               "total": str(total), "reference": ref, "needs_manual_pricing": not lines}
    return Goto("draft", update={"pricing": pricing},
                note=f"estimate {fmt_inr(total)} incl. GST" if lines else "no rate-card items matched; manual pricing")


def pricing_table(p: dict[str, Any]) -> str:
    if not p["lines"]:
        return "Pricing: to be confirmed after a short discovery call."
    rows = ["| Item | Qty | Rate | Amount |", "|---|---:|---:|---:|"]
    for li in p["lines"]:
        rows.append(f"| {li['name']} | {li['qty']} {li['unit']} | {fmt_inr(li['rate'])} | {fmt_inr(li['amount'])} |")
    rows.append(f"| **Subtotal** | | | **{fmt_inr(p['subtotal'])}** |")
    rows.append(f"| GST @ {p['gst_pct']}% | | | {fmt_inr(p['gst'])} |")
    rows.append(f"| **Total** | | | **{fmt_inr(p['total'])}** |")
    return "\n".join(rows)


def _stray_amounts(textblock: str) -> list[str]:
    return CURRENCY_IN_TEXT.findall(textblock)


@wf.step("draft", agent="proposal")
async def draft(ctx: RunContext, state: dict) -> Interrupt:
    inp, ex, cfg, p = state["input"], state["extract"], await _settings(ctx), state["pricing"]
    sources = state.get("sources", [])
    src_block = "\n\n".join(f"[{s['n']}] {s['title']} ({s['kind']})\n{s['text']}" for s in sources) or "(none)"
    feedback = state.get("feedback")
    prompt = (f"Client: {ex.get('contact_name') or inp.get('from_name')} — {ex.get('company') or ''}\n"
              f"Summary: {ex['summary']}\nRequirements:\n- " + "\n- ".join(ex["requirements"] or ["(unspecified)"]) +
              f"\nTimeline: {ex.get('timeline') or 'not stated'}\n"
              f"Scope items that will be priced separately: {', '.join(li['name'] for li in p['lines']) or 'TBD'}\n\n"
              f"Relevant past work and templates (cite by number):\n{src_block}\n")
    if feedback:
        prompt += f"\nThe reviewer rejected the previous draft with this feedback — address it:\n{feedback}\n"
    biz = await ctx.business()
    system = (f"{await ctx.brief()}\nYou are the proposal writer. Write clearly for an Indian SMB or enterprise "
              "buyer. Do NOT write any prices, amounts or currency: a pricing table generated by the system is "
              "inserted after your text. Reuse wording from the sources where it fits and list the source numbers "
              f"you used. Sign off as {cfg.get('sender_name') or biz.sign_off}.")
    # Defence in depth: retrieval already excludes sensitive knowledge, but if any got
    # through, it stays on the local model and the draft is visible only to deciders.
    sensitive = bool(state.get("input_sensitive")) or any(s.get("sensitive") for s in sources)
    tier = "private" if sensitive else "reason"
    d = await ctx.llm_json(tier=tier, schema=ProposalDraft, system=system, prompt=prompt, sensitive=sensitive)
    if _stray_amounts(d.email_body + d.proposal):
        d = await ctx.llm_json(tier=tier, schema=ProposalDraft, system=system, sensitive=sensitive,
                               prompt=prompt + "\nYour previous draft contained currency amounts. Remove ALL amounts.")
        if _stray_amounts(d.email_body + d.proposal):  # fail safe: drop offending lines
            d.proposal = "\n".join(line for line in d.proposal.splitlines() if not _stray_amounts(line))
            d.email_body = "\n".join(line for line in d.email_body.splitlines() if not _stray_amounts(line))
    used = [s for s in sources if s["n"] in set(d.used_sources)]
    proposal_md = f"{d.proposal.strip()}\n\n## Investment\n\n{pricing_table(p)}\n"
    # Other clients' prices are for the reviewer only: they go in the approval summary, never in the email.
    reference = (f" Internal reference: {p['reference']['count']} similar past proposals ranged "
                 f"{fmt_inr(p['reference']['min'])}–{fmt_inr(p['reference']['max'])}."
                 if p["reference"] else "")
    body = (await ctx.business()).with_notice(f"{d.email_body.strip()}\n\n---\n\n{proposal_md}")

    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE proposals SET status = 'superseded' WHERE lead_id = :l AND status = 'draft'"),
                           {"l": uuid.UUID(state["lead_id"])})
        prop_id = (await conn.execute(text(
            "INSERT INTO proposals (org_id, venture_id, lead_id, run_id, title, content_enc, line_items,"
            " subtotal_inr, gst_inr, total_inr, reference, citations)"
            " VALUES (:o, :v, :l, :r, :t, :c, CAST(:li AS jsonb), :sub, :gst, :tot, CAST(:ref AS jsonb),"
            " CAST(:cit AS jsonb)) RETURNING id"),
            {"o": ctx.org_id, "v": ctx.venture_id, "l": uuid.UUID(state["lead_id"]), "r": ctx.run_id,
             "t": d.subject[:300], "c": await ctx.crypto(conn).encrypt(ctx.venture_id, "proposals.content", proposal_md),
             "li": json.dumps(p["lines"]), "sub": p["subtotal"], "gst": p["gst"], "tot": p["total"],
             "ref": json.dumps(p["reference"]),
             "cit": json.dumps([{"document_id": s["document_id"], "title": s["title"]} for s in used])})).scalar_one()

    to = (inp.get("from_email") or "").strip()
    cites = ", ".join(s["title"] for s in used) or "no past documents"
    return Interrupt(
        ApprovalRequest(
            agent="proposal", action="gmail.send", key="proposal_decision",
            title=f"Send proposal to {ex.get('company') or ex.get('contact_name') or to}",
            summary=(f"Score {state['score']} ({state['priority']}). Estimate "
                     f"{fmt_inr(p['total']) if p['lines'] else 'TBD'} incl. GST. Draws on: {cites}.{reference}"),
            payload={"to": to, "subject": d.subject, "body": body, "thread_id": inp.get("thread_id")},
            required_roles=("approver", "venture_admin"), sensitive=sensitive,
            always_review=bool(used)),
        resume="send_proposal", on_reject="redraft",
        update={"proposal_id": str(prop_id), "redrafts": state.get("redrafts", 0)},
        note=f"proposal drafted citing {len(used)} source(s)")


@wf.step("redraft", agent="proposal")
async def redraft(ctx: RunContext, state: dict) -> Goto | Finish:
    decision = state.get("proposal_decision") or {}
    comment = (decision.get("comment") or "").strip()
    if comment and state.get("redrafts", 0) < 2:
        return Goto("draft", update={"feedback": comment, "redrafts": state.get("redrafts", 0) + 1},
                    note="rejected with feedback; redrafting")
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE proposals SET status = 'rejected' WHERE id = :id"),
                           {"id": uuid.UUID(state["proposal_id"])})
    return Finish("proposal_rejected")


@wf.step("send_proposal", agent="proposal")
async def send_proposal(ctx: RunContext, state: dict) -> Goto:
    d = state["proposal_decision"]
    res = await ctx.invoke("gmail.send", approval_id=d["approval_id"])
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE proposals SET status = 'sent', sent_at = now() WHERE id = :id"),
                           {"id": uuid.UUID(state["proposal_id"])})
        await conn.execute(text("UPDATE leads SET status = 'proposal', updated_at = now() WHERE id = :id"
                                " AND status IN ('new','qualified')"), {"id": uuid.UUID(state["lead_id"])})
    return Goto("invite", note=f"proposal {res.get('status')} via {res.get('transport')}")


@wf.step("invite", agent="scheduler")
async def invite(ctx: RunContext, state: dict) -> Interrupt | Finish:
    inp, ex, cfg = state["input"], state["extract"], await _settings(ctx)
    to = (inp.get("from_email") or "").strip()
    if not to or not cfg.get("book_call", True):
        return Finish("proposal_sent")
    start, end = next_business_slot(hour=int(cfg["meeting_hour_ist"]), minutes=int(cfg["meeting_minutes"]))
    who = ex.get("company") or ex.get("contact_name") or to
    return Interrupt(
        ApprovalRequest(
            agent="scheduler", action="calendar.create_event", key="invite_decision",
            title=f"Invite {who} to a discovery call",
            summary=f"Proposed {start[:16].replace('T', ' ')} IST, {cfg['meeting_minutes']} min. Edit the time if needed.",
            payload={"summary": f"Discovery call — {who} × {(await ctx.business()).name}", "start": start, "end": end,
                     "attendees": [to], "description": "Walk through the proposal and next steps."},
            required_roles=("approver", "venture_admin")),
        resume="send_invite", on_reject="no_invite")


@wf.step("send_invite", agent="scheduler")
async def send_invite(ctx: RunContext, state: dict) -> Finish:
    res = await ctx.invoke("calendar.create_event", approval_id=state["invite_decision"]["approval_id"])
    return Finish("proposal_sent_call_booked", note=f"invite {res.get('status')} via {res.get('transport')}")


@wf.step("no_invite", agent="scheduler")
async def no_invite(ctx: RunContext, state: dict) -> Finish:
    return Finish("proposal_sent")


def lead_from_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """Normalise a website lead-form payload into the workflow's input shape."""
    def pick(*keys: str) -> str | None:
        for k in keys:
            v = payload.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()[:5000]
        return None
    message = pick("message", "body", "requirements", "details", "description") or ""
    extra = {k: v for k, v in payload.items() if k in ("budget", "timeline", "service", "services", "phone")}
    if extra:
        message += "\n\n" + "\n".join(f"{k}: {v}" for k, v in extra.items())
    email = pick("email", "from_email")
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        email = None
    return {"source": "webhook", "from_name": pick("name", "full_name", "from_name"), "from_email": email,
            "company": pick("company", "organisation", "organization"),
            "subject": pick("subject") or "Website inquiry", "body": message}
