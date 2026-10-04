"""Inbox assistant: the agent any business can run from day one.

  classify -> (spam | handed to lead triage | filed) | retrieve -> draft
           -> [approval: gmail.send / whatsapp.send] -> send

Reads each incoming email or WhatsApp message, works out what it is (enquiry,
support question, invoice or payment, scheduling, other), files it in memory so
tasks and facts are extracted, and — when a reply is needed — drafts one in the
business's voice using what Kritvia knows, following the owner's standing
instructions. The reply goes out only after approval. Enquiries are handed to
Lead triage when that agent is on, so a lead is scored and priced instead of
merely answered.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Option, Workflow, registry
from kritvia_api.services import memory, pii

wf = registry.register(Workflow(
    "inbox_assistant", title="Inbox assistant", start="classify",
    trigger="Every new email or WhatsApp message",
    description="Sorts incoming messages, files them in memory, pulls out tasks, and drafts replies in your voice "
                "from what Kritvia knows about your business — sent only after you approve.",
    options=(
        Option("draft_replies", "Draft replies to messages that need one", "boolean", True,
               help="Off: messages are sorted and filed, nothing is drafted."),
        Option("reply_language", "Reply language", "text", "same as the customer",
               help="e.g. 'English', 'Hindi', 'Hinglish', or 'same as the customer'."),
        Option("hand_off_leads", "Hand enquiries to Lead triage when it is on", "boolean", True),
        Option("file_in_memory", "File every message in Knowledge (tasks and facts are extracted)", "boolean", True),
    )))

CATEGORIES = ("enquiry", "support", "payment", "scheduling", "update", "spam", "other")


class Classification(BaseModel):
    category: Literal["enquiry", "support", "payment", "scheduling", "update", "spam", "other"]
    summary: str = Field(description="one neutral sentence: who wants what")
    needs_reply: bool = Field(description="true if the sender expects an answer from the business")
    language: str = Field(default="en", description="language of the message: en, hi, hinglish, or other")
    urgency: Literal["low", "medium", "high"] = "medium"


class Reply(BaseModel):
    subject: str = Field(default="", description="email subject (ignored for WhatsApp)")
    body: str = Field(description="the reply, plain text, ready to send")
    used_sources: list[int] = Field(default_factory=list)
    unsure: bool = Field(default=False, description="true if the sources did not answer the question")


def _recipient(inp: dict[str, Any]) -> str:
    return (inp.get("from_email") or inp.get("from_phone") or "").strip()


@wf.step("classify", agent="inbox")
async def classify(ctx: RunContext, state: dict) -> Goto | Finish:
    inp, cfg = state["input"], await ctx.settings()
    channel = inp.get("channel") or "email"
    header = (f"Channel: {channel}\nFrom: {inp.get('from_name') or ''} <{_recipient(inp)}>\n"
              f"Subject: {inp.get('subject') or ''}\n\n")
    # A message carrying an ID, card or account number never leaves the server.
    held = pii.mask(header + (inp.get("body") or "")).sensitive
    c = await ctx.llm_json(
        tier="private" if held else "extract", schema=Classification, sensitive=held,
        system=(f"{await ctx.brief()}\nYou sort the business's incoming messages. Categories: enquiry (a potential "
                "customer asking about products, services or prices), support (an existing customer needing help), "
                "payment (invoices, bills, payment confirmations), scheduling (meetings, visits, deliveries), "
                "update (FYI, newsletters, notifications), spam (cold pitches, marketing), other."),
        prompt=header + (inp.get("body") or "")[:12000])
    summary = {"category": c.category, "needs_reply": c.needs_reply, "language": c.language, "urgency": c.urgency}
    if c.category == "spam":
        return Finish("spam", update={"summary": summary}, note="spam; nothing filed")

    if cfg.get("file_in_memory", True) and (inp.get("body") or "").strip():
        try:
            doc_text = header + (inp.get("body") or "")
            await memory.ingest(ctx, title=(inp.get("subject") or c.summary)[:200], kind="email",
                                text_override=doc_text, external_id=inp.get("message_id"),
                                meta={"channel": channel, "from": _recipient(inp), "category": c.category})
        except Exception as exc:  # filing is an enhancement; never block the reply on it
            ctx.note(f"could not file message ({type(exc).__name__})")

    if c.category == "enquiry" and cfg.get("hand_off_leads", True) and _recipient(inp):
        async with ctx.tx() as conn:
            lead_on = (await conn.execute(text(
                "SELECT 1 FROM workflow_configs WHERE venture_id = :v AND workflow = 'lead_triage' AND enabled"),
                {"v": ctx.venture_id})).first() is not None
        if lead_on:
            from kritvia_api.engine.runner import DuplicateTrigger, start_run
            try:
                run_id = await start_run(ctx.services, actor_user_id=ctx.run_as, actor_type="agent",
                                         venture_id=ctx.venture_id, workflow="lead_triage",
                                         trigger_kind=ctx.trigger_kind if ctx.trigger_kind != "manual" else "api",
                                         trigger_ref=inp.get("message_id"),
                                         dedupe=("inbox:handoff", inp["message_id"]) if inp.get("message_id") else None,
                                         title=f"Enquiry: {(inp.get('subject') or c.summary)[:120]}",
                                         input={**inp, "source": channel})
                return Finish("handed_to_lead_triage", update={"summary": {**summary, "lead_run_id": str(run_id)}},
                              note="enquiry handed to Lead triage")
            except DuplicateTrigger:
                return Finish("handed_to_lead_triage", update={"summary": summary}, note="already with Lead triage")

    if not c.needs_reply or not cfg.get("draft_replies", True) or not _recipient(inp):
        return Finish("filed", update={"summary": summary},
                      note=f"{c.category}; " + ("no reply needed" if not c.needs_reply else "replies are off"))
    return Goto("retrieve", update={"classification": c.model_dump(), "summary": summary, "input_sensitive": held},
                note=f"{c.category}, {c.urgency} urgency, reply needed")


@wf.step("retrieve", agent="retrieval")
async def retrieve(ctx: RunContext, state: dict) -> Goto:
    c = state["classification"]
    try:
        found = await ctx.invoke("knowledge.search", {"query": c["summary"] + " " + (state["input"].get("body") or "")[:500],
                                                      "k": 5, "kinds": ["upload", "drive", "note", "proposal"]})
        # Other people's emails are not a source for replies: an outsider could plant text that
        # would then be repeated to every later customer.
        hits = found["hits"]
    except Exception as exc:
        ctx.note(f"retrieval unavailable ({type(exc).__name__})")
        hits = []
    sources = [{"n": i + 1, "document_id": h["document_id"], "title": h["title"], "kind": h["kind"],
                "text": h["text"][:1200], "sensitive": bool(h.get("sensitive"))} for i, h in enumerate(hits[:5])]
    return Goto("draft", update={"sources": sources}, note=f"{len(sources)} knowledge source(s)")


@wf.step("draft", agent="inbox")
async def draft(ctx: RunContext, state: dict) -> Interrupt:
    inp, c, cfg = state["input"], state["classification"], await ctx.settings()
    channel = inp.get("channel") or "email"
    sources = state.get("sources", [])
    src_block = "\n\n".join(f"[{s['n']}] {s['title']} ({s['kind']})\n{s['text']}" for s in sources) or "(none)"
    biz = await ctx.business()
    lang = cfg.get("reply_language") or "same as the customer"
    system = (f"{await ctx.brief()}\nYou answer the business's {channel} messages. Reply as a helpful member of "
              f"{biz.name}. Use ONLY the facts in the sources; if they do not answer the question, say you will check "
              "and come back, and set unsure=true. Never invent prices, dates or commitments. "
              f"Language: {lang}. " + ("Keep it short, no subject line." if channel == "whatsapp"
                                       else f"Plain-text email, sign off as {biz.sign_off}."))
    feedback = state.get("feedback")
    prompt = (f"Message from {inp.get('from_name') or _recipient(inp)}:\n{(inp.get('body') or '')[:6000]}\n\n"
              f"Category: {c['category']}. Summary: {c['summary']}\n\nWhat the business knows (cite by number):\n{src_block}")
    if feedback:
        prompt += f"\n\nThe reviewer rejected the previous draft with this feedback — address it:\n{feedback}"
    sensitive = bool(state.get("input_sensitive")) or any(s.get("sensitive") for s in sources)
    r = await ctx.llm_json(tier="private" if sensitive else "reason", schema=Reply, system=system, prompt=prompt,
                           sensitive=sensitive)
    used = [s for s in sources if s["n"] in set(r.used_sources)]
    to = _recipient(inp)
    if channel == "whatsapp":
        action, payload = "whatsapp.send", {"to": to, "body": r.body.strip()}
    else:
        subject = r.subject.strip() or ("Re: " + (inp.get("subject") or "your message"))
        action, payload = "gmail.send", {"to": to, "subject": subject[:300], "body": biz.with_notice(r.body.strip()),
                                         "thread_id": inp.get("thread_id")}
    title = f"Reply to {inp.get('from_name') or to} ({c['category']})"
    summary = c["summary"][:200] + (" — the agent is not sure the sources answer this." if r.unsure else "")
    if used:
        summary += " Draws on: " + ", ".join(s["title"] for s in used)[:200]
    return Interrupt(
        ApprovalRequest(agent="inbox", action=action, key="reply_decision", title=title, summary=summary,
                        payload=payload, required_roles=("approver", "venture_admin"), sensitive=sensitive,
                        # quoting a past proposal to an outside sender always needs a person
                        always_review=any(s["kind"] == "proposal" for s in used)),
        resume="send", on_reject="rejected",
        update={"citations": [{"document_id": s["document_id"], "title": s["title"]} for s in used],
                "redrafts": state.get("redrafts", 0)},
        note=f"reply drafted citing {len(used)} source(s)" + (" (unsure)" if r.unsure else ""))


@wf.step("rejected", agent="inbox")
async def rejected(ctx: RunContext, state: dict) -> Goto | Finish:
    comment = ((state.get("reply_decision") or {}).get("comment") or "").strip()
    if comment and state.get("redrafts", 0) < 2:
        return Goto("draft", update={"feedback": comment, "redrafts": state.get("redrafts", 0) + 1},
                    note="rejected with feedback; redrafting")
    return Finish("not_sent")


@wf.step("send", agent="inbox")
async def send(ctx: RunContext, state: dict) -> Finish:
    d = state["reply_decision"]
    action = "whatsapp.send" if (state["input"].get("channel") == "whatsapp") else "gmail.send"
    res = await ctx.invoke(action, approval_id=d["approval_id"])
    return Finish("replied", update={"summary": {**state.get("summary", {}), "sent": res.get("status")}},
                  note=f"reply {res.get('status')} via {res.get('transport')}")


def message_input(*, channel: str, from_name: str | None, from_email: str | None = None,
                  from_phone: str | None = None, subject: str | None, body: str, message_id: str | None,
                  thread_id: str | None = None) -> dict[str, Any]:
    """Normalised input for an inbox_assistant run."""
    return {"channel": channel, "from_name": from_name, "from_email": from_email, "from_phone": from_phone,
            "subject": subject or "", "body": (body or "")[:20000], "message_id": message_id, "thread_id": thread_id}


__all__ = ["wf", "message_input", "CATEGORIES"]
