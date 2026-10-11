"""Prospector: outbound sales that runs itself.

Every day at the time the owner picks:

  daily:  find -> queue
          find   searches Google Maps (Places API) with the owner's searches, keeps operating businesses
                 with a phone number and no website of their own (a page on Instagram, Swiggy or Zomato
                 counts as none, by default), skips anyone already in Leads, and adds up to the daily
                 number as new leads.
          queue  starts one `touch` run for every prospect whose next touch is due.

  touch:  draft -> email:    [approval: gmail.send; goes out alone when the owner switched on
                             "send without asking", which grants this agent's trust] -> sent
                   whatsapp: the message is saved on the lead for the owner's one-tap send
                             (WhatsApp does not allow businesses to message strangers first through
                             its API, so the first WhatsApp always goes from the owner's own phone)

Each prospect gets a first message and up to `followups` follow-ups, `follow_up_days` apart, then
the sequence ends. A reply (matched by Gmail thread, email address or phone in the inbox assistant)
stops the sequence and the inbox assistant answers it; STOP / not interested opts them out for good.
Calls are logged by the owner from the lead for now; the agent does not dial anyone.

Google Maps data: only the place ID is stored (Google Maps Platform terms). Search results are used
inside the `find` step and dropped; the `draft` step looks the place up again by ID for the facts it
writes from. Nothing from Google goes into run state, notes or the lead row.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, time, timedelta
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Option, Workflow, registry
from kritvia_api.workflows.common import CURRENCY_IN_TEXT, IST, today_ist

wf = registry.register(Workflow(
    "prospector", title="Prospector", start="route", venture_kinds=("software", "general"),
    trigger="Every day at the time you set",
    description="Finds businesses on Google Maps that have no website, writes to each one in your voice, "
                "follows up, and stops the moment they reply or say no. Emails go from your Gmail; WhatsApp "
                "messages are ready for you to send with one tap. Replies are answered by the Inbox assistant.",
    options=(
        Option("searches", "Google Maps searches (separate with ;)", "text", "",
               help="What you would type into Maps, e.g. 'restaurants in Nangloi, Delhi; cafes in Rohini, Delhi'."),
        Option("offer", "What you offer them", "text",
               "a simple website with online ordering and a proper Google listing, ready in a week",
               help="One line the agent builds every message around. Prices here are the only ones it may quote."),
        Option("language", "Message language", "text", "Hinglish",
               help="e.g. 'Hinglish', 'English', 'Hindi'."),
        Option("new_per_day", "New prospects a day", "number", 10, min=1, max=25),
        Option("min_reviews", "Skip places with fewer Google reviews than", "number", 10, min=0, max=10000),
        Option("min_rating", "Skip places rated below", "number", 3.5, min=0, max=5),
        Option("only_no_website", "Only businesses without their own website", "boolean", True,
               help="Off: businesses that already have a website are included too, for when what you sell "
                    "isn't a website (software, services, supplies)."),
        Option("social_counts_as_none", "Count an Instagram, Swiggy or Zomato page as no website", "boolean", True),
        Option("skip_chains", "Skip chains and franchises", "boolean", True,
               help="Big brands (Domino's, Haldiram's…) and any name that shows up as several branches are left out: "
                    "their websites are decided at head office."),
        Option("skip_hotels", "Skip hotels and guest houses", "boolean", True),
        Option("followups", "Follow-ups after the first message", "number", 2, min=0, max=3),
        Option("follow_up_days", "Days between messages", "number", 3, min=1, max=14),
        Option("send_without_asking", "Send emails and answer replies without asking me", "boolean", True,
               help="Off: every message waits for your approval. Messages that quote a price the offer "
                    "doesn't contain, or that the agent isn't sure about, always wait for you."),
    )))

PLACEHOLDER_NAME = "Business on Google Maps"   # leads.name for a prospect until they reply
MAX_SEARCHES = 5
MAX_QUEUE = 40
# Phrases that mean "leave me alone" anywhere in a reply; a bare STOP / unsubscribe only counts
# when it is (nearly) the whole message, so "we never stop working" is not an opt-out.
OPT_OUT = re.compile(
    r"\b(unsubscribe me|not interested|no thanks|remove me|don'?t (?:message|contact|call|text|email|write)|"
    r"do not (?:message|contact|call|text|email|write)|mat bhejo|mat karo|nahi chahiye|nahin chahiye|band karo|"
    r"interest nahi|interested nahi|zaroorat nahi|need nahi)\b", re.I)
OPT_OUT_SHORT = re.compile(r"^\W*(stop|unsubscribe|no|nahi|nahin|remove)\W*(please|pls|plz|thanks)?\W*$", re.I)


def is_opt_out(body: str | None) -> bool:
    b = (body or "").strip()
    return bool(OPT_OUT.search(b) or OPT_OUT_SHORT.match(b))


# --- who to leave out ------------------------------------------------------------------------
# Google place types for somewhere to stay (https://developers.google.com/maps/documentation/places/web-service/place-types).
LODGING_TYPES = frozenset({
    "lodging", "hotel", "motel", "resort_hotel", "hostel", "guest_house", "bed_and_breakfast", "inn",
    "extended_stay_hotel", "budget_japanese_inn", "japanese_inn", "cottage", "farmstay", "private_guest_room",
    "campground", "camping_cabin", "mobile_home_park", "rv_park"})
LODGING_WORDS = re.compile(r"\b(hotel|hotels|motel|resort|hostel|guest ?house|lodge|inn|homestay|bnb|b&b|"
                           r"dharamshala|dharmshala|oyo)\b", re.I)
# Chains and franchises common in India; their branches have no say over a website.
CHAINS = (
    "domino", "mcdonald", "kfc", "pizza hut", "burger king", "subway", "starbucks", "haldiram", "bikanervala",
    "bikano", "cafe coffee day", "ccd", "barista", "costa coffee", "dunkin", "baskin robbins", "taco bell",
    "wow momo", "biryani by kilo", "behrouz", "faasos", "oven story", "la pino'z", "sagar ratna",
    "nirula", "moti mahal", "chaayos", "chai point", "burger singh", "giani", "keventers", "theobroma",
    "mad over donuts", "belgian waffle", "third wave coffee", "blue tokai", "om sweets", "nathu", "bittu tikki",
    "rollsking", "goli vada pav", "jumboking", "box8", "eatfit", "lunchbox", "the good bowl", "sweet truth",
    "naturals ice cream", "cream bell", "amul", "mother dairy", "frozen bottle", "lavazza", "tim hortons",
    "wendy", "popeyes", "california burrito", "chili's", "barbeque nation", "absolute barbecues", "mainland china",
    "punjab grill", "pind balluchi", "dhaba by claridges", "social", "the beer cafe",
)


def brand_key(name: str) -> str:
    """'Sagar Ratna - Rajouri Garden' / 'Sagar Ratna (Rohini)' -> 'sagar ratna'."""
    n = re.split(r"\s[-|–—]\s|\(|,|\|", name.lower(), maxsplit=1)[0]
    n = re.sub(r"[^a-z0-9 &']+", " ", n.replace("'s", "s"))
    return re.sub(r"\s+", " ", n).strip()


_CHAIN_KEYS = frozenset(brand_key(c) for c in CHAINS)


def is_known_chain(name: str) -> bool:
    """A brand from CHAINS, allowing a plural or possessive ('Domino's Pizza', 'McDonald's') and a suffix."""
    k = brand_key(name)
    return any(k == c or k == c + "s" or k.startswith(c + " ") or k.startswith(c + "s ") for c in _CHAIN_KEYS)


def is_lodging(primary_type: str | None, category: str | None, name: str) -> bool:
    """Somewhere to stay, by Google's own type. The name is not used: in India 'Hotel Saravana Bhavan' or
    'Sharma Hotel' is usually a restaurant, and Google types those as restaurants."""
    if primary_type:
        return primary_type in LODGING_TYPES
    return bool(LODGING_WORDS.search(category or ""))


# Everyday Hindi words written in Roman script. A "Hinglish" message with almost none of them is English.
HINGLISH_WORDS = frozenset({
    "aap", "aapka", "aapke", "aapki", "aapko", "hai", "hain", "ho", "hum", "hamare", "humare", "hamari", "ke",
    "ki", "ka", "ko", "se", "mein", "me", "par", "pe", "nahi", "nahin", "kya", "bhi", "sakte", "sakta",
    "sakti", "karna", "karein", "kariye", "chahiye", "ji", "apne", "apna", "liye", "toh", "to", "aur", "abhi",
    "ek", "dekha", "dekhi", "mil", "milenge", "milega", "bataiye", "batayein", "baat", "kaise", "kitna", "sahi",
    "accha", "achha", "acha", "dhanyavaad", "shukriya", "namaste", "zaroor", "jaldi", "ghar", "dukaan", "wala",
    "wali", "wale", "karte", "karta", "hota", "hoti", "hote", "jayega", "jayegi", "dijiye", "lijiye"})


def looks_hinglish(text_: str) -> bool:
    words = re.findall(r"[a-z]+", (text_ or "").lower())
    hits = sum(1 for w in words if w in HINGLISH_WORDS)
    return bool(words) and hits >= 3 and hits / len(words) >= 0.12


def hinglish_wanted(language: str | None) -> bool:
    return "hinglish" in (language or "hinglish").lower()


LANGUAGE_GUIDE = {
    "hinglish": ("Write the WhatsApp message in Hinglish: everyday Hindi in Roman (English) letters, mixed with "
                 "common English words, the way a Delhi shop owner texts on WhatsApp. Not Devanagari, not formal "
                 "Hindi, and not plain English. Address them as 'aap' and '... ji' where natural. For example "
                 "(style only, do not copy): 'Namaste ji, Google Maps pe aapka dhaba dekha, reviews kaafi acche "
                 "hain. Abhi aapki website nahi hai, isliye log Swiggy pe hi order karte hain...'"),
}


class Outreach(BaseModel):
    subject: str = Field(default="", description="email subject, under 60 characters, no clickbait")
    email_body: str = Field(description="plain-text email, 60-120 words, no signature block")
    whatsapp: str = Field(description="WhatsApp message, 2-4 short lines, no greeting card emojis spam")


def norm_phone(raw: str | None) -> str | None:
    """'+91 98737 78861' / '098737 78861' -> '+919873778861'. Other countries keep their code."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if raw.strip().startswith("+") and not digits.startswith("91"):
        return "+" + digits if 8 <= len(digits) <= 15 else None
    digits = digits.lstrip("0")
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    return "+91" + digits if len(digits) == 10 else None


