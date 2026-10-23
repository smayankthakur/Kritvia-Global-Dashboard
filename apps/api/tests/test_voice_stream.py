"""Phone calls on Kritvia's own speech pipeline: audio helpers; speech providers with the business's own
keys (Sarvam, OpenAI-compatible, Deepgram, ElevenLabs, the local speech server); a live Exotel call over
the Voicebot WebSocket (greeting, turn detection, barge-in, goodbye, summary and lead); Exotel set-up and
outbound calls within India; Twilio in stream mode."""
from __future__ import annotations

import asyncio
import base64
import json
import math
import uuid

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, SERVICES, join, make_actor
from kritvia_api.config import get_settings
from kritvia_api.routers import calls as calls_router
from kritvia_api.services import exotel as ex
from kritvia_api.services import voice_calls as vc
from kritvia_api.services import voice_media as vm
from kritvia_api.services import voice_speech as vs
from kritvia_api.services import voice_stream as vstream

PHONE_BRAIN = "You are the AI phone assistant of"
SUMMARY = "You summarise a phone call"


def tone(ms: int, rate: int, hz: int = 300, amp: int = 8000) -> bytes:
    n = int(rate * ms / 1000)
    return b"".join(int(amp * math.sin(2 * math.pi * hz * i / rate)).to_bytes(2, "little", signed=True) for i in range(n))


# ------------------------------------------------------------------------------------------- audio --
def test_audio_helpers_and_turn_detection():
    t = tone(500, 8000)
    assert abs(vm.rms(vm.ulaw_to_pcm(vm.pcm_to_ulaw(t))) - vm.rms(t)) < 50
    assert abs(len(vm.resample(t, 8000, 16000)) - 2 * len(t)) <= 4
    pcm, rate = vm.from_wav(vm.to_wav(t, 8000))
    assert pcm == t and rate == 8000
    d = vm.TurnDetector(8000)
    ev = d.feed(vm.silence(400, 8000) + tone(600, 8000) + vm.silence(800, 8000))
    assert [e[0] for e in ev] == ["speech_start", "utterance"]
    # a click is not a turn
    d = vm.TurnDetector(8000)
    assert [e[0] for e in d.feed(vm.silence(400, 8000) + tone(140, 8000) + vm.silence(900, 8000))] == ["speech_start"]


