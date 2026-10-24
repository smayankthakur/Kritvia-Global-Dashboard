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
PER_BUSINESS_DAY_EMAIL = 100   # well under Gmail's daily sending limit, so a flood can't block the owner's own mail
PER_CONTACT_SEEN_HOUR = 30      # more messages than this from one sender in an hour: a machine, not a person
ACK_QUIET_MINUTES = 10
REASONS = ("price_not_on_record", "discount_or_offer", "refund_or_payment_dispute", "commitment_or_deal",
           "complaint", "unsure", "order_booking_payment", "internal_source", "claims_human", "legal")
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
    "legal": "a legal matter (court, lawyer, consumer forum, police)",
}
# Reasons the customer hears "sorry, the team will get back to you" for, and "got it, confirming" for.
SORRY_REASONS = ("complaint", "refund_or_payment_dispute", "legal")
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
    line = lines.get(lang, lines["en"])
    name = (business or "").strip()[:80]
    if name:
        line = line.replace("{business}", name)
    else:   # no business name yet: "the team", never "our's team"
        line = (line.replace("{business}'s team", "the team").replace("{business} की टीम", "टीम")
                .replace("{business} ki team", "team").replace("{business}", "the team"))
    return line + (" 🙏" if emoji else "")


_SIGNATURE = {"en": "— {business}'s AI assistant", "hi": "— {business} का AI सहायक",
              "hinglish": "— {business} ka AI assistant"}


def signature(business: str | None, lang: str) -> str:
    """The line code adds to the first reply a person gets by itself (in a day): it says plainly that an AI
    wrote it, whatever the AI's own wording says (round 3, C6)."""
    name = (business or "").strip()[:80] or "the business"
    return _SIGNATURE.get(lang, _SIGNATURE["en"]).replace("{business}", name)


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


# "I'm definitely a real human", "you're talking to a real person", "not a bot, I promise"
_HUMAN_MORE = re.compile(
    r"\bi\s*(?:'|’)?\s*a?m\s+(?:\w+\s+){0,3}(?:human|human\s+being|real\s+person|actual\s+person)\b"
    r"|\b(?:talking|speaking|chatting)\s+(?:to|with)\s+(?:a\s+)?(?:real|actual|live)\s+(?:human|person)\b"
    r"|(?:^|[\s,.!])not\s+(?:a\s+|an\s+)?(?:bot|robot|chatbot|machine|ai)\b"
    r"|\bmy\s+name\s+is\s+\w+"
    r"|\bmera\s+naam\s+\w+\s+(?:hai|h)\b|मेरा\s+नाम",
    re.I)
# A personal introduction: "I'm Priya from the front desk", "this is Rahul here", "main Priya hoon". The name
# is matched case-sensitively (a capital letter), so "I'm happy to help" isn't one.
_INTRO = re.compile(
    r"\b(?:[Ii]\s*(?:'|’)?\s*[Aa]?m|[Tt]his\s+is|[Ii]t'?s|[Mm]yself)\s+([A-Z][a-z]{2,})\b"
    r"(?=\s*(?:,|!|\.|here|from|at|speaking|and|\(|$))"
    r"|\b[Mm]ain\s+([A-Z][a-z]{2,})\s+(?:hoon|hu|hun)\b")
_NOT_NAMES = {"Here", "Sorry", "Glad", "Happy", "Sure", "Just", "Not", "Afraid", "Excited", "Back", "Available",
              "Your", "The", "From", "Great", "Good", "Fine", "Okay", "Done", "Really", "Very", "Also", "Still",
              "Aapka", "Aapki", "Haan", "Bilkul"}


def claims_human(body: str | None, business: str | None = None) -> bool:
    """True when the reply claims to be a person, or introduces itself by a person's name: it then waits for
    the owner instead of going out."""
    b = body or ""
    if _HUMAN.search(b) or _HUMAN_MORE.search(b):
        return True
    biz = {w.lower() for w in re.findall(r"[A-Za-z]+", business or "")}
    for m in _INTRO.finditer(b):
        name = m.group(1) or m.group(2) or ""
        if name and name not in _NOT_NAMES and name.lower() not in biz:
            return True
    return False


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
    """The amounts the agent may quote: the records' own (rate card, booking prices, the customer's invoices)
    and amounts the given texts present as money (with ₹ or a price word). A bare number in a text, such as a
    shop number, a date or a time, is not a price (round 3, C3)."""
    money, pct = set(int(p) for p in paise if p is not None), set()
    for t in texts:
        for _, p in amounts_in(t or "") + price_amounts_in(t or ""):
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