def whatsapp_link(phone: str | None, message: str | None) -> str | None:
    p = norm_phone(phone)
    if not p:
        return None
    return f"https://wa.me/{p.lstrip('+')}" + (f"?text={quote(message)}" if message else "")


def area_of(address: str | None) -> str:
    """'…, Shivram Park, Nangloi, Delhi, 110041' -> 'Nangloi'."""
    parts = [p.strip() for p in (address or "").split(",") if p.strip()]
    parts = [p for p in parts if not re.fullmatch(r"\d{6}", p) and p.lower() not in ("india", "delhi", "new delhi")
             and not re.search(r"\b\d{6}\b", p)]
    return parts[-1] if parts else ""


async def prospector_settings(conn, venture_id: uuid.UUID) -> dict[str, Any]:
    """This venture's Prospector settings over the defaults (for code outside a prospector run)."""
    row = (await conn.execute(text(
        "SELECT enabled, settings FROM workflow_configs WHERE venture_id = :v AND workflow = 'prospector'"),
        {"v": venture_id})).first()
    return {**wf.defaults(), **(dict(row.settings) if row and row.settings else {}),
            "_enabled": bool(row and row.enabled)}


def next_touch(step_done: int, cfg: dict[str, Any], now: datetime | None = None) -> datetime | None:
    """After the `step_done`-th message (1 = first), when the next one is due, or None if the sequence is over."""
    if step_done > int(cfg.get("followups", 2)):
        return None
    when = (now or datetime.now(IST)) + timedelta(days=int(cfg.get("follow_up_days", 3)))
    return when