# ---------------------------------------------------------------------------------- speech (BYOK) --
@pytest.fixture
def providers():
    seen: list[httpx.Request] = []

    def answer(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        u = str(req.url)
        if "sarvam" in u and u.endswith("/speech-to-text"):
            return httpx.Response(200, json={"request_id": "r", "transcript": "नमस्ते", "language_code": "hi-IN"})
        if "sarvam" in u and u.endswith("/text-to-speech"):
            wav = vm.to_wav(tone(300, 8000), 8000)
            return httpx.Response(200, json={"request_id": "r", "audios": [base64.b64encode(wav).decode()]})
        if "deepgram" in u:
            return httpx.Response(200, json={"results": {"channels": [{"alternatives": [{"transcript": "kaju katli chahiye"}]}]}})
        if "elevenlabs" in u:
            return httpx.Response(200, content=tone(200, 16000))
        if u.endswith("/audio/transcriptions"):
            return httpx.Response(200, json={"text": "what time do you open"})
        if u.endswith("/audio/speech"):
            if req.headers.get("authorization") == "Bearer bad-key-123":
                return httpx.Response(401, json={"error": {"message": "invalid key"}})
            return httpx.Response(200, content=tone(200, 24000))
        return httpx.Response(404)

    vs.set_transport(httpx.MockTransport(answer))
    yield seen
    vs.set_transport(None)


async def test_speech_providers_with_the_business_keys(providers, monkeypatch):
    actor = None
    pcm = tone(400, 8000)
    keys = {"sarvam": ("sk-sarvam", None), "openai": ("sk-openai", "https://api.groq.com/openai/v1"),
            "deepgram": ("dg-key", None), "elevenlabs": ("el-key", None)}
    st = vs.Stack(stt="sarvam", tts="sarvam", keys=keys)
    assert await vs.transcribe(SERVICES, actor, st, pcm, 8000) == "नमस्ते"
    req = providers[-1]
    assert req.headers["api-subscription-key"] == "sk-sarvam" and b"hi-IN" in req.content
    out = await vs.synthesize(st, "Namaste", 8000)
    assert len(out) == 2 * 2400                                     # 300 ms at 8 kHz
    body = json.loads(providers[-1].content)
    assert body["speaker"] == "anushka" and body["speech_sample_rate"] == 8000
    st = vs.Stack(stt="deepgram", tts="elevenlabs", keys=keys)
    assert await vs.transcribe(SERVICES, actor, st, pcm, 8000) == "kaju katli chahiye"
    assert providers[-1].headers["authorization"] == "Token dg-key" and "language=multi" in str(providers[-1].url)
    assert abs(len(await vs.synthesize(st, "Hello", 8000)) - 2 * 1600) <= 4
    assert providers[-1].headers["xi-api-key"] == "el-key" and "pcm_16000" in str(providers[-1].url)
    st = vs.Stack(stt="openai", tts="openai", keys=keys)
    assert await vs.transcribe(SERVICES, actor, st, pcm, 8000) == "what time do you open"
    assert str(providers[-1].url).startswith("https://api.groq.com/openai/v1/audio/transcriptions")
    assert abs(len(await vs.synthesize(st, "Hello", 8000)) - 2 * 1600) <= 4   # 24 kHz pcm -> 8 kHz
    with pytest.raises(vs.SpeechError, match="didn't accept the key"):
        await vs.synthesize(vs.Stack(tts="openai", keys={"openai": ("bad-key-123", None)}), "Hi", 8000)
    # the speech server on Kritvia's own machine
    monkeypatch.setattr(get_settings(), "voice_local_url", "http://whisper:8000/v1")
    st = vs.Stack(stt="local", tts="local")
    assert vs.tts_ready(st) is None
    assert await vs.transcribe(SERVICES, actor, st, pcm, 8000) == "what time do you open"
    assert str(providers[-1].url) == "http://whisper:8000/v1/audio/transcriptions"
    await vs.synthesize(st, "Namaste", 16000)
    assert json.loads(providers[-1].content)["model"].startswith("speaches-ai/Kokoro")
    monkeypatch.setattr(get_settings(), "voice_local_url", "")
    assert "isn't running" in vs.tts_ready(st)
    assert "save your elevenlabs key" in vs.tts_ready(vs.Stack(tts="elevenlabs"))
    # Kritvia's own voice is its speech server (never a provider whose terms allow training)
    assert "isn't set up" in vs.tts_ready(vs.Stack(tts="platform"))


# ---------------------------------------------------------------------------------- set-up & calls --
@pytest.fixture
async def shop(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Stream Shop", "slug": f"stream-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Sharma Sweets", "city": "Delhi"})
    operator = await make_actor(client, "stream-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


class FakeExotel:
    def __init__(self) -> None:
        self.placed: list[dict] = []

    async def check(self, a: ex.Account) -> None:
        if a.api_token != "tok-good-1234":
            raise ex.ExotelError("Exotel didn't accept the API key, token and account SID")

    async def place_call(self, a, *, to, caller_id, stream_url, status_url, custom) -> str:
        self.placed.append({"to": to, "caller_id": caller_id, "stream_url": stream_url, "status_url": status_url,
                            "custom": custom, "region": a.subdomain})
        return "exo-call-1"


@pytest.fixture
def exotel(monkeypatch):
    fake = FakeExotel()
    monkeypatch.setattr(SERVICES, "exotel", fake)
    return fake


NUMBERS = iter(range(2000, 9999))


async def connect_exotel(mayank, v) -> dict:
    r = await mayank.post(f"/ventures/{v}/voice/exotel", json={
        "api_key": "exo-key-1234", "api_token": "tok-good-1234", "account_sid": "sitelytc1",
        "exophone": f"080 4710 {next(NUMBERS)}"})
    assert r.status_code == 201, r.text
    return r.json()


async def speech(mayank, v, **body):
    r = await mayank.put(f"/ventures/{v}/voice/speech", json={"stt_provider": "sarvam", "tts_provider": "sarvam", **body})
    assert r.status_code == 200, r.text
    return r.json()


class FakeWS:
    def __init__(self, query: dict[str, str]) -> None:
        self.query_params = query
        self.inbox: asyncio.Queue[str] = asyncio.Queue()
        self.sent: list[dict] = []
        self.accepted = False
        self.closed_with: int | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000) -> None:
        self.closed_with = code

    async def receive_text(self) -> str:
        return await self.inbox.get()

    async def send_json(self, m: dict) -> None:
        self.sent.append(m)


def media(pcm: bytes, sid: str = "stream-1") -> str:
    return json.dumps({"event": "media", "stream_sid": sid, "sequence_number": "3",
                       "media": {"chunk": "1", "timestamp": "100", "payload": base64.b64encode(pcm).decode()}})


async def test_setting_up_exotel_and_the_voice(shop, exotel, providers):
    mayank, operator, v = shop["mayank"], shop["operator"], shop["v"]
    r = await mayank.post(f"/ventures/{v}/voice/exotel", json={
        "api_key": "exo-key-1234", "api_token": "tok-bad-1234", "account_sid": "sitelytc1", "exophone": "08047100000"})
    assert r.status_code == 422 and "didn't accept" in r.text
    out = await connect_exotel(mayank, v)
    link = out["voicebot_url"]
    assert link.startswith("ws") and "/hooks/voice/stream/exotel/" in link and "k=" in link and "sample-rate=16000" in link
    assert out["voice"]["exotel"]["number"].startswith("+918047") and out["voice"]["exotel"]["account"] == "ytc1"
    # keys are saved encrypted and never shown
    assert (await operator.put(f"/ventures/{v}/voice/keys/sarvam", json={"key": "sk-sarvam-123"})).status_code == 403
    r = await mayank.put(f"/ventures/{v}/voice/keys/sarvam", json={"key": "sk-sarvam-123"})
    assert r.status_code == 200 and "sk-sarvam" not in r.text and r.json()["keys"][0]["provider"] == "sarvam"
    bad = await mayank.put(f"/ventures/{v}/voice/keys/openai", json={"key": "sk-openai-123", "base_url": "https://10.0.0.5/v1"})
    assert bad.status_code == 422
    voice = await speech(mayank, v)
    assert voice["voice_problem"] is None and voice["tts_provider"] == "sarvam"
    r = await mayank.put(f"/ventures/{v}/voice/speech", json={"stt_provider": "local", "tts_provider": "local"})
    assert r.status_code == 422                                   # no local speech server on this machine
    # hear the voice
    r = await operator.post(f"/ventures/{v}/voice/speech/test", json={"text": "Namaste"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    # a new link replaces the old one
    r2 = await mayank.post(f"/ventures/{v}/voice/exotel/link")
    assert r2.status_code == 200 and r2.json()["voicebot_url"] != link


async def test_a_call_within_india_over_exotel(shop, exotel, providers, fake_llm, monkeypatch, client):
    mayank, v = shop["mayank"], shop["v"]
    out = await connect_exotel(mayank, v)
    await mayank.put(f"/ventures/{v}/voice", json={"enabled": True, "language": "hi-IN"})
    await mayank.put(f"/ventures/{v}/voice/keys/sarvam", json={"key": "sk-sarvam-123"})
    await speech(mayank, v)
    cid = uuid.UUID(out["voicebot_url"].split("/exotel/")[1].split("?")[0])
    secret = out["voicebot_url"].split("k=")[1].split("&")[0]

    heard = iter(["Mujhe 20 kilo kaju katli chahiye Sunday ke liye", "Ravi", "bas, dhanyavaad"])

    async def fake_stt(svc, actor, stack, pcm, rate):
        assert stack.stt == "sarvam" and rate == 16000
        return next(heard)

    async def fake_tts(stack, say, rate):
        return vm.silence(300, rate)
    monkeypatch.setattr(vs, "transcribe", fake_stt)
    monkeypatch.setattr(vs, "synthesize", fake_tts)
    replies = iter([
        {"say": "ज़रूर। आपका नाम क्या है?", "action": "listen"},
        {"say": "धन्यवाद रवि जी, मैंने नोट कर लिया है।", "action": "take_message", "caller_name": "Ravi",
         "note": "20 kg kaju katli for Sunday"},
        {"say": "नमस्ते!", "action": "end"}])
    fake_llm.on(PHONE_BRAIN, lambda m: next(replies))
    fake_llm.on(SUMMARY, {"summary": "Ravi wants 20 kg kaju katli for Sunday.", "caller_name": "Ravi"})

    # a wrong secret is refused before anything is accepted
    bad = FakeWS({"k": "nope"})
    await calls_router.exotel_stream(bad, cid)
    assert bad.closed_with == 1008 and not bad.accepted

    ws = FakeWS({"k": secret, "sample-rate": "16000"})
    task = asyncio.create_task(calls_router.exotel_stream(ws, cid))
    await ws.inbox.put(json.dumps({"event": "connected"}))
    await ws.inbox.put(json.dumps({"event": "start", "sequence_number": "1", "stream_sid": "stream-1", "start": {
        "stream_sid": "stream-1", "call_sid": "exo-in-1", "account_sid": "sitelytc1", "from": "09811000011",
        "to": out["voice"]["exotel"]["number"], "custom_parameters": {},
        "media_format": {"encoding": "raw", "sample_rate": "16000", "bit_rate": "128"}}}))

    async def until(cond, n=100):
        for _ in range(n):
            if cond():
                return
            await asyncio.sleep(0.05)
        raise AssertionError("timed out")

    await until(lambda: any(m.get("event") == "mark" for m in ws.sent))
    first = [m for m in ws.sent if m["event"] == "media"]
    assert first and all(len(base64.b64decode(m["media"]["payload"])) % 320 == 0 for m in first)
    assert all(len(base64.b64decode(m["media"]["payload"])) >= 3200 for m in first)
    assert ws.sent[-1] == {"event": "mark", "stream_sid": "stream-1", "mark": {"name": "m1"}}
    await ws.inbox.put(json.dumps({"event": "mark", "stream_sid": "stream-1", "mark": {"name": "m1"}}))

    async def say_something():
        n = len([m for m in ws.sent if m["event"] == "mark"])
        await ws.inbox.put(media(vm.silence(300, 16000) + tone(700, 16000) + vm.silence(900, 16000)))
        await until(lambda: len([m for m in ws.sent if m["event"] == "mark"]) > n)
        last = [m for m in ws.sent if m["event"] == "mark"][-1]["mark"]["name"]
        if last != "bye":
            await ws.inbox.put(json.dumps({"event": "mark", "stream_sid": "stream-1", "mark": {"name": last}}))

    await say_something()
    await say_something()
    await say_something()
    await until(lambda: task.done(), n=200)
    marks = [m["mark"]["name"] for m in ws.sent if m["event"] == "mark"]
    assert marks[-1] == "bye"
    c = (await mayank.get(f"/ventures/{v}/calls")).json()[0]
    assert c["outcome"] == "message_taken" and c["caller_name"] == "Ravi" and c["phone"] == "+91 98•••••011"
    assert c["summary"].startswith("Ravi wants") and c["lead_id"]
    detail = (await mayank.get(f"/ventures/{v}/calls/{c['id']}")).json()
    assert [t["who"] for t in detail["transcript"]] == ["agent", "caller", "agent", "caller", "agent", "caller", "agent"]


async def test_barge_in_clears_kritvias_voice(shop, providers, monkeypatch):
    v = uuid.UUID(shop["v"])
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        run_as = await conn.fetchval("SELECT user_id FROM memberships WHERE venture_id = $1 AND role = 'agent_runtime'", v)
        await conn.execute("INSERT INTO voice_keys (venture_id, org_id, provider, key_enc) SELECT $1, org_id, 'sarvam', 'x'"
                           " FROM ventures WHERE id = $1", v)
    finally:
        await conn.close()
    sent: list[dict] = []

    async def send(m):
        sent.append(m)
    s = vstream.StreamSession(SERVICES, vc.Principal(uuid.UUID(shop["org"]), v, run_as), vstream.ExotelAdapter(), send,
                              no_input_s=60)
    s.detector = vm.TurnDetector(8000)
    s.adapter.sid = "st"
    import time
    s.speaking_until = time.monotonic() + 30          # Kritvia is speaking
    s._media({"media": {"payload": base64.b64encode(vm.silence(200, 8000) + tone(300, 8000)).decode()}})
    await s.idle()
    assert {"event": "clear", "stream_sid": "st"} in sent and "barge-in" in s.log and not s.speaking


async def test_outbound_calls_within_india_go_through_exotel(shop, exotel, twilio_off, providers, client):
    mayank, v = shop["mayank"], shop["v"]
    await connect_exotel(mayank, v)
    await mayank.put(f"/ventures/{v}/voice", json={"enabled": True})
    r = await mayank.put(f"/ventures/{v}/voice/outbound", json={"enabled": True, "dlt_entity_id": "1201159876543210",
                                                                "caller_id_kind": "160", "confirm": True})
    assert r.status_code == 200, r.text
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        run_as = await conn.fetchval("SELECT user_id FROM memberships WHERE venture_id = $1 AND role = 'agent_runtime'",
                                     uuid.UUID(v))
    finally:
        await conn.close()
    from datetime import UTC, datetime
    p = vc.Principal(uuid.UUID(shop["org"]), uuid.UUID(v), run_as)
    out = await vc.place(SERVICES, p, phone="98330 00033", callee="Priya", purpose="tomorrow's appointment",
                         opening=None, created_by=None, approval_id=None, now=datetime(2026, 10, 19, 6, 30, tzinfo=UTC))
    assert out["placed"] is True
    placed = exotel.placed[0]
    assert placed["to"] == "+919833000033" and placed["caller_id"].startswith("+918047")
    assert "/hooks/voice/stream/exotel/" in placed["stream_url"] and f"call={out['call_id']}" in placed["stream_url"]
    assert placed["custom"] == out["call_id"] and placed["region"] == "api.in.exotel.com"
    # the status callback is signed; "no answer" finishes the call
    path = placed["status_url"].split(get_settings().public_api_url.rstrip("/"))[1]
    forged = path.split("sig=")[0] + "sig=" + "0" * 40
    assert (await client.post(forged, data={"Status": "no-answer"})).status_code == 403
    r = await client.post(path, data={"CallSid": "exo-call-1", "Status": "no-answer"})
    assert r.status_code == 204
    c = next(c for c in (await mayank.get(f"/ventures/{v}/calls")).json() if c["id"] == out["call_id"])
    assert c["status"] == "no_answer"
    # the stream link for that call is signed too
    cid = uuid.UUID(placed["stream_url"].split("/exotel/")[1].split("?")[0])
    ws = FakeWS({"call": out["call_id"], "sig": "f" * 40})
    await calls_router.exotel_stream(ws, cid)
    assert ws.closed_with == 1008


@pytest.fixture
def twilio_off(monkeypatch):
    class NoTwilio:
        async def place_call(self, *a, **k):
            raise AssertionError("Twilio must not be used for an Indian call when Exotel is connected")
    monkeypatch.setattr(SERVICES, "twilio", NoTwilio())


async def test_twilio_in_stream_mode_uses_kritvias_voice(shop, providers, client, monkeypatch):
    from kritvia_api.services import twilio_voice as tw
    mayank, v = shop["mayank"], shop["v"]

    class FakeTwilio:
        async def number(self, sid, token, phone):
            return {"sid": "PN" + "3" * 32, "capabilities": {"voice": True}}

        async def point_number(self, *a):
            return None
    monkeypatch.setattr(SERVICES, "twilio", FakeTwilio())
    token = "e" * 32
    r = await mayank.post(f"/ventures/{v}/voice/twilio", json={"account_sid": "AC" + "4" * 32, "auth_token": token,
                                                               "phone_number": f"+1 415 555 {next(NUMBERS)}"})
    assert r.status_code == 201, r.text
    await mayank.put(f"/ventures/{v}/voice", json={"enabled": True, "language": "en-IN"})
    await mayank.put(f"/ventures/{v}/voice/keys/openai", json={"key": "sk-openai-123"})
    await speech(mayank, v, stt_provider="openai", tts_provider="openai", twilio_mode="stream")
    cid = r.json()["number"]["voice_url"].split("/twilio/")[1].split("/")[0]
    path = f"/hooks/voice/twilio/{cid}/incoming"
    form = {"CallSid": "CA-stream-1", "From": "+14155550100"}
    url = get_settings().public_api_url.rstrip("/") + path
    r = await client.post(path, data=form, headers={"X-Twilio-Signature": tw.signature(token, url, form)})
    assert r.status_code == 200 and "<Connect><Stream url=" in r.text and "/hooks/voice/stream/twilio/" in r.text
    assert '<Parameter name="call"' in r.text and '<Parameter name="sig"' in r.text and "<Hangup/>" in r.text
    call_id = r.text.split('name="call" value="')[1].split('"')[0]
    sig = r.text.split('name="sig" value="')[1].split('"')[0]
    assert vc.stream_link_ok(uuid.UUID(cid), call_id, sig)
    # without a voice set up it falls back to Twilio's own speech
    await speech(mayank, v, stt_provider="platform", tts_provider="elevenlabs", twilio_mode="stream")
    form = {"CallSid": "CA-stream-2", "From": "+14155550100"}
    r = await client.post(path, data=form, headers={"X-Twilio-Signature": tw.signature(token, url, form)})
    assert "<Gather" in r.text and "<Stream" not in r.text


def test_adapters_speak_each_phone_companys_format():
    a = vstream.TwilioAdapter()
    a.start({"event": "start", "start": {"streamSid": "MZ1", "callSid": "CA1", "customParameters": {"call": "x"}}})
    chunks = a.chunks(vm.silence(400, 8000))
    assert chunks[0]["streamSid"] == "MZ1" and sum(len(base64.b64decode(c["media"]["payload"])) for c in chunks) == 3200
    assert a.clear() == {"event": "clear", "streamSid": "MZ1"}
    e = vstream.ExotelAdapter()
    info = e.start({"event": "start", "stream_sid": "S1", "start": {"call_sid": "C1", "from": "0981", "media_format": {
        "encoding": "audio/x-mulaw", "sample_rate": "8000"}}})
    assert e.mulaw and e.rate == 8000 and info["call_sid"] == "C1"
    assert len(base64.b64decode(e.chunks(vm.silence(50, 8000))[0]["media"]["payload"])) == 3200
