"""Answers to a customer's questions about their OWN records, built by code (the "answering machine",
customer side; docs/agents/answering-machine.md).

The inbox assistant's classifier only names the question (balance, pay_link, booking, shipment); this
module finds the records that belong to the person who wrote and writes the answer from them. A model
never writes a number, a date or a link here, and nothing about any other customer can be included:
every query is limited to the sender's verified identity:

  WhatsApp   the phone number Meta delivered the message from
  Telegram   the chat id Telegram delivered it from (bookings only: invoices carry no chat id)
  email      the From address, only when Gmail authenticated the sender's domain (sender_verified)

Matching a phone: the same digits, or the same last 10 digits when both sides have at least 10 (a number
saved as 98111 22233 on an invoice and delivered by WhatsApp as 919811122233).
"""
from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import text

Question = Literal["none", "balance", "pay_link", "booking", "shipment"]
QUESTIONS: tuple[str, ...] = ("balance", "pay_link", "booking", "shipment")
IST = ZoneInfo("Asia/Kolkata")
MAX_INVOICES = 5
MAX_BOOKINGS = 2
MAX_SHIPMENTS = 3
AUTO_PER_HOUR = 5        # automatic answers to one sender, per business, per hour; beyond that a person decides

TITLES = {"balance": "invoice balance", "pay_link": "payment link", "booking": "booking", "shipment": "shipment status"}


@dataclass
class Invoice:
    number: str
    balance_paise: int
    amount_paise: int
    due_on: date
    pay_url: str


@dataclass
class Booking:
    service: str
    starts_at: datetime


@dataclass
class Shipment:
    number: str
    reference: str | None
    stage: str
    vessel: str | None
    etd: date | None
    eta: date | None


@dataclass
class Facts:
    name: str | None = None
    invoices: list[Invoice] = field(default_factory=list)
    bookings: list[Booking] = field(default_factory=list)
    shipments: list[Shipment] = field(default_factory=list)


def digits(s: str | None) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def sender_key(venture_id: uuid.UUID, channel: str, address: str) -> str:
    """A stable, non-reversible tag for the sender (kept in the run summary for the hourly limit)."""
    return hashlib.sha256(f"{venture_id}|{channel}|{address.strip().lower()}".encode()).hexdigest()[:24]


def _phone_sql(col: str) -> str:
    """SQL matching column `col` (any formatting) against :p (digits): equal, or equal last 10 digits."""
    d = f"regexp_replace(coalesce({col}, ''), '[^0-9]', '', 'g')"
    return (f"({d} = :p OR (char_length({d}) >= 10 AND char_length(:p) >= 10"
            f" AND right({d}, 10) = right(:p, 10)))")


async def lookup(conn, venture_id: uuid.UUID, *, channel: str, phone: str | None = None,
                 email: str | None = None, chat_id: str | None = None, sender_verified: bool = False) -> Facts:
    """The sender's own open invoices, upcoming bookings and active shipments in this business."""
    from kritvia_api.routers.invoices import pay_url

    facts = Facts()
    p = digits(phone) if channel == "whatsapp" else ""
    e = (email or "").strip().lower() if channel == "email" and sender_verified and "@" in (email or "") else ""
    c = (chat_id or "").strip() if channel == "telegram" else ""
    if len(p) < 8:
        p = ""
    if not (p or e or c):
        return facts
    params: dict[str, Any] = {"v": venture_id, "p": p, "e": e, "c": c}

    # invoices: phone or email only (a Telegram chat id is never on an invoice)
    if p or e:
        who = " OR ".join(x for x in (_phone_sql("customer_phone") if p else "",
                                      "lower(customer_email) = :e" if e else "") if x)
        rows = (await conn.execute(text(
            "SELECT number, customer_name, amount_paise, paid_paise, due_on, pay_token FROM invoices"
            f" WHERE venture_id = :v AND status = 'open' AND amount_paise > paid_paise AND ({who})"
            f" ORDER BY due_on, created_at LIMIT {MAX_INVOICES}"), params)).all()
        for r in rows:
            facts.name = facts.name or r.customer_name
            facts.invoices.append(Invoice(number=r.number or "", balance_paise=r.amount_paise - r.paid_paise,
                                          amount_paise=r.amount_paise, due_on=r.due_on, pay_url=pay_url(r.pay_token)))

    # bookings: kept with the channel and address they were made on
    if p:
        bwho, bch = _phone_sql("address"), "whatsapp"
    elif c:
        bwho, bch = "address = :c", "telegram"
    else:
        bwho, bch = "lower(address) = :e", "email"
    params["bch"] = bch
    rows = (await conn.execute(text(
        "SELECT service_name, starts_at, customer_name FROM bookings"
        f" WHERE venture_id = :v AND status = 'confirmed' AND starts_at > now() AND channel = :bch AND {bwho}"
        f" ORDER BY starts_at LIMIT {MAX_BOOKINGS}"), params)).all()
    for r in rows:
        facts.name = facts.name or r.customer_name
        facts.bookings.append(Booking(service=r.service_name, starts_at=r.starts_at))

    # shipments: the buyer / supplier / client on the file
    if p or e:
        who = " OR ".join(x for x in (_phone_sql("party_phone") if p else "",
                                      "lower(party_email) = :e" if e else "") if x)
        rows = (await conn.execute(text(
            "SELECT number, reference, stage, vessel, etd, eta, party_name FROM shipments"
            f" WHERE venture_id = :v AND stage NOT IN ('closed', 'cancelled') AND ({who})"
            f" ORDER BY updated_at DESC LIMIT {MAX_SHIPMENTS}"), params)).all()
        for r in rows:
            facts.name = facts.name or r.party_name
            facts.shipments.append(Shipment(number=r.number, reference=r.reference, stage=r.stage, vessel=r.vessel,
                                            etd=r.etd, eta=r.eta))
    return facts


