"""Payment reminders: polite, approved reminders for unpaid invoices.

Every day at the time the owner picks:

  daily:  find   open invoices whose next reminder is due (not paused, money still owed, fewer than
                 `max_reminders` sent) -> one `touch` run each.
  touch:  draft  email: subject and text written from the invoice's facts -> [approval: gmail.send]
                 WhatsApp (no email, but the customer chats with the business on WhatsApp and a
                 reminder template is chosen): the template's blanks filled in -> [approval:
                 whatsapp.template]
          sent   sends it and counts it.

When reminders go out:
  1. `days_before` days before the due date (0: none before), a friendly heads-up;
  2. the day after the due date;
  3. then every `repeat_days` days while it stays unpaid, up to `max_reminders` in all.
A reminder turned down moves the next one on by the same rhythm. Recording a payment stops them;
pausing an invoice (a promise to pay, a dispute) stops them until it is un-paused.

Every amount and date in a reminder comes from the invoice, formatted by code. An email that quotes any
other amount always waits for a person, whatever the agent's trust.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Option, Workflow, registry
from kritvia_api.services import pii, wa_templates
from kritvia_api.workflows.common import CURRENCY_IN_TEXT, IST

wf = registry.register(Workflow(
    "collections", title="Payment reminders", start="route",
    trigger="Every day at the time you set",
    description="Reminds customers about unpaid invoices: a friendly note before the due date, then polite "
                "reminders while it stays unpaid, by email or WhatsApp. Every reminder waits for your yes; "
                "recording a payment stops them.",
    options=(
        Option("days_before", "First reminder this many days before the due date", "number", 2, min=0, max=14,
               help="0: no reminder before the due date."),
        Option("repeat_days", "Then every this many days while unpaid", "number", 7, min=1, max=30),
        Option("max_reminders", "At most this many reminders per invoice", "number", 4, min=1, max=10),
        Option("how_to_pay", "How customers can pay", "text", "",
               help="Put in every reminder, e.g. 'UPI sitelytc@okicici, or bank transfer to HDFC 50200012345678, "
                    "IFSC HDFC0000123'."),
        Option("whatsapp_template", "WhatsApp template for reminders (optional)", "text", "",
               help="Its name on WhatsApp → Templates. Used for customers without an email who chat with you on "
                    "WhatsApp, e.g. 'Hi {{1}}, a reminder that ₹{{2}} for invoice {{3}} was due on {{4}}.'"),
    )))

MAX_PER_DAY = 40


class Email(BaseModel):
    subject: str = Field(description="under 70 characters")
    body: str = Field(description="plain text, 50-120 words, no signature block")


class Fill(BaseModel):
    params: list[str] = Field(default_factory=list, description="the text for each blank, in order")


def rupees(paise: int) -> str:
    """1180050 -> '₹11,800.50'; whole rupees drop the paise. Indian digit grouping."""
    r, p = divmod(int(paise), 100)
    s = str(r)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    return f"₹{s}" + (f".{p:02d}" if p else "")


def amounts(text_: str) -> set[str]:
    """Money amounts in a text, normalised ('₹11,800.00' and 'Rs. 11800' are the same)."""
    out = set()
    for m in CURRENCY_IN_TEXT.finditer(text_ or ""):
        raw = m.group(0).lower()
        digits = re.sub(r"[^\d.]", "", re.sub(r"^(?:₹|rs\.?|inr)", "", raw.strip()))
        unit = re.search(r"(lakh|lakhs|cr|crore|k)$", raw.strip())
        try:
            value = f"{float(digits.strip('.')):.2f}" if digits.strip(".") else raw
        except ValueError:
            value = raw
        out.add(value + (unit.group(1) if unit else ""))
    return out


def nice_date(d: date) -> str:
    return f"{d.day} {d:%b %Y}"


def _num(cfg: dict[str, Any], key: str, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(cfg.get(key, default))))
    except (TypeError, ValueError):
        return default


def next_reminder(due_on: date, last: datetime | None, cfg: dict[str, Any]) -> date:
    """The day the next reminder is due for an open invoice."""
    before, repeat = _num(cfg, "days_before", 0, 14, 2), _num(cfg, "repeat_days", 1, 30, 7)
    if last is None:
        return due_on - timedelta(days=before) if before else due_on + timedelta(days=1)
    last_day = last.astimezone(IST).date()
    if last_day <= due_on:
        return due_on + timedelta(days=1)
    return last_day + timedelta(days=repeat)


CANDIDATES = (
    "SELECT id, due_on, last_reminder_at, reminders_sent FROM invoices"
    " WHERE venture_id = :v AND status = 'open' AND NOT reminders_paused AND paid_paise < amount_paise"
    "   AND reminders_sent < :maxr AND due_on <= :horizon"
    "   AND (customer_email IS NOT NULL OR customer_phone IS NOT NULL)")


@wf.step("route", agent="collections")
async def route(ctx: RunContext, state: dict) -> Goto:
    return Goto("draft" if (state["input"] or {}).get("mode") == "touch" else "find")


@wf.step("find", agent="collections")
async def find(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    cfg = await ctx.settings()
    today = datetime.now(IST).date()
    async with ctx.tx() as conn:
        rows = (await conn.execute(text(CANDIDATES + " ORDER BY due_on LIMIT 500"), {
            "v": ctx.venture_id, "maxr": _num(cfg, "max_reminders", 1, 10, 4),
            "horizon": today + timedelta(days=_num(cfg, "days_before", 0, 14, 2))})).all()
    due = [r for r in rows if next_reminder(r.due_on, r.last_reminder_at, cfg) <= today][:MAX_PER_DAY]
    started = 0
    for r in due:
        try:
            await start_run(ctx.services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                            workflow="collections", trigger_kind="schedule",
                            dedupe=("collections", f"{r.id}:{r.reminders_sent}:{r.last_reminder_at or 'first'}"),
                            title="Payment reminder", input={"mode": "touch", "invoice_id": str(r.id)})
            started += 1
        except DuplicateTrigger:
            continue
    return Finish("found", update={"summary": {"reminders": started}}, note=f"{started} reminder(s) to write")


async def _invoice(ctx: RunContext, invoice_id: str):
    async with ctx.tx() as conn:
        return (await conn.execute(text(
            "SELECT id, number, customer_name, customer_email, customer_phone, amount_paise, paid_paise, issued_on,"
            " due_on, status, reminders_paused, reminders_sent, last_reminder_at, pay_token,"
            " EXISTS (SELECT 1 FROM venture_payment_settings s WHERE s.venture_id = invoices.venture_id"
            "         AND s.upi_id IS NOT NULL)"
            " OR EXISTS (SELECT 1 FROM connectors c WHERE c.venture_id = invoices.venture_id"
            "            AND c.provider = 'razorpay' AND c.status = 'active') AS payable FROM invoices"
            " WHERE id = :id AND venture_id = :v"), {"id": uuid.UUID(invoice_id), "v": ctx.venture_id})).first()


def _still_due(inv, cfg: dict[str, Any]) -> bool:
    return bool(inv and inv.status == "open" and not inv.reminders_paused and inv.paid_paise < inv.amount_paise
                and inv.reminders_sent < _num(cfg, "max_reminders", 1, 10, 4))


@wf.step("draft", agent="collections")
async def draft(ctx: RunContext, state: dict) -> Interrupt | Finish:
    cfg = await ctx.settings()
    inv = await _invoice(ctx, state["input"]["invoice_id"])
    if not _still_due(inv, cfg):
        return Finish("nothing_to_remind", note="paid, paused or cancelled meanwhile, or enough reminders sent")
    today = datetime.now(IST).date()
    balance = inv.amount_paise - inv.paid_paise
    late = (today - inv.due_on).days
    number = inv.number or "your invoice"
    facts = {
        "customer": inv.customer_name, "invoice": number, "amount": rupees(balance),
        "due": nice_date(inv.due_on), "partly_paid": bool(inv.paid_paise),
    }
    last = inv.reminders_sent + 1 >= _num(cfg, "max_reminders", 1, 10, 4)
    if late < 0:
        stage = f"A friendly heads-up: the invoice is due in {-late} day(s), on {facts['due']}."
    elif late == 0:
        stage = f"The invoice is due today, {facts['due']}."
    else:
        stage = (f"The invoice is {late} day(s) overdue (it was due on {facts['due']}). Polite and clear, never "
                 "rude or threatening." + (" This is the last reminder: ask them to reply if there is a problem "
                                           "with the invoice or if they need more time." if last else ""))
    how = str(cfg.get("how_to_pay") or "").strip()
    # The invoice's payment page (UPI QR, and card/netbanking when the business has Razorpay).
    from kritvia_api.routers.invoices import pay_url
    link = pay_url(inv.pay_token) if inv.payable else None
    biz = await ctx.business()
    update = {"invoice_id": str(inv.id), "balance": balance}

    if inv.customer_email:
        system = (f"{await ctx.brief()}\nYou write short, warm payment reminders from {biz.name} to its customers. "
                  "Use only the facts given. Quote the amount, invoice number and due date exactly as written; "
                  "never mention any other amount, fee, interest or penalty. Write in simple English (or Hinglish "
                  "if the business's instructions say so). Ask them to ignore the reminder if they've already paid.")
        prompt = (f"{stage}\nCustomer: {facts['customer']}\nInvoice: {facts['invoice']}\n"
                  f"Amount still due: {facts['amount']}" + (" (part of it has been paid)" if facts["partly_paid"] else "")
                  + f"\nDue date: {facts['due']}\n" + (f"How to pay: {how}\n" if how else "")
                  + (f"Payment link (paste it exactly): {link}\n" if link else "")
                  + f"Sign as {biz.sign_off}.")
        e = await ctx.llm_json(tier="reason", schema=Email, system=system, prompt=prompt)
        body = e.body.strip()
        if link and link not in body:
            body += f"\n\nPay online: {link}"
        if how and how not in body:
            body += f"\n\nHow to pay: {how}"
        body = biz.with_notice(f"{body}\n\n{biz.sign_off}")
        # Any amount other than the one owed (or one in the owner's payment details) is the model's guess.
        guessed = sorted(amounts(e.subject + " " + body) - amounts(facts["amount"] + " " + how))
        subject = (e.subject.strip() or f"Payment reminder: {number}")[:120]
        return Interrupt(
            ApprovalRequest(
                agent="collections", action="gmail.send", key="send_decision",
                title=f"Payment reminder to {inv.customer_name}"[:140],
                summary=(f"{facts['amount']} for {number}, " + (f"{late} day(s) overdue" if late > 0 else
                         ("due today" if late == 0 else f"due on {facts['due']}"))
                         + f". Reminder {inv.reminders_sent + 1}."
                         + (" It mentions another amount; check it." if guessed else ""))[:300],
                payload={"to": inv.customer_email, "subject": subject, "body": body, "thread_id": None},
                required_roles=("approver", "venture_admin"), always_review=bool(guessed), expires_in_hours=48),
            resume="sent", on_reject="skipped", update={**update, "action": "gmail.send"},
            note=f"email reminder drafted ({'overdue' if late > 0 else 'before due'})")

    # No email: an approved WhatsApp template, only to a customer who chats with the business.
    name = str(cfg.get("whatsapp_template") or "").strip()
    if not (inv.customer_phone and name):
        await _postpone(ctx, inv.id)
        return Finish("no_way_to_reach", note="add the customer's email, or choose a WhatsApp reminder template "
                                              "(customers who chat with you on WhatsApp)")
    problem = None
    async with ctx.tx() as conn:
        t = await wa_templates.by_name(conn, ctx.venture_id, name)
        try:
            await wa_templates.recipient(conn, ctx.venture_id, inv.customer_phone)
            if t is None:
                raise wa_templates.TemplateProblem(f"there is no template called '{name}' on WhatsApp → Templates")
            if t.status != "APPROVED" or not t.sendable:
                raise wa_templates.TemplateProblem(f"the template '{t.title}' isn't approved for sending yet")
        except wa_templates.TemplateProblem as exc:
            problem = str(exc)
    if problem or t is None:
        await _postpone(ctx, inv.id)
        return Finish("no_way_to_reach", note=f"WhatsApp reminder not possible: {problem or 'no template'}"[:300])
    params: list[str] = []
    if t.params:
        info = "\n".join(f"{k}: {v}" for k, v in facts.items())
        sensitive = pii.mask(info).sensitive
        samples = ", ".join(f"{{{{{i + 1}}}}} = {x}" for i, x in enumerate(t.examples)) or "none given"
        f = await ctx.llm_json(
            tier="private" if sensitive else "extract", schema=Fill, sensitive=sensitive,
            system=(f"You fill in the blanks of {biz.name}'s approved WhatsApp payment reminder. Use only the facts "
                    "given, copied exactly (the amount with its ₹ sign, the invoice number, the date). Each blank is "
                    "one short line."),
            prompt=f"Template:\n{t.body}\nSample blanks: {samples}\n\nFacts:\n{info}\n\nGive exactly {t.params} blank(s).")
        params = f.params
    try:
        body, params = wa_templates.render(t, params)
    except wa_templates.TemplateProblem as exc:
        return Finish("could_not_fill", note=str(exc)[:300])
    if amounts(body) - amounts(facts["amount"]):
        return Finish("could_not_fill", note="the filled-in template quoted a different amount; nothing was drafted")
    return Interrupt(
        ApprovalRequest(
            agent="collections", action="whatsapp.template", key="send_decision",
            title=f"WhatsApp payment reminder to {inv.customer_name}"[:140],
            summary=f"{facts['amount']} for {number}. Reminder {inv.reminders_sent + 1}, with your template '{t.title}'."[:300],
            payload={"to": inv.customer_phone, "template": t.title, "template_id": str(t.id), "language": t.language,
                     "params": params, "body": body},
            required_roles=("approver", "venture_admin"), expires_in_hours=48),
        resume="sent", on_reject="skipped", update={**update, "action": "whatsapp.template"},
        note="WhatsApp reminder drafted")


async def _postpone(ctx: RunContext, invoice_id) -> None:
    """Nothing sent: the next try follows the usual rhythm instead of tomorrow."""
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE invoices SET last_reminder_at = now(), updated_at = now()"
                                " WHERE id = :id AND venture_id = :v"), {"id": invoice_id, "v": ctx.venture_id})


@wf.step("sent", agent="collections")
async def sent(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.tools import AlreadyExecuted
    cfg = await ctx.settings()
    inv = await _invoice(ctx, state["invoice_id"])
    # Paid (or paused) while the reminder waited: it is not sent.
    if not _still_due(inv, cfg) or inv.amount_paise - inv.paid_paise != state["balance"]:
        return Finish("not_needed", note="the invoice was paid, changed or paused before the reminder went out")
    try:
        res = await ctx.invoke(state["action"], approval_id=state["send_decision"]["approval_id"])
    except AlreadyExecuted as done:
        res = (done.args[0] if done.args else None) or {}
    async with ctx.tx() as conn:
        await conn.execute(text(
            "UPDATE invoices SET reminders_sent = reminders_sent + 1, last_reminder_at = now(), updated_at = now()"
            " WHERE id = :id AND venture_id = :v AND reminders_sent < 50"), {"id": inv.id, "v": ctx.venture_id})
    return Finish("reminded", update={"summary": {"sent": res.get("status"), "channel": state["action"]}},
                  note=f"reminder {res.get('status')} via {res.get('transport')}")


@wf.step("skipped", agent="collections")
async def skipped(ctx: RunContext, state: dict) -> Finish:
    """Turned down: the next reminder follows the usual rhythm."""
    await _postpone(ctx, uuid.UUID(state["invoice_id"]))
    return Finish("not_sent")


__all__ = ["wf", "rupees", "next_reminder", "nice_date"]
