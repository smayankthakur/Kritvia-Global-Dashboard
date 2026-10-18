"""AI phone calls: answering the business's Twilio number turn by turn (signed webhooks, TwiML), taking a
message that becomes a task and a lead, putting a caller through, "don't call me" -> do-not-call list,
limits; test calls in the app; outbound calls only after a yes, as test calls until the DLT registration
is recorded, then dialled within the rules."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from urllib.parse import urlencode

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, SERVICES, join, make_actor
from kritvia_api.config import get_settings
from kritvia_api.services import twilio_voice as tw
from kritvia_api.services import voice_calls as vc

PHONE_BRAIN = "You are the AI phone assistant of"
SUMMARY = "You summarise a phone call"
SID = "AC" + "1" * 32
TOKEN = "f" * 32


class FakeTwilio:
    def __init__(self) -> None:
        self.pointed: list[tuple] = []
        self.placed: list[dict] = []

    async def number(self, sid: str, token: str, phone: str) -> dict:
        if token != TOKEN:
            raise tw.TwilioError("Twilio didn't accept the account SID and auth token")
        return {"sid": "PN" + "2" * 32, "capabilities": {"voice": True}}

    async def point_number(self, sid, token, number_sid, voice_url, status_url) -> None:
        self.pointed.append((number_sid, voice_url, status_url))

    async def place_call(self, sid, token, *, to, from_, url, status_url) -> str:
        self.placed.append({"to": to, "from": from_, "url": url})
        return "CA" + "9" * 32


@pytest.fixture
def twilio(monkeypatch):
    fake = FakeTwilio()
    monkeypatch.setattr(SERVICES, "twilio", fake)
    return fake


@pytest.fixture
async def shop(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Call Shop", "slug": f"call-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Sharma Sweets", "city": "Delhi"})
    operator = await make_actor(client, "call-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


def brain(fake_llm, *replies):
    seen = {"n": 0}

    def reply(messages):
        r = replies[min(seen["n"], len(replies) - 1)]
        seen["n"] += 1
        return r
    fake_llm.on(PHONE_BRAIN, reply)
    fake_llm.on(SUMMARY, {"summary": "Ravi asked for 20 kg kaju katli for Sunday; wants a call back with the price.",
                          "caller_name": "Ravi"})
    return seen


NUMBERS = iter(range(1000, 9999))


async def connect(mayank, v, twilio, **voice):
    r = await mayank.post(f"/ventures/{v}/voice/twilio", json={"account_sid": SID, "auth_token": TOKEN,
                                                               "phone_number": f"+91 80 4567 {next(NUMBERS)}"})
    assert r.status_code == 201, r.text
    body = {"enabled": True, "language": "en-IN", "transfer_number": "98110 00011", "open_days": [0, 1, 2, 3, 4, 5, 6],
            "open_from": "00:00", "open_to": "23:59", **voice}
    r = await mayank.put(f"/ventures/{v}/voice", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def hook(client, path: str, form: dict[str, str], *, token: str = TOKEN) -> httpx.Response:
    url = get_settings().public_api_url.rstrip("/") + path
    return await client.post(path, content=urlencode(form), headers={
        "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": tw.signature(token, url, form)})


def test_signature_and_twiml():
    # Twilio's own documented example
    p = {"CallSid": "CA1234567890ABCDE", "Caller": "+12349013030", "Digits": "1234", "From": "+12349013030",
         "To": "+18005551212"}
    assert tw.signature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", p) == "0/KCTR6DLpKmkAf8muzZqo1nDgQ="
    assert not tw.valid("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", {**p, "Digits": "9"},
                        "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")
    x = tw.listen("Hello <there> & welcome", "https://k/turn?call=1&x=2", tw.Voice())
    assert '<Gather input="speech dtmf"' in x and 'action="https://k/turn?call=1&amp;x=2"' in x
    assert "Hello &lt;there&gt; &amp; welcome" in x and 'voice="Polly.Aditi"' in x and 'language="hi-IN"' in x
    assert "<Dial" in tw.transfer("One moment", "+919811000011", tw.Voice()) and "<Hangup/>" in tw.goodbye("Bye", tw.Voice())
    assert tw.normalise_phone("098110 00011") == "+919811000011" and tw.normalise_phone("12") is None
    assert tw.mask("+919811000011") == "+91 98•••••011"
    s = vc.Settings(language="en-IN")
    assert "AI assistant" in vc.greeting("Sharma Sweets", s)
    assert vc.greeting("Sharma Sweets", vc.Settings(language="en-IN", greeting="Welcome to Sharma Sweets!")).startswith(
        "This is Sharma Sweets's AI assistant.")


def test_stop_calling_only_on_clear_asks():
    for stop in ("please don't call me again", "mujhe call mat karo", "call na karein please", "phone band kar do",
                 "stop calling me", "कॉल मत करना", "दोबारा फोन न करें"):
        assert vc.STOP_RE.search(stop), stop
    # complaints and questions about calls are not asks to stop (one ended a live call before)
    for not_stop in ("can you call me back tomorrow", "Maine subah try kiya par call nahi lag raha tha",
                     "pichli baar call band ho gaya tha", "Aapne mujhe call nahi kiya", "phone pe baat karni hai"):
        assert not vc.STOP_RE.search(not_stop), not_stop


def test_numbers_language_and_hours_for_the_phone():
    assert vc.speakable("आपका नंबर 98110 00011 है, सही?") == "आपका नंबर 9 8 1 1 0, 0 0 0 1 1 है, सही?"
    assert vc.speakable("Call +91 98110-00011") == "Call plus 9 1, 9 8 1 1 0, 0 0 0 1 1"
    assert vc.speakable("Is it 9811000011, or 9811000012?") == (
        "Is it 9 8 1 1 0 0 0 0 1 1, or 9 8 1 1 0 0 0 0 1 2?")
    same = "₹1,50,000 or 40000, in 2026, pin 110087, ₹12,50,00,000 or 1.2345678"
    assert vc.speakable(same) == same
    assert vc.caller_language("Hi, do you build mobile apps as well?") == "english"
    assert vc.caller_language("Aap kitne baje tak khule ho?") == "hinglish"
    assert vc.caller_language("मुझे वेबसाइट चाहिए") == "hindi"
    assert vc.caller_language("ok") is None and vc.caller_language("Rohit") is None
    s = vc.Settings(open_days=[0, 1, 2, 3, 4, 5], open_from="10:00", open_to="19:00")
    tz = vc.ZoneInfo("Asia/Kolkata")
    h = vc.hours_line(s, tz, datetime(2026, 10, 18, 15, 0, tzinfo=UTC))   # a Sunday, 20:30 in Delhi
    assert "Sunday 18 October 2026, 20:30" in h and "Monday, Tuesday" in h and "10:00 to 19:00" in h
    assert "CLOSED right now" in h
    assert "OPEN right now" in vc.hours_line(s, tz, datetime(2026, 10, 19, 6, 0, tzinfo=UTC))


def test_one_voice_keeps_the_feminine_form():
    assert vc.one_voice("मैं मदद कर सकता/सकती हूँ") == "मैं मदद कर सकती हूँ"
    assert vc.one_voice("मैं आपको कॉल (करूँगा / करूँगी)।") == "मैं आपको कॉल करूँगी।"
    assert vc.one_voice("Main bata sakta/sakti hoon") == "Main bata sakti hoon"
    for same in ("हम 24/7 खुले हैं", "call/WhatsApp", "and/or", "10/12 को"):
        assert vc.one_voice(same) == same


async def test_answering_a_call_takes_a_message(shop, fake_llm, twilio, client):
    mayank, v = shop["mayank"], shop["v"]
    out = await connect(mayank, v, twilio)
    assert out["answering"] is True and out["number"]["number"].startswith("+91804567") and out["number"]["account"] == "1111"
    assert twilio.pointed and twilio.pointed[0][1].endswith("/incoming")
    cid = out["number"]["voice_url"].split("/twilio/")[1].split("/")[0]
    # a forged request is refused
    r = await hook(client, f"/hooks/voice/twilio/{cid}/incoming", {"CallSid": "CA1", "From": "+919811000011"},
                   token="0" * 32)
    assert r.status_code == 403
    r = await hook(client, f"/hooks/voice/twilio/{cid}/incoming", {"CallSid": "CA1", "From": "+919811000011"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/xml")
    assert "Sharma Sweets&apos;s AI assistant" in r.text or "Sharma Sweets's AI assistant" in r.text
    turn = r.text.split('action="')[1].split('"')[0].replace("&amp;", "&")
    path = turn.split(get_settings().public_api_url.rstrip("/"))[1]
    brain(fake_llm,
          {"say": "Sure. May I have your name, and what would you like?", "action": "listen"},
          {"say": "Thank you Ravi, I've noted 20 kg kaju katli for Sunday. The team will call you back with the price.",
           "action": "take_message", "caller_name": "Ravi", "note": "20 kg kaju katli for Sunday, wants the price"},
          {"say": "Thank you for calling, goodbye!", "action": "end"})
    r = await hook(client, path, {"CallSid": "CA1", "SpeechResult": "I want to order sweets"})
    assert "May I have your name" in r.text and "<Gather" in r.text
    prompt = fake_llm.chat_calls(PHONE_BRAIN)[-1]["prompt"]
    assert "Caller: I want to order sweets" in prompt
    r = await hook(client, path, {"CallSid": "CA1", "SpeechResult": "Ravi, 20 kg kaju katli for Sunday"})
    assert "I've noted 20 kg kaju katli" in r.text
    r = await hook(client, path, {"CallSid": "CA1", "SpeechResult": "that's all, bye"})
    assert "<Hangup/>" in r.text
    r = await hook(client, f"/hooks/voice/twilio/{cid}/status", {"CallSid": "CA1", "CallStatus": "completed",
                                                                 "CallDuration": "74"})
    assert r.status_code == 204
    calls = (await mayank.get(f"/ventures/{v}/calls")).json()
    c = calls[0]
    assert c["outcome"] == "message_taken" and c["status"] == "completed" and c["duration_s"] == 74
    assert c["phone"] == "+91 98•••••011" and c["caller_name"] == "Ravi" and c["summary"].startswith("Ravi asked")
    assert c["lead_id"]
    detail = (await mayank.get(f"/ventures/{v}/calls/{c['id']}")).json()
    assert [t["who"] for t in detail["transcript"]][:3] == ["agent", "caller", "agent"]
    lead = (await mayank.get(f"/ventures/{v}/leads/{c['lead_id']}")).json()
    assert lead["name"] == "Ravi" and lead["source"] == "phone"
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        tasks = await conn.fetchval("SELECT count(*) FROM task_cards WHERE venture_id = $1", uuid.UUID(v))
    finally:
        await conn.close()
    assert tasks == 1


async def test_put_through_stop_calling_and_silence(shop, fake_llm, twilio, client):
    mayank, v = shop["mayank"], shop["v"]
    out = await connect(mayank, v, twilio)
    cid = out["number"]["voice_url"].split("/twilio/")[1].split("/")[0]
    base = get_settings().public_api_url.rstrip("/")

    async def start(sid):
        r = await hook(client, f"/hooks/voice/twilio/{cid}/incoming", {"CallSid": sid, "From": "+919822200022"})
        return r.text.split('action="')[1].split('"')[0].replace("&amp;", "&").split(base)[1]

    brain(fake_llm, {"say": "Of course.", "action": "transfer"})
    path = await start("CA2")
    r = await hook(client, path, {"CallSid": "CA2", "Digits": "0"})
    assert "<Dial" in r.text and "+919811000011" in r.text and "dial=1" in r.text
    after = r.text.split('<Dial timeout="25" action="')[1].split('"')[0].replace("&amp;", "&").split(base)[1]
    r = await hook(client, after, {"CallSid": "CA2", "DialCallStatus": "no-answer"})
    assert "nobody could pick up" in r.text and "<Gather" in r.text
    # "don't call me" on a call to the business: the number is never called by Kritvia, and the caller is
    # still helped with what they called about
    brain(fake_llm, {"say": "Okay, we won't call you. What else can I do for you?", "action": "opt_out"})
    path = await start("CA3")
    r = await hook(client, path, {"CallSid": "CA3", "SpeechResult": "Please don't call me again"})
    assert "won't call you" in r.text and "<Gather" in r.text and "<Hangup/>" not in r.text
    assert (await mayank.get(f"/ventures/{v}/voice")).json()["dnd_count"] == 1
    # two silences in a row: goodbye
    path = await start("CA4")
    r = await hook(client, path, {"CallSid": "CA4"})
    assert "didn't catch that" in r.text
    r = await hook(client, path, {"CallSid": "CA4"})
    assert "nobody is on the line" in r.text and "<Hangup/>" in r.text
    # a hook for another call's id is refused
    r = await hook(client, path, {"CallSid": "CA-other"})
    assert r.status_code == 404
    # switched off: the caller hears that calls can't be taken
    await mayank.put(f"/ventures/{v}/voice", json={"enabled": False, "language": "en-IN"})
    r = await hook(client, f"/hooks/voice/twilio/{cid}/incoming", {"CallSid": "CA5", "From": "+919822200022"})
    assert "can't take calls right now" in r.text and "<Hangup/>" in r.text


async def test_a_test_call_in_the_app(shop, fake_llm):
    mayank, v = shop["mayank"], shop["v"]
    brain(fake_llm, {"say": "We're open 10 to 7 every day except Sunday. और क्या मदद कर सकता/सकती हूँ?",
                     "action": "listen"},
          {"say": "Bye!", "action": "end"})
    first = (await mayank.post(f"/ventures/{v}/calls/test", json={})).json()
    assert "AI" in first["say"] and first["ended"] is False and first["language"] == "hi-IN"
    r = (await mayank.post(f"/ventures/{v}/calls/test", json={"call_id": first["call_id"], "said": "When are you open?"})).json()
    assert r["say"].startswith("We're open") and r["ended"] is False
    assert r["say"].endswith("और क्या मदद कर सकती हूँ?")  # one voice, not सकता/सकती read out
    r = (await mayank.post(f"/ventures/{v}/calls/test", json={"call_id": first["call_id"], "said": "ok bye"})).json()
    assert r["ended"] is True
    c = (await mayank.get(f"/ventures/{v}/calls")).json()[0]
    assert c["test"] is True and c["lead_id"] is None and c["summary"]
    assert (await shop["operator"].delete(f"/ventures/{v}/calls/{c['id']}")).status_code == 403
    assert (await mayank.delete(f"/ventures/{v}/calls/{c['id']}")).status_code == 204
    assert (await mayank.get(f"/ventures/{v}/calls/{c['id']}")).status_code == 404


async def test_outbound_calls_need_a_yes_and_the_registration(shop, fake_llm, twilio, client, monkeypatch):
    mayank, v = shop["mayank"], shop["v"]
    # before outbound calling is switched on: an approved call is a test call, nothing is dialled
    r = await mayank.post(f"/ventures/{v}/calls", json={"phone": "98330 00033", "name": "Priya",
                                                        "purpose": "tomorrow's 4 pm appointment"})
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["status"] == "waiting" and job["pending_approval_id"]
    a = (await mayank.get(f"/ventures/{v}/approvals/{job['pending_approval_id']}")).json()
    assert a["action"] == "voice.call" and a["payload"]["phone"] == "+919833000033"
    assert "AI" in a["payload"]["opening"] and "4 pm appointment" in a["payload"]["opening"]
    bad = await mayank.post(f"/ventures/{v}/approvals/{job['pending_approval_id']}/decision",
                            json={"decision": "approve", "edited_payload": {"phone": "+919999999999"}})
    assert bad.status_code == 422
    r = await mayank.post(f"/ventures/{v}/approvals/{job['pending_approval_id']}/decision", json={"decision": "approve"})
    assert r.status_code == 200, r.text
    assert twilio.placed == []
    calls = (await mayank.get(f"/ventures/{v}/calls")).json()
    assert calls[0]["direction"] == "outbound" and calls[0]["test"] is True and calls[0]["purpose"] == "tomorrow's 4 pm appointment"

    # switching outbound on needs the registration
    await connect(mayank, v, twilio)
    r = await mayank.put(f"/ventures/{v}/voice/outbound", json={"enabled": True})
    assert r.status_code == 422
    r = await mayank.put(f"/ventures/{v}/voice/outbound", json={"enabled": True, "dlt_entity_id": "1201159876543210",
                                                                "caller_id_kind": "160", "confirm": True})
    assert r.status_code == 200 and r.json()["outbound_enabled"] and r.json()["registered_at"]
    p = vc.Principal(uuid.UUID(shop["org"]), uuid.UUID(v), uuid.uuid4())
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        p.run_as = await conn.fetchval("SELECT user_id FROM memberships WHERE venture_id = $1 AND role = 'agent_runtime'",
                                       uuid.UUID(v))
    finally:
        await conn.close()
    noon = datetime(2026, 10, 19, 6, 30, tzinfo=UTC)          # 12:00 IST
    out = await vc.place(SERVICES, p, phone="+919833000033", callee="Priya", purpose="the appointment",
                         opening=None, created_by=None, approval_id=None, now=noon)
    assert out["placed"] is True and out["test"] is False
    assert twilio.placed[0]["to"] == "+919833000033" and twilio.placed[0]["from"].startswith("+91804567")
    assert "/outgoing?call=" in twilio.placed[0]["url"]
    with pytest.raises(vc.CallRefused, match="already called this number today"):
        await vc.place(SERVICES, p, phone="+919833000033", callee=None, purpose="x", opening=None, created_by=None,
                       approval_id=None, now=noon)
    with pytest.raises(vc.CallRefused, match="9 am and 9 pm"):
        await vc.place(SERVICES, p, phone="+919844400044", callee=None, purpose="x", opening=None, created_by=None,
                       approval_id=None, now=datetime(2026, 10, 19, 17, 0, tzinfo=UTC))   # 22:30 IST
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("INSERT INTO voice_dnd (venture_id, org_id, phone_hash, reason) VALUES ($1, $2, $3, 'team')",
                           uuid.UUID(v), uuid.UUID(shop["org"]), vc.phone_hash(uuid.UUID(v), "+919855500055"))
    finally:
        await conn.close()
    with pytest.raises(vc.CallRefused, match="asked not to be called"):
        await vc.place(SERVICES, p, phone="+919855500055", callee=None, purpose="x", opening=None, created_by=None,
                       approval_id=None, now=noon)
    # the customer picks up: the approved opening, then the conversation
    placed = next(c for c in (await mayank.get(f"/ventures/{v}/calls")).json() if not c["test"])
    cid = twilio.placed[0]["url"].split("/twilio/")[1].split("/")[0]
    r = await hook(client, f"/hooks/voice/twilio/{cid}/outgoing?call={placed['id']}", {"CallSid": "CA" + "9" * 32})
    assert "Sharma Sweets&apos;s AI assistant" in r.text or "Sharma Sweets's AI assistant" in r.text


async def test_roles_and_plan(shop, twilio, world):
    mayank, operator, v = shop["mayank"], shop["operator"], shop["v"]
    assert (await operator.put(f"/ventures/{v}/voice", json={"enabled": True})).status_code == 403
    assert (await operator.post(f"/ventures/{v}/voice/twilio", json={"account_sid": SID, "auth_token": TOKEN,
                                                                     "phone_number": "+918045671234"})).status_code == 403
    r = await mayank.post(f"/ventures/{v}/voice/twilio", json={"account_sid": SID, "auth_token": "e" * 32,
                                                               "phone_number": "+918045671234"})
    assert r.status_code == 422 and "didn't accept" in r.text
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("INSERT INTO org_plans (org_id, plan) VALUES ($1, 'starter')"
                           " ON CONFLICT (org_id) DO UPDATE SET plan = 'starter'", uuid.UUID(world["org"]))
        out = (await mayank.get(f"/ventures/{v}/voice")).json()
        assert out["plan_includes"] is False
        r = await mayank.post(f"/ventures/{v}/voice/twilio", json={"account_sid": SID, "auth_token": TOKEN,
                                                                   "phone_number": "+918045671234"})
        assert r.status_code == 402
    finally:
        await conn.execute("DELETE FROM org_plans WHERE org_id = $1", uuid.UUID(world["org"]))
        await conn.close()


async def test_what_the_assistant_knows_and_a_slow_model(shop, fake_llm, monkeypatch):
    mayank, v = shop["mayank"], shop["v"]
    facts = "Websites start at Rs 25,000. Office: Nihal Vihar, New Delhi. We reply to WhatsApp within a day."
    r = await mayank.put(f"/ventures/{v}/voice", json={"language": "hi-IN", "caller_facts": facts})
    assert r.status_code == 200 and r.json()["caller_facts"] == facts
    # saving other settings without the field keeps what callers can be told
    r = await mayank.put(f"/ventures/{v}/voice", json={"language": "hi-IN", "greeting": "Namaste!"})
    assert r.json()["caller_facts"] == facts
    assert (await shop["operator"].put(f"/ventures/{v}/voice", json={"caller_facts": "x"})).status_code == 403

    from kritvia_api.services import memory
    seen_kinds: list = []
    monkeypatch.setattr(memory, "search_as_agent",
                        lambda ctx, q, k=6, kinds=None, sensitive=False: _none(seen_kinds, kinds))

    brain(fake_llm, {"say": "We close at 7 pm today.", "action": "listen"},
          {"say": "Sorry about that. Which website do you need?", "action": "listen"},
          {"say": "Your number is 98110 00011, right?", "action": "listen"})
    call = (await mayank.post(f"/ventures/{v}/calls/test", json={})).json()["call_id"]
    say = lambda t: mayank.post(f"/ventures/{v}/calls/test", json={"call_id": call, "said": t})  # noqa: E731
    r = (await say("Hi, what time do you close today?")).json()
    assert r["say"] == "We close at 7 pm today." and r["ended"] is False
    system = fake_llm.chat_calls(PHONE_BRAIN)[-1]["prompt"]
    assert "Opening hours:" in system and "right now." in system and facts in system and "ENGLISH" in system
    assert "other customers" in system and "112" in system
    assert seen_kinds == [vc.CALLER_KINDS]
    # a complaint about a dropped call is not "don't call me": the call goes on
    r = (await say("Maine subah try kiya par call nahi lag raha tha")).json()
    assert r["ended"] is False and r["say"].startswith("Sorry about that")
    assert "Hindi in Roman letters" in fake_llm.chat_calls(PHONE_BRAIN)[-1]["prompt"]
    # numbers are read digit by digit; "ok" keeps the language the call was in
    r = (await say("ok")).json()
    assert r["say"] == "Your number is 9 8 1 1 0, 0 0 0 1 1, right?"
    assert "Hindi in Roman letters" in fake_llm.chat_calls(PHONE_BRAIN)[-1]["prompt"]

    # a model that doesn't answer in time: the caller hears that a message will be taken, not silence
    import asyncio

    from kritvia_api.services import llm

    async def slow(*a, **kw):
        await asyncio.sleep(5)
    monkeypatch.setattr(vc, "TURN_BUDGET_S", 0.2)
    monkeypatch.setattr(llm, "complete_json", slow)
    r = (await say("Price kya hai?")).json()
    assert r["ended"] is False and "उपलब्ध नहीं" in r["say"]


async def _none(seen: list, kinds):
    seen.append(kinds)
    return []