async def recent_auto_answers(conn, venture_id: uuid.UUID, key: str) -> int:
    """Automatic answers to this sender in the last hour."""
    return int((await conn.execute(text(
        "SELECT count(*) FROM workflow_runs WHERE venture_id = :v AND workflow = 'inbox_assistant'"
        " AND created_at > now() - interval '1 hour' AND summary->>'fact_to' = :k AND summary->>'fact_auto' = 'true'"),
        {"v": venture_id, "k": key})).scalar() or 0)


# ------------------------------------------------------------------------------------- wording --
def _rupees(paise: int) -> str:
    from kritvia_api.workflows.collections import rupees
    return rupees(paise)


def _day(d: date) -> str:
    return f"{d.day} {d.strftime('%b %Y')}"


def _when(t: datetime) -> str:
    t = t.astimezone(IST)
    return f"{t.day} {t.strftime('%b')}, {t.strftime('%I:%M %p').lstrip('0')}"


STAGES = {
    "en": {"order": "order received", "production": "in production", "booking": "space being booked",
           "documents": "documents being prepared", "customs": "at customs", "cleared": "cleared by customs",
           "duty_paid": "duty paid", "shipped": "shipped", "arrived": "arrived", "delivered": "delivered",
           "paid": "paid"},
    "hi": {"order": "ऑर्डर मिला", "production": "बन रहा है", "booking": "जगह बुक हो रही है",
           "documents": "कागज़ात तैयार हो रहे हैं", "customs": "कस्टम में", "cleared": "कस्टम से पास",
           "duty_paid": "ड्यूटी भरी गई", "shipped": "भेज दिया गया", "arrived": "पहुँच गया", "delivered": "डिलीवर हो गया",
           "paid": "भुगतान हो गया"},
    "hinglish": {"order": "order mil gaya", "production": "ban raha hai", "booking": "space book ho raha hai",
                 "documents": "documents ban rahe hain", "customs": "customs mein", "cleared": "customs se clear",
                 "duty_paid": "duty bhar di", "shipped": "bhej diya gaya", "arrived": "pahunch gaya",
                 "delivered": "deliver ho gaya", "paid": "payment ho gaya"},
}