# --- routing ----------------------------------------------------------------------------------
@wf.step("route", agent="prospector")
async def route(ctx: RunContext, state: dict) -> Goto:
    mode = (state["input"] or {}).get("mode") or "daily"
    return Goto("draft" if mode == "touch" else "find")


# --- daily: find new prospects ----------------------------------------------------------------
@wf.step("find", agent="prospector")
async def find(ctx: RunContext, state: dict) -> Goto | Finish:
    from kritvia_api.config import get_settings
    cfg = await ctx.settings()
    searches = [q.strip() for q in re.split(r"[;\n]", str(cfg.get("searches") or "")) if q.strip()][:MAX_SEARCHES]
    if not searches:
        ctx.note("no Google Maps searches set; add one in the Prospector settings")
        return Goto("queue", update={"summary": {"found": 0, "added": 0, "reason": "no_searches"}})
    from kritvia_api.services.places_keys import places_for
    async with ctx.tx() as conn:
        access = await places_for(conn, ctx.services, ctx.venture_id)
    if access.client is None:
        ctx.note(f"no new prospects today: {access.problem}")
        return Goto("queue", update={"summary": {"found": 0, "added": 0, "reason": "places_not_set_up"}})

    cap = min(int(cfg.get("new_per_day", 10)), get_settings().prospector_daily_cap)
    day_start = datetime.combine(today_ist(), time(0, 0), IST)
    async with ctx.tx() as conn:
        added_today = int((await conn.execute(text(
            "SELECT count(*) FROM leads WHERE venture_id = :v AND source = 'prospector' AND created_at >= :d"),
            {"v": ctx.venture_id, "d": day_start})).scalar() or 0)
    room = max(0, cap - added_today)
    if room == 0:
        ctx.note(f"today's {cap} new prospects are already in")
        return Goto("queue", update={"summary": {"found": 0, "added": 0, "reason": "daily_cap"}})

    allowed = {"none", "social", "listing"} if cfg.get("social_counts_as_none", True) else {"none"}
    if not cfg.get("only_no_website", True):
        allowed = {"none", "social", "listing", "own"}
    min_reviews, min_rating = int(cfg.get("min_reviews", 10)), float(cfg.get("min_rating", 3.5))
    skip_chains, skip_hotels = bool(cfg.get("skip_chains", True)), bool(cfg.get("skip_hotels", True))
    candidates, seen, found, errors = [], set(), 0, []
    results: list[tuple[str, dict]] = []
    skipped = {"chains": 0, "hotels": 0}
    for q in searches:
        try:
            res = await ctx.invoke("places.search", {"query": q, "max_results": 60})
        except Exception as exc:   # one bad search must not stop the others
            errors.append(f"{type(exc).__name__}")
            ctx.note(f"a Maps search failed ({type(exc).__name__}: {str(exc)[:120]})")
            continue
        results.extend((q, p) for p in res["places"])
    # A name seen at two or more addresses in today's results is a chain (branches), whatever its brand.
    branches: dict[str, set[str]] = {}
    for _, p in results:
        branches.setdefault(brand_key(p.get("name") or ""), set()).add(p.get("address") or p["place_id"])
    for q, p in results:
        found += 1
        if skip_hotels and is_lodging(p.get("primary_type"), p.get("category"), p.get("name") or ""):
            skipped["hotels"] += 1
            continue
        key = brand_key(p.get("name") or "")
        if skip_chains and key and (is_known_chain(p.get("name") or "") or len(branches.get(key, ())) >= 2):
            skipped["chains"] += 1
            continue
        phone = norm_phone(p.get("phone"))
        if (p["place_id"] in seen or p.get("status") != "OPERATIONAL" or not phone
                or p["website_kind"] not in allowed
                or (p.get("review_count") or 0) < min_reviews
                or (p.get("rating") is not None and p["rating"] < min_rating)):
            continue
        seen.add(p["place_id"])
        candidates.append({**p, "phone": phone, "search": q})
    # Busiest first: more reviews = more customers to lose to a competitor with a website.
    candidates.sort(key=lambda p: -(p.get("review_count") or 0))

    added: list[str] = []
    async with ctx.tx() as conn:
        for p in candidates:
            if len(added) >= room:
                break
            # Already a prospect, or already a customer or enquiry with this phone number.
            known = (await conn.execute(text(
                "SELECT 1 FROM leads WHERE venture_id = :v AND (place_id = :pl"
                " OR right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = :ph) LIMIT 1"),
                {"v": ctx.venture_id, "pl": p["place_id"], "ph": p["phone"][-10:]})).first()
            if known:
                continue
            # Only the place ID is kept (Google's terms); the name shown is fetched live by ID.
            lead_id = (await conn.execute(text(
                "INSERT INTO leads (org_id, venture_id, name, source, status, place_id, place_search, website_kind,"
                " next_touch_at, last_run_id) VALUES (:o, :v, :n, 'prospector', 'new', :pl, :q, :wk, now(), :run)"
                " ON CONFLICT (venture_id, place_id) WHERE place_id IS NOT NULL DO NOTHING RETURNING id"),
                {"o": ctx.org_id, "v": ctx.venture_id, "n": PLACEHOLDER_NAME, "pl": p["place_id"],
                 "q": p["search"][:300], "wk": p["website_kind"], "run": ctx.run_id})).scalar()
            if lead_id:
                added.append(str(lead_id))
    ctx.note(f"{found} places found, {len(candidates)} without a website, {len(added)} new prospects added"
             + (f" ({skipped['chains']} chains and {skipped['hotels']} hotels left out)"
                if skipped["chains"] or skipped["hotels"] else ""))
    return Goto("queue", update={"summary": {"found": found, "matching": len(candidates), "added": len(added),
                                             "search_errors": len(errors), "skipped_chains": skipped["chains"],
                                             "skipped_hotels": skipped["hotels"]}})


