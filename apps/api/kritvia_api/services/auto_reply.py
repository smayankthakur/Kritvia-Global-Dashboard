"""Replying by itself (the inbox assistant's `auto_reply` option): the answering machine's "every message" mode.

The owner switches it on per business and per channel (WhatsApp, Telegram, email). Then a customer's message
gets an answer straight away, written in a warm, human voice in the customer's own language, with these limits:

* Money promises and complaints still come to the owner: a price, discount or offer that isn't in the
  business's records, a refund or payment dispute, a deal or commitment, a complaint, or a reply the agent is
  unsure of. The model says so (Reply.needs_owner) AND code checks every amount and percentage in the draft
  against the sources, rate card, booking prices and the customer's own records (`unknown_amounts`). The
  customer then gets a short holding message written by code ("let me check with the team"), the team is told,
  and the real draft waits for a yes as before.
* Loops and floods: an acknowledgement ("ok", "thanks") gets no automatic reply if the business answered this
  person by itself in the last 10 minutes; at most 15 automatic replies per person an hour and 500 per business
  a day, then drafts wait for a yes again.
* Never: spam, notifications, mail from automated senders, people who wrote STOP, chats a person took over,
  runs the injection guard flagged, messages with ID or card numbers (the runner withholds those), or a
  reply that quotes internal documents to an unchecked email sender.
* Honesty: it never says it is a person. Asked sincerely whether it's a bot, it says it is the business's AI
  assistant and offers a person.
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Iterable
from typing import Any, Literal

from sqlalchemy import text

CHANNELS = ("whatsapp", "telegram", "email")
TONES = ("warm", "professional", "playful")
PER_CONTACT_HOUR = 15
PER_BUSINESS_DAY = 500
PER_CONTACT_SEEN_HOUR = 30      # more messages than this from one sender in an hour: a machine, not a person
ACK_QUIET_MINUTES = 10
REASONS = ("price_not_on_record", "discount_or_offer", "refund_or_payment_dispute", "commitment_or_deal",
           "complaint", "unsure", "order_booking_payment", "internal_source", "claims_human")
Reason = Literal["price_not_on_record", "discount_or_offer", "refund_or_payment_dispute", "commitment_or_deal",
                 "complaint", "unsure"]
REASON_WORDS = {
    "price_not_on_record": "a price that isn't in your records",
    "discount_or_offer": "a discount or offer",
    "refund_or_payment_dispute": "a refund or payment dispute",
    "commitment_or_deal": "a promise or deal",
    "complaint": "a complaint",
    "unsure": "something the agent wasn't sure of",
    # set by code, not by the model
    "order_booking_payment": "an order, booking or payment",
    "internal_source": "your own documents or notes",
    "claims_human": "a reply that sounds like a person wrote it",
}
# Reasons the customer hears "sorry, the team will get back to you" for, and "got it, confirming" for.
SORRY_REASONS = ("complaint", "refund_or_payment_dispute")
CONFIRM_REASONS = ("order_booking_payment", "commitment_or_deal")


def hold_kind(reasons: Iterable[str]) -> str:
    """Which holding line the customer gets while the owner looks at the reply."""
    rs = set(reasons)
    if rs & set(SORRY_REASONS):
        return "sorry"
    if rs & set(CONFIRM_REASONS):
        return "confirm"
    return "check"


# ------------------------------------------------------------------------------------- settings --
def channel_of(channel: str | None) -> str:
    return channel if channel in ("whatsapp", "telegram") else "email"


def channels(cfg: dict[str, Any]) -> set[str]:
    """The channels it answers on by itself; all three when the owner didn't narrow it."""
    v = cfg.get("auto_reply_channels")
    if v is None:
        return set(CHANNELS)
    if not isinstance(v, list):
        return set()
    return {str(x) for x in v} & set(CHANNELS)


def enabled(cfg: dict[str, Any], channel: str | None) -> bool:
    return cfg.get("auto_reply") is True and channel_of(channel) in channels(cfg)


def tone(cfg: dict[str, Any]) -> str:
    t = str(cfg.get("reply_tone") or "warm").lower()
    return t if t in TONES else "warm"


# --------------------------------------------------------------------------------------- voice --
_TONE = {
    "warm": "Warm and friendly, like a helpful person at the shop who enjoys chatting; a little light humour "
            "is welcome when it fits.",
    "professional": "Polite and professional, courteous and to the point; no jokes, no slang.",
    "playful": "Fun and playful, with plenty of personality and a joke when it fits, but always kind and clear.",
}