T = {
    "en": {
        "hello": "Hello{name}, this is {biz}.",
        "owe": "Your open invoices:",
        "inv": "• {num}{bal} due{due}",
        "total": "Total due: {total}",
        "pay": "Pay here: {url}",
        "pay_one": "Pay {num} here: {url}",
        "links": "Payment links:",
        "book": "Your booking:",
        "book_n": "Your upcoming bookings:",
        "book_line": "• {svc}: {when}",
        "ship": "Your shipment:",
        "ship_n": "Your shipments:",
        "ship_line": "• {num}{ref}: {stage}{vessel}{dates}",
        "etd": ", leaves {d}", "eta": ", arrives {d}", "vessel": " ({v})",
        "bye": "For anything else, just reply and someone from our team will get back to you.",
        "due_on": " by {d}", "overdue": " (was due {d})", "inv_word": "Invoice",
    },
    "hi": {
        "hello": "नमस्ते{name}, {biz} से।",
        "owe": "आपके बकाया बिल:",
        "inv": "• {num}{bal} बाकी{due}",
        "total": "कुल बाकी: {total}",
        "pay": "यहाँ भुगतान करें: {url}",
        "pay_one": "{num} का भुगतान यहाँ करें: {url}",
        "links": "भुगतान के लिंक:",
        "book": "आपकी बुकिंग:",
        "book_n": "आपकी आने वाली बुकिंग:",
        "book_line": "• {svc}: {when}",
        "ship": "आपका शिपमेंट:",
        "ship_n": "आपके शिपमेंट:",
        "ship_line": "• {num}{ref}: {stage}{vessel}{dates}",
        "etd": ", रवाना {d}", "eta": ", पहुँचेगा {d}", "vessel": " ({v})",
        "bye": "कुछ और पूछना हो तो जवाब दें, हमारी टीम आपसे बात करेगी।",
        "due_on": ", {d} तक", "overdue": " ({d} को देय था)", "inv_word": "बिल",
    },
    "hinglish": {
        "hello": "Namaste{name}, {biz} se.",
        "owe": "Aapke baaki bills:",
        "inv": "• {num}{bal} baaki{due}",
        "total": "Kul baaki: {total}",
        "pay": "Yahan payment karein: {url}",
        "pay_one": "{num} ka payment yahan karein: {url}",
        "links": "Payment links:",
        "book": "Aapki booking:",
        "book_n": "Aapki aane wali bookings:",
        "book_line": "• {svc}: {when}",
        "ship": "Aapka shipment:",
        "ship_n": "Aapke shipments:",
        "ship_line": "• {num}{ref}: {stage}{vessel}{dates}",
        "etd": ", nikalega {d}", "eta": ", pahunchega {d}", "vessel": " ({v})",
        "bye": "Kuch aur poochna ho to reply karein, hamari team aapse baat karegi.",
        "due_on": ", {d} tak", "overdue": " ({d} ko due tha)", "inv_word": "Bill",
    },
}


def language(lang: str | None) -> str:
    lang = (lang or "").lower()
    return "hi" if lang in ("hi", "hindi") else "hinglish" if lang == "hinglish" else "en"


def compose(question: str, facts: Facts, lang: str | None, business: str, *, today: date | None = None) -> str | None:
    """The answer, or None when the records have nothing for this question (the normal draft runs instead)."""
    L = language(lang)
    t = T[L]
    today = today or datetime.now(IST).date()
    first = (facts.name or "").split()[0] if (facts.name or "").strip() else ""
    head = t["hello"].format(name=f" {first}" if first else "", biz=business)
    lines: list[str] = []
    if question in ("balance", "pay_link"):
        if not facts.invoices:
            return None

        def num(i: Invoice) -> str:
            return i.number or t["inv_word"]
        if question == "balance":
            lines.append(t["owe"])
            for i in facts.invoices:
                due = (t["overdue"] if i.due_on < today else t["due_on"]).format(d=_day(i.due_on))
                lines.append(t["inv"].format(num=num(i), bal=f": {_rupees(i.balance_paise)}", due=due))
            if len(facts.invoices) > 1:
                lines.append(t["total"].format(total=_rupees(sum(i.balance_paise for i in facts.invoices))))
        if len(facts.invoices) == 1:
            i = facts.invoices[0]
            lines.append(t["pay"].format(url=i.pay_url) if question == "balance"
                         else t["pay_one"].format(num=f"{num(i)} ({_rupees(i.balance_paise)})", url=i.pay_url))
        else:
            lines.append(t["links"])
            lines += [f"• {num(i)} ({_rupees(i.balance_paise)}): {i.pay_url}" for i in facts.invoices]
    elif question == "booking":
        if not facts.bookings:
            return None
        lines.append(t["book"] if len(facts.bookings) == 1 else t["book_n"])
        lines += [t["book_line"].format(svc=b.service, when=_when(b.starts_at)) for b in facts.bookings]
    elif question == "shipment":
        if not facts.shipments:
            return None
        lines.append(t["ship"] if len(facts.shipments) == 1 else t["ship_n"])
        for s in facts.shipments:
            dates = ""
            if s.etd and s.stage in ("order", "production", "booking", "documents", "customs", "cleared", "duty_paid"):
                dates += t["etd"].format(d=_day(s.etd))
            if s.eta and s.stage not in ("arrived", "delivered", "paid"):
                dates += t["eta"].format(d=_day(s.eta))
            lines.append(t["ship_line"].format(num=s.number, ref=f" ({s.reference})" if s.reference else "",
                                               stage=STAGES[L].get(s.stage, s.stage),
                                               vessel=t["vessel"].format(v=s.vessel) if s.vessel else "",
                                               dates=dates))
    else:
        return None
    return "\n".join([head, "", *lines, "", t["bye"]])[:3500]


__all__ = ["Facts", "QUESTIONS", "TITLES", "AUTO_PER_HOUR", "lookup", "compose", "sender_key",
           "recent_auto_answers", "language", "digits"]