@wf.step("queue", agent="prospector")
async def queue(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    async with ctx.tx() as conn:
        due = (await conn.execute(text(
            "SELECT id, outreach_step, next_touch_at FROM leads WHERE venture_id = :v AND source = 'prospector'"
            " AND next_touch_at IS NOT NULL AND next_touch_at <= now() AND opted_out_at IS NULL"
            " AND replied_at IS NULL AND status IN ('new', 'contacted')"
            " ORDER BY next_touch_at LIMIT :n"), {"v": ctx.venture_id, "n": MAX_QUEUE})).all()
    started = 0
    for lead in due:
        try:
            await start_run(ctx.services, actor_user_id=ctx.run_as, actor_type="agent", venture_id=ctx.venture_id,
                            workflow="prospector", trigger_kind="schedule",
                            # once per scheduled touch: a re-run of the queue never writes twice, but a
                            # touch the owner re-schedules (Resume) gets a fresh message
                            dedupe=("prospector:touch",
                                    f"{lead.id}:{lead.outreach_step}:{lead.next_touch_at.isoformat()}"),
                            title="Prospect follow-up" if lead.outreach_step else "First message to a prospect",
                            input={"mode": "touch", "lead_id": str(lead.id)})
            started += 1
        except DuplicateTrigger:
            continue
    summary = {**state.get("summary", {}), "touches": started}
    return Finish("prospected", update={"summary": summary}, note=f"{started} message(s) to write")


# --- touch: one message to one prospect ------------------------------------------------------
async def _lead(ctx: RunContext, lead_id: str):
    async with ctx.tx() as conn:
        return (await conn.execute(text(
            "SELECT id, name, email, phone, place_id, website_kind, status, outreach_step, opted_out_at, replied_at,"
            " thread_id, last_touch_channel FROM leads"
            " WHERE id = :id AND venture_id = :v"), {"id": uuid.UUID(lead_id), "v": ctx.venture_id})).first()


async def _pause(ctx: RunContext, lead_id, *, until: datetime | None = None, status: str | None = None) -> None:
    async with ctx.tx() as conn:
        await conn.execute(text(
            "UPDATE leads SET next_touch_at = :n, status = coalesce(:s, status), updated_at = now() WHERE id = :id"),
            {"n": until, "s": status, "id": lead_id})


@wf.step("draft", agent="prospector")
async def draft(ctx: RunContext, state: dict) -> Interrupt | Finish:
    cfg = await ctx.settings()
    lead = await _lead(ctx, state["input"]["lead_id"])
    if lead is None:
        return Finish("lead_gone")
    if lead.opted_out_at or lead.replied_at or lead.status not in ("new", "contacted"):
        await _pause(ctx, lead.id)
        return Finish("no_longer_a_prospect")
    step = int(lead.outreach_step)
    if step > int(cfg.get("followups", 2)):
        await _pause(ctx, lead.id)
        return Finish("sequence_done")

    # The facts are looked up live by place ID (Google lets us keep only the ID).
    place = None
    if lead.place_id:
        from kritvia_api.services.places import PlacesError
        from kritvia_api.services.places_keys import key_problem, places_for, record
        async with ctx.tx() as conn:
            access = await places_for(conn, ctx.services, ctx.venture_id)
        if access.client is None:
            await _pause(ctx, lead.id, until=datetime.now(IST) + timedelta(days=1))
            return Finish("places_not_set_up", note=f"{access.problem}; trying again tomorrow")
        try:
            place = await access.client.details(lead.place_id)
        except PlacesError as exc:
            if key_problem(str(exc)):
                async with ctx.tx() as conn:
                    await record(conn, access, str(exc))
            await _pause(ctx, lead.id, until=datetime.now(IST) + timedelta(days=1))
            return Finish("place_unavailable", note=f"Google Maps lookup failed ({str(exc)[:120]}); trying tomorrow")
        if place.status == "CLOSED_PERMANENTLY":
            await _pause(ctx, lead.id, status="archived")
            return Finish("business_closed", note="the business has closed; archived")
    phone = lead.phone or (place.phone if place else None)
    channel = "email" if lead.email else ("whatsapp" if norm_phone(phone) else None)
    if channel is None:
        await _pause(ctx, lead.id)
        return Finish("no_way_to_reach")

    biz = await ctx.business()
    offer = str(cfg.get("offer") or "").strip()
    language = str(cfg.get("language") or "Hinglish").strip() or "Hinglish"
    kind = lead.website_kind or (place.website_kind if place else "none")
    presence = {"none": "no website and no web page at all",
                "social": "only a social media page" + (f" ({place.website})" if place and place.website else ""),
                "listing": "only a delivery-app or directory page" + (
                    f" ({place.website})" if place and place.website else ""),
                "own": "their own website" + (f" ({place.website})" if place and place.website else "")}
    selling_websites = bool(cfg.get("only_no_website", True))
    name = place.name if place else lead.name
    facts = "\n".join(x for x in (
        f"Business: {name}",
        f"Type: {place.category}" if place and place.category else "",
        f"Area: {area_of(place.address)}" if place and place.address else "",
        f"Google rating: {place.rating} from {place.review_count} reviews"
        if place and place.rating is not None else "",
        f"Online today: {presence.get(kind, 'a website')}",
    ) if x)
    stage = ("This is the FIRST message: introduce yourself in one line, say you found them on Google Maps, "
             + ("name one concrete thing they lose without a website, " if selling_websites else
                "name one concrete, everyday problem the offer solves for a business like theirs, ")
             + "make the offer, and ask one easy question."
             if step == 0 else
             f"This is follow-up number {step}: they have not replied. Be brief and friendly, add one new reason "
             "or idea (not the same pitch), and make it easy to say yes or no." + (
                 " This is the LAST message; say you won't message again." if step >= int(cfg.get("followups", 2))
                 else ""))
    system = (f"{await ctx.brief()}\nYou write short, honest sales messages from {biz.name} to local businesses. "
              f"What we offer: {offer or 'our services'}.\n"
              "Rules: sound like a real person, not a marketer. Use only the facts given; never invent numbers, "
              "reviews, clients or results. Never mention a price unless it is in the offer line above. "
              "No fake urgency, no ALL CAPS, at most one emoji on WhatsApp. "
              f"Language: {language} (email may be simple English if the language is Hinglish). "
              + (LANGUAGE_GUIDE["hinglish"] + " " if hinglish_wanted(language) else "")
              + f"Sign the email as {biz.sign_off}.")
    prompt = f"{stage}\n\nAbout them:\n{facts}"
    o = await ctx.llm_json(tier="reason", schema=Outreach, system=system, prompt=prompt)
    if channel == "whatsapp" and hinglish_wanted(language) and not looks_hinglish(o.whatsapp):
        # Free models often slip into plain English; one firmer retry, then use whichever reads better.
        retry = await ctx.llm_json(tier="reason", schema=Outreach, system=system, prompt=(
            f"{prompt}\n\nYour last WhatsApp draft was in English:\n{o.whatsapp}\n\nRewrite the WhatsApp message "
            "in Hinglish (Hindi in Roman letters mixed with English), keeping the same facts and offer."))
        if looks_hinglish(retry.whatsapp):
            o = retry

    # An amount the offer doesn't contain is the model guessing a price: a person must see it.
    offered = set(m.group(0) for m in CURRENCY_IN_TEXT.finditer(offer))
    guessed = [m.group(0) for m in CURRENCY_IN_TEXT.finditer(o.email_body + " " + o.whatsapp)
               if m.group(0) not in offered]

    if channel == "whatsapp":
        msg = o.whatsapp.strip() + "\n\n(Reply STOP if you'd rather not hear from us.)"
        async with ctx.tx() as conn:
            enc = await ctx.crypto(conn).encrypt(ctx.venture_id, "leads.outreach", msg)
            await conn.execute(text(
                "UPDATE leads SET outreach_draft_enc = :d, next_touch_at = NULL, updated_at = now() WHERE id = :id"),
                {"d": enc, "id": lead.id})
        return Finish("whatsapp_ready", update={"summary": {"lead_id": str(lead.id), "channel": "whatsapp",
                                                            "step": step, "price_check": bool(guessed)}},
                      note="WhatsApp message ready for one-tap send from Leads"
                           + (" (check the price it mentions)" if guessed else ""))

    body = (o.email_body.strip() + f"\n\n{biz.sign_off}\n\n"
            "If you'd rather not hear from us, reply STOP and we won't write again.")
    subject = (o.subject.strip() or f"A website for {name}")[:120]
    if step and lead.thread_id and not subject.lower().startswith("re:"):
        subject = "Re: " + subject
    return Interrupt(
        ApprovalRequest(
            agent="prospector", action="gmail.send", key="send_decision",
            title=f"{'Follow-up' if step else 'First email'} to a business found on Google Maps",
            summary=f"{'Follow-up ' + str(step) if step else 'First message'} to a prospect found on Google Maps."
                    + (f" Mentions {', '.join(guessed)}, which isn't in your offer." if guessed else ""),
            payload={"to": lead.email, "subject": subject, "body": biz.with_notice(body),
                     "thread_id": lead.thread_id if step else None},
            # Sent without asking when the owner switched that on (it grants this agent's trust);
            # a price the offer doesn't contain always waits for a person.
            always_review=bool(guessed), expires_in_hours=48),
        resume="sent", on_reject="skipped",
        update={"lead_id": str(lead.id), "step": step, "channel": "email"},
        note=f"{'follow-up ' + str(step) if step else 'first email'} drafted")


@wf.step("sent", agent="prospector")
async def sent(ctx: RunContext, state: dict) -> Finish:
    from kritvia_api.engine.tools import AlreadyExecuted
    try:
        res = await ctx.invoke("gmail.send", approval_id=state["send_decision"]["approval_id"])
    except AlreadyExecuted as done:
        res = (done.args[0] if done.args else None) or {}
    cfg = await ctx.settings()
    step_done = int(state["step"]) + 1
    async with ctx.tx() as conn:
        await conn.execute(text(
            "UPDATE leads SET outreach_step = :s, last_touch_at = now(), last_touch_channel = 'email',"
            " outreach_draft_enc = NULL,"   # an older WhatsApp draft is superseded by this email
            " status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END,"
            " thread_id = coalesce(thread_id, NULLIF(:t, '')), next_touch_at = :n, updated_at = now()"
            " WHERE id = :id AND replied_at IS NULL AND opted_out_at IS NULL"),
            {"s": step_done, "t": str(res.get("thread_id") or ""), "n": next_touch(step_done, cfg),
             "id": uuid.UUID(state["lead_id"])})
    return Finish("emailed", update={"summary": {"lead_id": state["lead_id"], "channel": "email",
                                                 "step": state["step"], "sent": res.get("status")}},
                  note=f"email {res.get('status')} via {res.get('transport')}")


@wf.step("skipped", agent="prospector")
async def skipped(ctx: RunContext, state: dict) -> Finish:
    """The owner turned this message down: leave the prospect alone until they decide."""
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE leads SET next_touch_at = NULL, updated_at = now() WHERE id = :id"),
                           {"id": uuid.UUID(state["lead_id"])})
    return Finish("skipped")