def persona(business: str, channel: str, tone_name: str, *, ack: bool = False) -> str:
    """The voice for replies sent by themselves. The honesty rule is part of it, always."""
    chat = channel in ("whatsapp", "telegram")
    out = (
        f" You are writing as {business}'s assistant, and your reply is sent straight to the customer. "
        f"Tone: {_TONE.get(tone_name, _TONE['warm'])} Sound natural and human: no stiff phrases, no lists unless "
        "they help. Mirror the customer's language: Hindi in Devanagari if they wrote Hindi, Hinglish in Roman "
        "letters if they wrote Hinglish, English if they wrote English. Use emojis only if the customer used them. "
        + ("Keep it short, like a WhatsApp message: one to three sentences unless they asked for more. "
           if chat else "An email can be a little fuller, but keep it brief and friendly. ")
        + "Small talk is welcome: answer it kindly and naturally, then gently steer back to how "
        f"{business} can help. Stay about this business: if they ask for something unrelated (essays, homework, "
        f"code, general knowledge, other companies), say politely that you can only help with {business}'s "
        "products and services. "
        "HONESTY: never say or suggest you are a human. If the customer sincerely asks whether they are talking "
        f"to a bot, an AI or a real person, say you are {business}'s AI assistant and offer to get a person from "
        "the team. "
        "Never invent prices, discounts, offers, stock, timings, delivery dates or policies: use only the "
        "sources, the rate card, the listed free times and the customer's own records. "
        "Set needs_owner=true, with owner_reason, when your reply would quote a price that is not in what you "
        "were given (price_not_on_record), give or discuss a discount or special offer (discount_or_offer), deal "
        "with a refund or a payment dispute (refund_or_payment_dispute), promise something or agree a deal, a "
        "custom job, a date or a contract (commitment_or_deal), answer a complaint or an upset customer "
        "(complaint), or when you are not sure (unsure). Still write the best reply for the owner to check.")
    if ack:
        out += (" The customer's message is a greeting, thanks or a short acknowledgement: reply with one short, "
                "friendly line, and don't ask questions they didn't invite.")
    return out


# ------------------------------------------------------------------------------- holding lines --
_HOLD = {
    "check": {"en": "Let me check this with the team and get back to you shortly.",
              "hi": "हम टीम से पूछकर जल्द ही आपको बताते हैं।",
              "hinglish": "Hum team se check karke aapko jaldi batate hain."},
    "person": {"en": "I've passed this to the team; someone will reply to you soon.",
               "hi": "हमने यह बात टीम तक पहुँचा दी है; जल्द ही कोई आपसे बात करेगा।",
               "hinglish": "Humne ye baat team tak pahuncha di hai, jaldi koi aapse baat karega."},
    "sorry": {"en": "Sorry about this! I've passed it to {business}'s team, and someone will get back to you personally soon.",
              "hi": "इसके लिए माफ़ी चाहते हैं! हमने यह बात {business} की टीम तक पहुँचा दी है, जल्द ही कोई आपसे खुद बात करेगा।",
              "hinglish": "Iske liye sorry! Humne ye baat {business} ki team tak pahuncha di hai, jaldi koi aapse personally baat karega."},
    "confirm": {"en": "Got it! Let me confirm this with the team and get right back to you.",
                "hi": "समझ गए! हम टीम से पक्का करके तुरंत आपको बताते हैं।",
                "hinglish": "Samajh gaye! Team se confirm karke turant aapko batate hain."},
    "lead": {"en": "Thanks for reaching out! We'll send you the details and a quote shortly.",
             "hi": "संपर्क करने के लिए धन्यवाद! हम जल्द ही आपको पूरी जानकारी और कोटेशन भेजेंगे।",
             "hinglish": "Contact karne ke liye thanks! Hum jaldi hi aapko details aur quote bhejenge."},
}
_EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿\U0001F1E6-\U0001F1FF]")


def uses_emoji(s: str | None) -> bool:
    return bool(_EMOJI.search(s or ""))


def holding(kind: str, lang: str, *, emoji: bool, business: str | None = None) -> str:
    """The fixed line the customer gets while the owner looks at it (written by code, never by AI)."""
    lines = _HOLD.get(kind, _HOLD["check"])
    line = lines.get(lang, lines["en"]).replace("{business}", (business or "our").strip()[:80])
    return line + (" 🙏" if emoji else "")