# "I can do it for 1500", "only 999", "sirf 800 mein": a bare number of 50 or more after for/at/only/just,
# unless a time, a count of people or days follows ("at 5 pm", "for 2 people", "in 3 days").
_PRICE_FOR = re.compile(
    rf"\b(?:for|at|only|just|sirf|bas|matra|keval)\s+{_NUM}(?!\s*(?:%|am\b|pm\b|baje|o'?clock|:|people|persons?|"
    r"guests?|log\b|logon|days?|din\b|hours?|hrs?|ghante|minutes?|mins?|weeks?|months?|years?|saal|pieces?|pcs|"
    r"plates?|kg|kilo|items?|pages?|th\b|st\b|nd\b|rd\b))", re.I)
_PRICE_MEIN = re.compile(rf"{_NUM}\s+(?:mein|me|में)\b", re.I)


def price_amounts_in(s: str) -> list[tuple[str, int]]:
    """Bare numbers that the text presents as a price (no ₹ sign), as (as written, paise)."""
    out = []
    for rx in (_PRICE_BEFORE, _PRICE_AFTER, _PRICE_AFTER_WORD):
        for m in rx.finditer(s or ""):
            p = _paise(m.group(1), m.group(2))
            if p is not None:
                out.append((m.group(0).strip(), p))
    for rx in (_PRICE_FOR, _PRICE_MEIN):
        for m in rx.finditer(s or ""):
            p = _paise(m.group(1), m.group(2))
            if p is not None and p >= 5_000:      # 50 rupees or more; "for 2", "at 9" aren't prices
                out.append((m.group(0).strip(), p))
    return out


# Any amount next to off/discount/cashback is a discount, whatever the number ("₹300 off" where ₹300 is a
# listed price is still a discount).
_DISCOUNT_AMOUNT = re.compile(
    rf"(?:{_CUR_PRE}\s*)?\d[\d,]*(?:\.\d+)?\s*(?:%|percent|rs\.?|rupees?|/-)?\s*"
    r"(?:off\b|discount|cashback|kam\b|chhoot|chhut|छूट|की\s+छूट|ki\s+chhoot)"
    rf"|(?:discount|cashback|chhoot|छूट)\s+(?:of\s+)?(?:{_CUR_PRE}\s*)?\d", re.I)

# Amounts written in words: "five hundred rupees", "paanch sau rupaye", "do hazaar", "पाँच सौ रुपये".
_NUM_WORDS = (r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|"
              r"fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|lakhs|lac|crore|"
              r"ek|do|teen|char|chaar|paanch|panch|chhe|chhah|saat|aath|nau|das|bees|tees|chalis|pachaas|pachas|"
              r"sau|hazaar|hazar|hajar|dedh|dhai|dhaai|sava|saadhe|"
              r"एक|दो|तीन|चार|पाँच|पांच|छह|सात|आठ|नौ|दस|बीस|तीस|चालीस|पचास|सौ|हज़ार|हजार|लाख|करोड़|डेढ़|ढाई)")
_MONEY_WORDS = re.compile(
    rf"(?:{_CUR_PRE}\s*)?\b{_NUM_WORDS}(?:[\s-]+(?:and\s+)?{_NUM_WORDS})*\s*(?:{_CUR_POST}|rupees?|rupaye|rupaiye)",
    re.I)


def money_words_in(s: str | None) -> list[str]:
    """Amounts written in words, and amounts next to off/discount/cashback, in a draft."""
    out = [m.group(0).strip() for m in _MONEY_WORDS.finditer(s or "")]
    out += [m.group(0).strip() for m in _DISCOUNT_AMOUNT.finditer(s or "")]
    return out