# --- replies (called by the inbox assistant) -------------------------------------------------
async def match_reply(conn, venture_id: uuid.UUID, *, email: str | None, phone: str | None,
                      thread_id: str | None, body: str) -> dict[str, Any] | None:
    """If this incoming message is from a prospect, stop their sequence and say how to treat it.

    Returns None for anyone else, else {"lead_id", "opted_out"}. A prospect who writes STOP / not
    interested / mat bhejo is opted out for good and gets no reply."""
    email = (email or "").strip().lower() or None
    ph = norm_phone(phone)
    lead = (await conn.execute(text(
        "SELECT id FROM leads WHERE venture_id = :v AND source = 'prospector' AND ("
        " (CAST(:t AS text) IS NOT NULL AND thread_id = :t)"
        " OR (CAST(:e AS text) IS NOT NULL AND lower(email) = :e)"
        " OR (CAST(:p AS text) IS NOT NULL AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = :p))"
        " ORDER BY updated_at DESC LIMIT 1"),
        {"v": venture_id, "t": thread_id or None, "e": email, "p": ph[-10:] if ph else None})).first()
    if lead is None:
        return None
    opted_out = is_opt_out(body)
    await conn.execute(text(
        "UPDATE leads SET replied_at = coalesce(replied_at, now()), next_touch_at = NULL, outreach_draft_enc = NULL,"
        " opted_out_at = CASE WHEN :o THEN coalesce(opted_out_at, now()) ELSE opted_out_at END,"
        " status = CASE WHEN :o AND status IN ('new', 'contacted', 'replied') THEN 'lost'"
        "               WHEN status IN ('new', 'contacted') THEN 'replied' ELSE status END,"
        " updated_at = now() WHERE id = :id"), {"o": opted_out, "id": lead.id})
    return {"lead_id": str(lead.id), "opted_out": opted_out}


__all__ = ["wf", "match_reply", "norm_phone", "whatsapp_link", "prospector_settings", "next_touch", "area_of",
           "is_opt_out"]