# A reply that says (or strongly suggests) a person wrote it. The assistant may say it will get a person;
# it may never say it is one.
_HUMAN = re.compile(
    r"\bi\s*(?:'|’)?\s*a?m\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+|living\s+)?(?:human|person|man|woman|girl|boy|"
    r"human\s+being)\b"
    r"|\b(?:i\s*(?:'|’)?\s*a?m|this\s+is)\s+not\s+(?:a\s+|an\s+)?(?:bot|robot|ai|a\.i\.|machine|chatbot|computer)\b"
    r"|\bmain\s+(?:ek\s+)?(?:asli\s+|real\s+)?(?:insaan|insan|insaan\s+hoon|human|aadmi|ladki|ladka)\b"
    r"|\b(?:main\s+)?(?:koi\s+)?(?:bot|robot|ai|machine)\s+nahi(?:n)?\s+(?:hoon|hu|hun|hai)\b"
    r"|मैं\s+(?:एक\s+)?(?:असली\s+)?(?:इंसान|मनुष्य|आदमी|लड़की|लड़का)"
    r"|(?:बॉट|रोबोट|मशीन|एआई)\s+नहीं\s+(?:हूँ|हूं|हू)",
    re.I)


def claims_human(body: str | None) -> bool:
    """True when the reply claims to be a person: it then waits for the owner instead of going out."""
    return bool(_HUMAN.search(body or ""))


# ------------------------------------------------------------------------------------ senders --
_NO_REPLY = re.compile(r"^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]daemon|postmaster|bounce[s]?|"
                       r"notifications?|alerts?|news(letter)?)([+@._-]|$)", re.I)


def automated_sender(email: str | None, headers: dict[str, str] | None = None) -> bool:
    """Mail a machine sent (no-reply addresses, bounces, newsletters, auto-replies): never answered by itself."""
    local = (email or "").split("@", 1)[0]
    if local and _NO_REPLY.match(local):
        return True
    h = {k.lower(): str(v) for k, v in (headers or {}).items()}
    if h.get("auto-submitted", "no").strip().lower() not in ("", "no"):
        return True
    if h.get("precedence", "").strip().lower() in ("bulk", "list", "junk", "auto_reply"):
        return True
    return any(k in h for k in ("list-unsubscribe", "list-id", "x-autoreply", "x-autorespond", "x-auto-response-suppress"))


# ------------------------------------------------------------------------------------ amounts --
_MULT = {"k": 1_000, "lakh": 100_000, "lakhs": 100_000, "lac": 100_000, "lacs": 100_000, "cr": 10_000_000,
         "crore": 10_000_000, "crores": 10_000_000}
_CUR_PRE = r"(?:₹|rs\.?|inr|rupees?|rupa(?:y|iy)[ae]?|रु\.?|रुपये|रुपए|रुपया)"
_CUR_POST = r"(?:rupees?|rupa(?:y|iy)[ae]?|rs\.?|inr|/-|रुपये|रुपए|रुपया)"
_NUM = r"(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?|cr)?\b"
_MONEY = re.compile(rf"{_CUR_PRE}\s*{_NUM}(?:\s*{_CUR_POST})?|{_NUM}\s*{_CUR_POST}", re.I)
_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|percent\b|per cent\b|pratishat\b|प्रतिशत)", re.I)
_ANY_NUM = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*(k|lakhs?|lacs?|crores?|cr)?\b", re.I)


def _paise(num: str, mult: str | None) -> int | None:
    try:
        v = float(num.replace(",", ""))
    except ValueError:
        return None
    return round(v * _MULT.get((mult or "").lower(), 1) * 100)


def amounts_in(s: str) -> list[tuple[str, int]]:
    """Money mentioned in a text: (as written, paise)."""
    out = []
    for m in _MONEY.finditer(s or ""):
        num, mult = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
        p = _paise(num, mult)
        if p is not None:
            out.append((m.group(0).strip(), p))
    return out


def known_values(texts: Iterable[str], paise: Iterable[int] = ()) -> tuple[set[int], set[float]]:
    """Every amount (any number, read as rupees) and percentage that appears in what the agent was given."""
    money, pct = set(int(p) for p in paise if p is not None), set()
    for t in texts:
        for m in _ANY_NUM.finditer(t or ""):
            p = _paise(m.group(1), m.group(2))
            if p is not None:
                money.add(p)
        for m in _PERCENT.finditer(t or ""):
            pct.add(float(m.group(1)))
    return money, pct


# A number written without ₹ but next to a price word ("the price is 500", "costs 1,200 per kg",
# "500 rupaye lagenge", "daam 450 hai") is money too.
_PRICE_WORD = (r"(?:price[sd]?|pricing|cost[s]?|costing|rate[s]?|charge[sd]?|charges|fee[s]?|total|amount|"
               r"pay(?:able)?|mrp|budget|quote[ds]?|tariff|daam|dam|keemat|kimat|kharcha|kharch|lagega|lagegi|"
               r"lagenge|lagta|padega|padegi|कीमत|दाम|शुल्क|खर्च|खर्चा|लगेगा|लगेगी|लगेंगे|भाड़ा)")