# What the owner always sees first, decided by words in the customer's message or the draft (code, not the
# model, so a message can't talk its way past it). English, Hinglish and Hindi.
_CUSTOMER_WORDS: dict[str, re.Pattern[str]] = {
    "refund_or_payment_dispute": re.compile(
        r"\brefunds?\b|\brefunded\b|money\s+back|return\s+(?:my|the)\s+(?:money|payment|amount)|charge\s*back|"
        r"paise?\s+(?:wapas|vapas|wapis|vapis)|paisa\s+(?:wapas|vapas)|(?:wapas|vapas)\s+(?:karo|kijiye|chahiye|do)|"
        r"double\s+(?:charged|payment|deducted)|deducted\s+twice|पैसे\s+वापस|रिफंड|पैसा\s+वापस", re.I),
    "discount_or_offer": re.compile(
        r"\bdiscount|\bcoupon|\bpromo\s*code|\bcashback|\bkam\s+(?:karo|kar\s+do|kijiye|kariye)|\bchhoot|"
        r"\bbargain|best\s+price|last\s+price|\bछूट|डिस्काउंट|कम\s+कर", re.I),
    "complaint": re.compile(
        r"\bcomplain|\bterrible|\bworst\b|\bpathetic|\bhorrible|\bfraud|\bcheat|\bscam\b|\bdisgust|"
        r"\bunacceptable|\bdisappointed|\bangry|\bbekaar|\bbekar\b|\bghatiya|\bdhokha|\bshikayat|"
        r"शिकायत|धोखा|घटिया|बेकार", re.I),
    "legal": re.compile(
        r"\bcourt\b|\blegal\s+(?:action|notice)|\blawyer|\badvocate|consumer\s+(?:forum|court|helpline)|"
        r"\bpolice\b|\bfir\b|\bsue\b|\bvakeel|\bwakil|वकील|अदालत|कोर्ट|पुलिस|उपभोक्ता", re.I),
}
_DRAFT_WORDS: dict[str, re.Pattern[str]] = {
    "refund_or_payment_dispute": re.compile(r"\brefund|money\s+back|paise?\s+(?:wapas|vapas)|पैसे\s+वापस|रिफंड", re.I),
    "discount_or_offer": re.compile(
        r"\bdiscount|\bcoupon|\bcashback|\bhalf\s+(?:price|rate|off)|\bfree\s+(?:of\s+(?:cost|charge)|delivery|"
        r"shipping|service|session|trial\s+session|consultation|gift|sample)|\bfor\s+free\b|\bfree\s+mein|"
        r"\bmuft|\bwaive|\bcomplimentary|\bspecial\s+(?:price|rate|offer|deal)|\bchhoot|मुफ़्त|मुफ्त|छूट|डिस्काउंट",
        re.I),
    "commitment_or_deal": re.compile(
        r"\bguarantee|\bwarranty|\bwe\s+promise|\bi\s+promise|\bpromise\s+you|\bpakka\s+(?:se|guarantee)|"
        r"\b100\s*%\s*(?:sure|guaranteed|guarantee)|गारंटी|वादा", re.I),
}


def handoff_reasons(customer: str | None, draft: str | None) -> list[str]:
    """Reasons, from the words used, that this reply must wait for the owner (empty: none found)."""
    out = [k for k, rx in _CUSTOMER_WORDS.items() if rx.search(customer or "")]
    out += [k for k, rx in _DRAFT_WORDS.items() if rx.search(draft or "") and k not in out]
    if money_words_in(draft) and "price_not_on_record" not in out:
        out.append("price_not_on_record")
    return out


def unknown_amounts(body: str, known: tuple[set[int], set[float]]) -> list[str]:
    """Amounts and percentages in a draft that aren't in the business's records: a money promise for the owner."""
    money, pct = known
    found = [(w, p) for w, p in amounts_in(body) if p not in money]
    out = [w for w, _ in found]
    seen = {p for _, p in found}
    for w, p in price_amounts_in(body):
        if p not in money and p not in seen and w not in out:
            out.append(w)
            seen.add(p)
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
        " AND (summary->>'auto_sent' = 'true' OR summary->>'auto_pending' = 'true')"),
        {"v": venture_id, "k": key, "m": minutes})).scalar() or 0)


async def today(conn, venture_id: uuid.UUID, channel: str | None = None) -> int:
    """Replies this business sent (or is sending) by itself in the last 24 hours; on one channel if given."""
    return int((await conn.execute(text(
        "SELECT count(*) FROM workflow_runs WHERE venture_id = :v AND workflow = 'inbox_assistant'"
        " AND created_at > now() - interval '24 hours'"
        " AND (summary->>'auto_sent' = 'true' OR summary->>'auto_pending' = 'true')"
        " AND (CAST(:ch AS text) IS NULL OR summary->>'auto_channel' = :ch)"),
        {"v": venture_id, "ch": channel})).scalar() or 0)


async def seen(conn, venture_id: uuid.UUID, key: str, minutes: int) -> int:
    """Messages from this person that reached a reply in the last `minutes`, sent or not."""
    return int((await conn.execute(text(
        "SELECT count(*) FROM workflow_runs WHERE venture_id = :v AND workflow = 'inbox_assistant'"
        " AND created_at > now() - make_interval(mins => :m) AND summary->>'auto_to' = :k"),
        {"v": venture_id, "k": key, "m": minutes})).scalar() or 0)


async def room(conn, venture_id: uuid.UUID, key: str, *, channel: str | None = None) -> bool:
    """Under every cap: 15 replies a person an hour, 500 a business a day (100 of them by email), and a
    sender who wrote fewer than 30 messages this hour (more is a machine talking to us: a loop no reply
    should feed). Final say under a lock: engine/runner._reserve_auto_slot."""
    return (await recent(conn, venture_id, key, 60) < PER_CONTACT_HOUR
            and await seen(conn, venture_id, key, 60) < PER_CONTACT_SEEN_HOUR
            and await today(conn, venture_id) < PER_BUSINESS_DAY
            and (channel != "email" or await today(conn, venture_id, "email") < PER_BUSINESS_DAY_EMAIL))