_PRICE_BEFORE = re.compile(rf"\b{_PRICE_WORD}\b[^\d\n]{{0,25}}?{_NUM}", re.I)
_PRICE_AFTER = re.compile(rf"{_NUM}\s*(?:/-\s*)?(?:per|/)\s*"          # "500 per kg", "500/plate" (a rate)
                          r"(?:kg|kilo|plate|piece|pcs|pc|unit|hour|hr|day|month|night|person|head|box|litre|liter|"
                          r"gram|gm|dozen|sq\.?\s?ft|page|visit|session)\b", re.I)
_PRICE_AFTER_WORD = re.compile(rf"{_NUM}\s*(?:/-)?\s*\b{_PRICE_WORD}\b", re.I)


def price_amounts_in(s: str) -> list[tuple[str, int]]:
    """Bare numbers that the text presents as a price (no ₹ sign), as (as written, paise)."""
    out = []
    for rx in (_PRICE_BEFORE, _PRICE_AFTER, _PRICE_AFTER_WORD):
        for m in rx.finditer(s or ""):
            p = _paise(m.group(1), m.group(2))
            if p is not None:
                out.append((m.group(0).strip(), p))
    return out


def unknown_amounts(body: str, known: tuple[set[int], set[float]]) -> list[str]:
    """Amounts and percentages in a draft that aren't in the business's records: a money promise for the owner."""
    money, pct = known
    out = [w for w, p in amounts_in(body) if p not in money]
    out += [w for w, p in price_amounts_in(body) if p not in money and w not in out]
    out += [m.group(0).strip() for m in _PERCENT.finditer(body or "") if float(m.group(1)) not in pct]
    return out


async def known_from_records(conn, venture_id: uuid.UUID) -> tuple[list[str], list[int]]:
    """The rate card and booking prices: lines the reply may quote from (also shown to the model), and paise."""
    lines, paise = [], []
    for r in (await conn.execute(text(
            "SELECT name, unit, rate_inr, min_units FROM rate_cards WHERE venture_id = :v AND active ORDER BY name"
            " LIMIT 60"), {"v": venture_id})).all():
        rate, mins = float(r.rate_inr), float(r.min_units)
        paise += [int(round(rate * 100)), int(round(rate * mins * 100))]
        lines.append(f"{r.name}: ₹{rate:,.0f} per {r.unit}" + (f" (at least {mins:g})" if mins != 1 else ""))
    try:
        async with conn.begin_nested():
            rows = (await conn.execute(text(
                "SELECT name, price_paise FROM booking_services WHERE venture_id = :v AND price_paise IS NOT NULL"
                " LIMIT 40"), {"v": venture_id})).all()
        for r in rows:
            paise.append(int(r.price_paise))
            lines.append(f"{r.name}: ₹{r.price_paise / 100:,.0f}")
    except Exception:  # noqa: BLE001 - a business without bookings
        pass
    return lines, paise


# ------------------------------------------------------------------------------------- limits --
async def recent(conn, venture_id: uuid.UUID, key: str, minutes: int) -> int:
    """Replies this business sent this person by itself in the last `minutes`."""
    return int((await conn.execute(text(
        "SELECT count(*) FROM workflow_runs WHERE venture_id = :v AND workflow = 'inbox_assistant'"
        " AND created_at > now() - make_interval(mins => :m) AND summary->>'auto_to' = :k"
        " AND summary->>'auto_sent' = 'true'"), {"v": venture_id, "k": key, "m": minutes})).scalar() or 0)


async def today(conn, venture_id: uuid.UUID) -> int:
    """Replies this business sent by itself in the last 24 hours."""
    return int((await conn.execute(text(
        "SELECT count(*) FROM workflow_runs WHERE venture_id = :v AND workflow = 'inbox_assistant'"
        " AND created_at > now() - interval '24 hours' AND summary->>'auto_sent' = 'true'"),
        {"v": venture_id})).scalar() or 0)


async def seen(conn, venture_id: uuid.UUID, key: str, minutes: int) -> int:
    """Messages from this person that reached a reply in the last `minutes`, sent or not."""
    return int((await conn.execute(text(
        "SELECT count(*) FROM workflow_runs WHERE venture_id = :v AND workflow = 'inbox_assistant'"
        " AND created_at > now() - make_interval(mins => :m) AND summary->>'auto_to' = :k"),
        {"v": venture_id, "k": key, "m": minutes})).scalar() or 0)


async def room(conn, venture_id: uuid.UUID, key: str) -> bool:
    """Under every cap: 15 replies a person an hour, 500 a business a day, and a sender who wrote fewer than
    30 messages this hour (more is a machine talking to us: a loop no reply should feed)."""
    return (await recent(conn, venture_id, key, 60) < PER_CONTACT_HOUR
            and await seen(conn, venture_id, key, 60) < PER_CONTACT_SEEN_HOUR
            and await today(conn, venture_id) < PER_BUSINESS_DAY)
