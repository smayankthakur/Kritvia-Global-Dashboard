"""AI phone calls (services/voice_calls.py, services/twilio_voice.py).

App:
  GET    /ventures/{v}/voice                 settings, the connected number, what's ready
  PUT    /ventures/{v}/voice                 answering: on/off, language, voice, greeting, put-through number, hours
  PUT    /ventures/{v}/voice/outbound        outbound calling: the business's DLT registration (admins confirm it)
  POST   /ventures/{v}/voice/twilio          connect the business's Twilio number (checked; webhooks pointed here)
  DELETE /ventures/{v}/voice/twilio          disconnect it
  POST   /ventures/{v}/calls/test            a test call in the app: you are the caller
  POST   /ventures/{v}/calls                 ask Kritvia to phone a customer (waits for a yes)
  GET    /ventures/{v}/calls                 recent calls with summaries
  GET    /ventures/{v}/calls/{id}            one call with what was said
  DELETE /ventures/{v}/calls/{id}            delete it (admins)
Twilio (signed with the business's auth token):
  POST   /hooks/voice/twilio/{connector}/incoming | /turn | /outgoing | /status
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, WebSocket, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services import twilio_voice as tw
from kritvia_api.services import voice_calls as vc
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted, plan_for_venture
from kritvia_api.services.security_log import security_event

router = APIRouter(tags=["calls"])
SECRET = "connector.secret"
XML = "application/xml"


def _url(path: str) -> str:
    return get_settings().public_api_url.rstrip("/") + path


def hook_urls(cid: uuid.UUID) -> dict[str, str]:
    return {"voice_url": _url(f"/hooks/voice/twilio/{cid}/incoming"), "status_url": _url(f"/hooks/voice/twilio/{cid}/status")}


async def _can_admin(db, venture_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())


async def _can_write(db, venture_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar())


# ------------------------------------------------------------------------------------------ settings --
class VoiceNumber(BaseModel):
    number: str
    account: str = Field(description="the account SID's last 4 characters")
    status: str
    voice_url: str
    status_url: str


class ExotelNumber(BaseModel):
    number: str
    account: str = Field(description="the account SID's last 4 characters")
    region: str
    status: str
    status_url: str


class VoiceKeyOut(BaseModel):
    provider: Literal["sarvam", "openai", "deepgram", "elevenlabs"]
    base_url: str | None
    updated_at: datetime


class VoiceOut(BaseModel):
    enabled: bool
    language: Literal["hi-IN", "en-IN"]
    voice: Literal["Polly.Aditi", "Polly.Raveena", "Polly.Kajal-Neural"]
    greeting: str | None
    greeting_preview: str
    transfer_number: str | None
    open_days: list[int]
    open_from: str
    open_to: str
    max_minutes: int
    outbound_enabled: bool
    dlt_entity_id: str | None
    caller_id_kind: Literal["160", "landline", "other"] | None
    registered_at: datetime | None
    number: VoiceNumber | None
    plan_includes: bool
    can_admin: bool
    answering: bool = Field(description="calls to the connected number are answered now")
    dnd_count: int
    exotel: ExotelNumber | None = None
    twilio_mode: Literal["gather", "stream"] = "gather"
    stt_provider: Literal["platform", "sarvam", "openai", "deepgram", "local"] = "platform"
    tts_provider: Literal["platform", "sarvam", "openai", "elevenlabs", "local"] = "platform"
    stt_model: str | None = None
    tts_model: str | None = None
    tts_voice: str | None = None
    keys: list[VoiceKeyOut] = Field(default_factory=list, description="speech keys saved (never shown)")
    local_available: bool = Field(default=False, description="the speech server on Kritvia's own machine is set up")
    platform_voice: bool = Field(default=False, description="Kritvia's own voice (its speech server) is set up")
    voice_problem: str | None = Field(default=None, description="why Kritvia can't speak with these settings, if so")


class VoiceIn(BaseModel):
    enabled: bool = False
    language: Literal["hi-IN", "en-IN"] = "hi-IN"
    voice: Literal["Polly.Aditi", "Polly.Raveena", "Polly.Kajal-Neural"] = "Polly.Aditi"
    greeting: str | None = Field(default=None, max_length=300)
    transfer_number: str | None = Field(default=None, max_length=20)
    open_days: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4, 5], max_length=7)
    open_from: str = Field(default="10:00", pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    open_to: str = Field(default="19:00", pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    max_minutes: int = Field(default=8, ge=2, le=20)

    @field_validator("transfer_number")
    @classmethod
    def _phone(cls, v: str | None) -> str | None:
        if not (v or "").strip():
            return None
        p = tw.normalise_phone(v or "")
        if p is None:
            raise ValueError("the put-through number doesn't look right")
        return p

    @field_validator("open_days")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("days are 0 (Monday) to 6 (Sunday)")
        return sorted(set(v))


class OutboundIn(BaseModel):
    enabled: bool
    dlt_entity_id: str | None = Field(default=None, pattern=r"^[0-9]{10,25}$",
                                      description="the business's Principal Entity ID on a TRAI DLT platform")
    caller_id_kind: Literal["160", "landline", "other"] | None = None
    confirm: bool = Field(default=False, description="the admin confirms the registration and that calls are only to "
                                                     "the business's own customers, for service (not promotion)")


async def _voice_out(db, svc, venture_id: uuid.UUID) -> VoiceOut:
    from kritvia_api.services import voice_speech as vs
    s = await vc.settings_for(db, venture_id)
    cons = {r.provider: r for r in (await db.execute(text(
        "SELECT id, provider, meta ->> 'account_sid' AS account_sid, meta ->> 'subdomain' AS subdomain, account_email,"
        " status FROM connectors WHERE venture_id = :v AND provider IN ('twilio_voice', 'exotel_voice')"),
        {"v": venture_id})).all()}
    con, exo = cons.get("twilio_voice"), cons.get("exotel_voice")
    kind = (await db.execute(text("SELECT coalesce(kind, 'general') FROM venture_settings WHERE venture_id = :v"),
                             {"v": venture_id})).scalar() or "general"
    p = await plan_for_venture(db, venture_id)
    includes = p.allows_integration("voice") and p.allows_agent("voice_call", kind)
    name, _ = await vc.business_line(db, venture_id)
    dnd = (await db.execute(text("SELECT count(*) FROM voice_dnd WHERE venture_id = :v"), {"v": venture_id})).scalar()
    sp = (await db.execute(text("SELECT stt_provider, tts_provider, stt_model, tts_model, tts_voice FROM phone_settings"
                                " WHERE venture_id = :v"), {"v": venture_id})).first()
    keys = (await db.execute(text("SELECT provider, base_url, updated_at FROM voice_keys WHERE venture_id = :v"
                                  " ORDER BY provider"), {"v": venture_id})).all()
    stack = vs.Stack(stt=sp.stt_provider if sp else "platform", tts=sp.tts_provider if sp else "platform",
                     keys={k.provider: ("saved", k.base_url) for k in keys})
    number = None
    if con is not None:
        number = VoiceNumber(number=con.account_email or "", account=(con.account_sid or "")[-4:], status=con.status,
                             **hook_urls(con.id))
    exotel = None
    if exo is not None:
        exotel = ExotelNumber(number=exo.account_email or "", account=(exo.account_sid or "")[-4:],
                              region=exo.subdomain or "api.in.exotel.com", status=exo.status,
                              status_url=_url(f"/hooks/voice/exotel/{exo.id}/status"))
    live = any(c is not None and c.status == "active" for c in (con, exo))
    st = get_settings()
    return VoiceOut(enabled=s.enabled, language=s.language, voice=s.voice, greeting=s.greeting,
                    greeting_preview=vc.greeting(name, s), transfer_number=s.transfer_number, open_days=list(s.open_days),
                    open_from=s.open_from, open_to=s.open_to, max_minutes=s.max_minutes,
                    outbound_enabled=s.outbound_enabled, dlt_entity_id=s.dlt_entity_id, caller_id_kind=s.caller_id_kind,
                    registered_at=s.registered_at, number=number, plan_includes=includes,
                    can_admin=await _can_admin(db, venture_id),
                    answering=bool(s.enabled and includes and live),
                    dnd_count=int(dnd or 0), exotel=exotel, twilio_mode=s.twilio_mode,  # type: ignore[arg-type]
                    stt_provider=stack.stt, tts_provider=stack.tts,  # type: ignore[arg-type]
                    stt_model=sp.stt_model if sp else None, tts_model=sp.tts_model if sp else None,
                    tts_voice=sp.tts_voice if sp else None,
                    keys=[VoiceKeyOut(provider=k.provider, base_url=k.base_url, updated_at=k.updated_at) for k in keys],
                    local_available=bool(st.voice_local_url), platform_voice=bool(st.voice_local_url),
                    voice_problem=vs.tts_ready(stack))


@router.get("/ventures/{venture_id}/voice", response_model=VoiceOut)
async def get_voice(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> VoiceOut:
    await venture_org(db, venture_id)
    return await _voice_out(db, svc, venture_id)


@router.put("/ventures/{venture_id}/voice", response_model=VoiceOut)
async def put_voice(venture_id: uuid.UUID, body: VoiceIn, user_id: UserId, db: TenantDB, svc: Svc) -> VoiceOut:
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin changes how calls are answered")
    if body.open_from >= body.open_to:
        raise HTTPException(422, "the opening time must be before the closing time")
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO phone_settings (venture_id, org_id, enabled, language, voice, greeting, transfer_number,"
                " open_days, open_from, open_to, max_minutes, updated_by)"
                " VALUES (:v, :o, :e, :l, :vo, :g, :t, :d, :f, :to, :m, :u)"
                " ON CONFLICT (venture_id) DO UPDATE SET enabled = EXCLUDED.enabled, language = EXCLUDED.language,"
                " voice = EXCLUDED.voice, greeting = EXCLUDED.greeting, transfer_number = EXCLUDED.transfer_number,"
                " open_days = EXCLUDED.open_days, open_from = EXCLUDED.open_from, open_to = EXCLUDED.open_to,"
                " max_minutes = EXCLUDED.max_minutes, updated_by = EXCLUDED.updated_by, updated_at = now()"),
                {"v": venture_id, "o": org, "e": body.enabled, "l": body.language, "vo": body.voice,
                 "g": (body.greeting or "").strip() or None, "t": body.transfer_number, "d": body.open_days,
                 "f": body.open_from, "to": body.open_to, "m": body.max_minutes, "u": user_id})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await _voice_out(db, svc, venture_id)


@router.put("/ventures/{venture_id}/voice/outbound", response_model=VoiceOut)
async def put_outbound(venture_id: uuid.UUID, body: OutboundIn, user_id: UserId, db: TenantDB, svc: Svc) -> VoiceOut:
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin switches on outbound calls")
    if body.enabled and not (body.dlt_entity_id and body.caller_id_kind and body.confirm):
        raise HTTPException(422, "outbound calls need the DLT entity ID, the caller-id type and your confirmation")
    params = {"v": venture_id, "o": org, "e": body.enabled, "d": body.dlt_entity_id, "k": body.caller_id_kind,
              "u": user_id}
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO phone_settings (venture_id, org_id, outbound_enabled, dlt_entity_id, caller_id_kind,"
                " registered_by, registered_at, updated_by)"
                " VALUES (:v, :o, :e, :d, :k, CASE WHEN :e THEN CAST(:u AS uuid) END, CASE WHEN :e THEN now() END, :u)"
                " ON CONFLICT (venture_id) DO UPDATE SET outbound_enabled = EXCLUDED.outbound_enabled,"
                " dlt_entity_id = coalesce(EXCLUDED.dlt_entity_id, phone_settings.dlt_entity_id),"
                " caller_id_kind = coalesce(EXCLUDED.caller_id_kind, phone_settings.caller_id_kind),"
                " registered_by = CASE WHEN :e THEN CAST(:u AS uuid) ELSE phone_settings.registered_by END,"
                " registered_at = CASE WHEN :e THEN now() ELSE phone_settings.registered_at END,"
                " updated_by = :u, updated_at = now()"), params)
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await _voice_out(db, svc, venture_id)


class TwilioIn(BaseModel):
    account_sid: str = Field(pattern=r"^AC[0-9a-f]{32}$")
    auth_token: str = Field(min_length=32, max_length=64, pattern=r"^[0-9a-f]{32,64}$",
                            description="checked with Twilio, stored encrypted, never shown again")
    phone_number: str = Field(min_length=8, max_length=20)
    point_number: bool = Field(default=True, description="set the number's voice and status webhooks to Kritvia")


@router.post("/ventures/{venture_id}/voice/twilio", response_model=VoiceOut, status_code=201)
async def connect_twilio(venture_id: uuid.UUID, body: TwilioIn, user_id: UserId, db: TenantDB, svc: Svc) -> VoiceOut:
    from kritvia_api.services.quota import require_integration
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin connects a phone number")
    await require_integration(db, venture_id, "voice")
    await limiter.hit(f"twilio-connect:{venture_id}", per_minute=3)
    phone = tw.normalise_phone(body.phone_number)
    if phone is None:
        raise HTTPException(422, "that phone number doesn't look right")
    try:
        n = await svc.twilio.number(body.account_sid, body.auth_token, phone)
    except tw.TwilioError as exc:
        raise HTTPException(422, str(exc)) from None
    try:
        async with db.begin_nested():
            cid = (await db.execute(text(
                "INSERT INTO connectors (org_id, venture_id, provider, account_email, external_id, scopes, meta, created_by)"
                " VALUES (:o, :v, 'twilio_voice', :n, :n, ARRAY['voice'], CAST(:m AS jsonb), :u)"
                " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', account_email = EXCLUDED.account_email,"
                " external_id = EXCLUDED.external_id, meta = EXCLUDED.meta, last_error = NULL, updated_at = now()"
                " RETURNING id"),
                {"o": org, "v": venture_id, "n": phone, "u": user_id,
                 "m": json.dumps({"number_sid": n.get("sid"), "account_sid": body.account_sid})})).scalar_one()
            enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, SECRET, body.auth_token)
            await db.execute(text(
                "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
                " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
                {"c": cid, "o": org, "v": venture_id, "s": enc})
    except DBAPIError as exc:
        from kritvia_api.errors import sqlstate
        if sqlstate(exc) == "23505":
            raise HTTPException(status.HTTP_409_CONFLICT, "that number is already connected to another business") from None
        raise_for_db(exc, "venture not found")
    if body.point_number and n.get("sid"):
        urls = hook_urls(cid)
        try:
            await svc.twilio.point_number(body.account_sid, body.auth_token, n["sid"], urls["voice_url"], urls["status_url"])
        except tw.TwilioError as exc:
            raise HTTPException(422, f"Connected, but the number's webhooks couldn't be set: {exc}. "
                                     "Set them in Twilio by hand (shown below).") from None
    return await _voice_out(db, svc, venture_id)


@router.delete("/ventures/{venture_id}/voice/twilio", response_model=VoiceOut)
async def disconnect_twilio(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> VoiceOut:
    await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin disconnects the phone number")
    await db.execute(text("UPDATE connectors SET status = 'revoked', updated_at = now()"
                          " WHERE venture_id = :v AND provider = 'twilio_voice'"), {"v": venture_id})
    await db.execute(text("DELETE FROM connector_tokens WHERE connector_id IN (SELECT id FROM connectors"
                          " WHERE venture_id = :v AND provider = 'twilio_voice')"), {"v": venture_id})
    return await _voice_out(db, svc, venture_id)


# ------------------------------------------------------------------------------ speech (BYOK) --
class SpeechIn(BaseModel):
    twilio_mode: Literal["gather", "stream"] = "gather"
    stt_provider: Literal["platform", "sarvam", "openai", "deepgram", "local"] = "platform"
    tts_provider: Literal["platform", "sarvam", "openai", "elevenlabs", "local"] = "platform"
    stt_model: str | None = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9._:/-]*$")
    tts_model: str | None = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9._:/-]*$")
    tts_voice: str | None = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9._:-]*$")


class KeyIn(BaseModel):
    key: str = Field(min_length=8, max_length=400, description="stored encrypted, never shown again")
    base_url: str | None = Field(default=None, max_length=300,
                                 description="OpenAI-compatible server instead of api.openai.com (https only)")

    @field_validator("base_url")
    @classmethod
    def _base(cls, v: str | None) -> str | None:
        v = (v or "").strip().rstrip("/")
        if not v:
            return None
        if not v.startswith("https://") or any(c.isspace() for c in v):
            raise ValueError("the server address must start with https://")
        import ipaddress
        from urllib.parse import urlsplit
        host = (urlsplit(v).hostname or "").lower()
        try:
            public = ipaddress.ip_address(host).is_global
        except ValueError:
            public = "." in host and not host.endswith((".local", ".internal", ".localhost", ".lan"))
        if not public:
            raise ValueError("the server must be on the public internet")
        return v


class SpeechTestIn(BaseModel):
    text: str | None = Field(default=None, max_length=300)


@router.put("/ventures/{venture_id}/voice/speech", response_model=VoiceOut)
async def put_speech(venture_id: uuid.UUID, body: SpeechIn, user_id: UserId, db: TenantDB, svc: Svc) -> VoiceOut:
    """Whose speech-to-text and voice calls use: Kritvia's, your own keys, or the speech server on Kritvia's machine."""
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin changes the voice")
    if "local" in (body.stt_provider, body.tts_provider) and not get_settings().voice_local_url:
        raise HTTPException(422, "the local speech server isn't set up on this server")
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO phone_settings (venture_id, org_id, twilio_mode, stt_provider, tts_provider, stt_model,"
                " tts_model, tts_voice, updated_by) VALUES (:v, :o, :m, :s, :t, :sm, :tm, :tv, :u)"
                " ON CONFLICT (venture_id) DO UPDATE SET twilio_mode = EXCLUDED.twilio_mode,"
                " stt_provider = EXCLUDED.stt_provider, tts_provider = EXCLUDED.tts_provider,"
                " stt_model = EXCLUDED.stt_model, tts_model = EXCLUDED.tts_model, tts_voice = EXCLUDED.tts_voice,"
                " updated_by = EXCLUDED.updated_by, updated_at = now()"),
                {"v": venture_id, "o": org, "m": body.twilio_mode, "s": body.stt_provider, "t": body.tts_provider,
                 "sm": body.stt_model or None, "tm": body.tts_model or None, "tv": body.tts_voice or None, "u": user_id})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await _voice_out(db, svc, venture_id)


@router.put("/ventures/{venture_id}/voice/keys/{provider}", response_model=VoiceOut)
async def put_key(venture_id: uuid.UUID, provider: Literal["sarvam", "openai", "deepgram", "elevenlabs"], body: KeyIn,
                  user_id: UserId, db: TenantDB, svc: Svc) -> VoiceOut:
    from kritvia_api.services import voice_speech as vs
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin saves speech keys")
    if body.base_url and provider != "openai":
        raise HTTPException(422, "a server address is only for OpenAI-compatible servers")
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, vs.KEY, body.key.strip())
    await db.execute(text(
        "INSERT INTO voice_keys (venture_id, org_id, provider, key_enc, base_url, updated_by)"
        " VALUES (:v, :o, :p, :k, :b, :u) ON CONFLICT (venture_id, provider) DO UPDATE SET key_enc = EXCLUDED.key_enc,"
        " base_url = EXCLUDED.base_url, updated_by = EXCLUDED.updated_by, updated_at = now()"),
        {"v": venture_id, "o": org, "p": provider, "k": enc, "b": body.base_url, "u": user_id})
    return await _voice_out(db, svc, venture_id)


@router.delete("/ventures/{venture_id}/voice/keys/{provider}", response_model=VoiceOut)
async def delete_key(venture_id: uuid.UUID, provider: Literal["sarvam", "openai", "deepgram", "elevenlabs"],
                     db: TenantDB, svc: Svc) -> VoiceOut:
    await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin removes speech keys")
    await db.execute(text("DELETE FROM voice_keys WHERE venture_id = :v AND provider = :p"),
                     {"v": venture_id, "p": provider})
    return await _voice_out(db, svc, venture_id)


@router.post("/ventures/{venture_id}/voice/speech/test", response_class=Response)
async def test_voice(venture_id: uuid.UUID, body: SpeechTestIn, user_id: UserId, db: TenantDB, svc: Svc) -> Response:
    """Hear the voice calls use (a short WAV), to check the provider and key."""
    from kritvia_api.services import voice_media as vm
    from kritvia_api.services import voice_speech as vs
    await venture_org(db, venture_id)
    if not await _can_write(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "trying the voice needs an operator or admin role")
    await limiter.hit(f"voice-test:{user_id}", per_minute=6)
    stack = await vs.stack_for(db, EnvelopeCrypto(db, svc.keys), venture_id)
    why = vs.tts_ready(stack)
    if why:
        raise HTTPException(422, why)
    name, _ = await vc.business_line(db, venture_id)
    s = await vc.settings_for(db, venture_id)
    say = (body.text or "").strip() or vc.greeting(name, s)
    try:
        pcm = await vs.synthesize(stack, say, 16000)
    except vs.SpeechError as exc:
        raise HTTPException(422, str(exc)) from None
    return Response(content=vm.to_wav(pcm, 16000), media_type="audio/wav")


# --------------------------------------------------------------------------------- Exotel (India) --
class ExotelIn(BaseModel):
    api_key: str = Field(min_length=8, max_length=120, pattern=r"^[A-Za-z0-9_-]+$")
    api_token: str = Field(min_length=8, max_length=200, pattern=r"^[A-Za-z0-9_-]+$",
                           description="checked with Exotel, stored encrypted, never shown again")
    account_sid: str = Field(min_length=3, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    region: Literal["api.in.exotel.com", "api.exotel.com"] = "api.in.exotel.com"
    exophone: str = Field(min_length=8, max_length=20)


class ExotelLinkOut(BaseModel):
    voicebot_url: str = Field(description="paste into the Voicebot applet of your Exotel flow; shown only now")
    voice: VoiceOut


def _exotel_link(cid: uuid.UUID, secret: str) -> str:
    base = get_settings().public_api_url.rstrip("/").replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    return f"{base}/hooks/voice/stream/exotel/{cid}?k={secret}&sample-rate=16000"


@router.post("/ventures/{venture_id}/voice/exotel", response_model=ExotelLinkOut, status_code=201)
async def connect_exotel(venture_id: uuid.UUID, body: ExotelIn, user_id: UserId, db: TenantDB, svc: Svc) -> ExotelLinkOut:
    """Connect the business's Exotel number (ExoPhone): calls within India. The Voicebot link is shown once."""
    import hashlib
    import secrets
    from kritvia_api.services import exotel as ex
    from kritvia_api.services.quota import require_integration
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin connects a phone number")
    await require_integration(db, venture_id, "voice")
    await limiter.hit(f"exotel-connect:{venture_id}", per_minute=3)
    phone = tw.normalise_phone(body.exophone)
    if phone is None:
        raise HTTPException(422, "that ExoPhone number doesn't look right")
    acct = ex.Account(body.api_key, body.api_token, body.account_sid, body.region)
    try:
        await svc.exotel.check(acct)
    except ex.ExotelError as exc:
        raise HTTPException(422, str(exc)) from None
    secret = secrets.token_urlsafe(24)
    meta = {"account_sid": body.account_sid, "api_key": body.api_key, "subdomain": body.region,
            "secret_hash": hashlib.sha256(secret.encode()).hexdigest()}
    try:
        async with db.begin_nested():
            cid = (await db.execute(text(
                "INSERT INTO connectors (org_id, venture_id, provider, account_email, external_id, scopes, meta, created_by)"
                " VALUES (:o, :v, 'exotel_voice', :n, :n, ARRAY['voice'], CAST(:m AS jsonb), :u)"
                " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', account_email = EXCLUDED.account_email,"
                " external_id = EXCLUDED.external_id, meta = EXCLUDED.meta, last_error = NULL, updated_at = now()"
                " RETURNING id"),
                {"o": org, "v": venture_id, "n": phone, "u": user_id, "m": json.dumps(meta)})).scalar_one()
            enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, SECRET, body.api_token)
            await db.execute(text(
                "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
                " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
                {"c": cid, "o": org, "v": venture_id, "s": enc})
    except DBAPIError as exc:
        from kritvia_api.errors import sqlstate
        if sqlstate(exc) == "23505":
            raise HTTPException(status.HTTP_409_CONFLICT, "that number is already connected to another business") from None
        raise_for_db(exc, "venture not found")
    return ExotelLinkOut(voicebot_url=_exotel_link(cid, secret), voice=await _voice_out(db, svc, venture_id))


@router.post("/ventures/{venture_id}/voice/exotel/link", response_model=ExotelLinkOut)
async def new_exotel_link(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> ExotelLinkOut:
    """A new Voicebot link (the old one stops working)."""
    import hashlib
    import secrets
    await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin changes the Voicebot link")
    secret = secrets.token_urlsafe(24)
    cid = (await db.execute(text(
        "UPDATE connectors SET meta = meta || jsonb_build_object('secret_hash', CAST(:h AS text)), updated_at = now()"
        " WHERE venture_id = :v AND provider = 'exotel_voice' AND status = 'active' RETURNING id"),
        {"v": venture_id, "h": hashlib.sha256(secret.encode()).hexdigest()})).scalar()
    if cid is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "connect an Exotel number first")
    return ExotelLinkOut(voicebot_url=_exotel_link(cid, secret), voice=await _voice_out(db, svc, venture_id))


@router.delete("/ventures/{venture_id}/voice/exotel", response_model=VoiceOut)
async def disconnect_exotel(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> VoiceOut:
    await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin disconnects the phone number")
    await db.execute(text("UPDATE connectors SET status = 'revoked', updated_at = now()"
                          " WHERE venture_id = :v AND provider = 'exotel_voice'"), {"v": venture_id})
    await db.execute(text("DELETE FROM connector_tokens WHERE connector_id IN (SELECT id FROM connectors"
                          " WHERE venture_id = :v AND provider = 'exotel_voice')"), {"v": venture_id})
    return await _voice_out(db, svc, venture_id)


# ---------------------------------------------------------------------------------------- calls (app) --
class CallTurnOut(BaseModel):
    who: Literal["agent", "caller"]
    text: str


class CallOut(BaseModel):
    id: uuid.UUID
    direction: Literal["inbound", "outbound"]
    test: bool
    status: str
    outcome: str | None
    phone: str | None = Field(description="masked")
    caller_name: str | None
    purpose: str | None
    summary: str | None
    turns: int
    duration_s: int | None
    lead_id: uuid.UUID | None
    started_at: datetime
    ended_at: datetime | None


class CallDetail(CallOut):
    transcript: list[CallTurnOut]


class TestIn(BaseModel):
    call_id: uuid.UUID | None = None
    said: str = Field(default="", max_length=600)
    digits: str | None = Field(default=None, pattern=r"^[0-9*#]$")
    hang_up: bool = False


class TestOut(BaseModel):
    call_id: uuid.UUID
    say: str
    ended: bool
    outcome: str | None
    transfer_to: str | None = None
    language: Literal["hi-IN", "en-IN"]


class PlaceIn(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    name: str | None = Field(default=None, max_length=80)
    purpose: str = Field(min_length=3, max_length=300)


class PlaceOut(BaseModel):
    run_id: uuid.UUID
    status: str
    pending_approval_id: uuid.UUID | None
    answer: str | None


async def _call_out(crypto: EnvelopeCrypto, venture_id: uuid.UUID, r, *, detail: bool = False) -> CallOut | CallDetail:
    state = json.loads(await crypto.decrypt_str(venture_id, vc.STATE, r.state_enc))
    phone = await crypto.decrypt_str(venture_id, vc.PHONE, r.phone_enc) if r.phone_enc else None
    summary = await crypto.decrypt_str(venture_id, vc.SUMMARY, r.summary_enc) if r.summary_enc else None
    base = dict(id=r.id, direction=r.direction, test=r.test, status=r.status, outcome=r.outcome,
                phone=tw.mask(phone) if phone else None, caller_name=state.get("caller_name") or state.get("callee"),
                purpose=state.get("purpose"), summary=summary, turns=r.turns, duration_s=r.duration_s, lead_id=r.lead_id,
                started_at=r.started_at, ended_at=r.ended_at)
    if not detail:
        return CallOut(**base)
    return CallDetail(**base, transcript=[CallTurnOut(who=t["who"], text=t["text"]) for t in state.get("turns", [])])


async def _principal(db, venture_id: uuid.UUID) -> vc.Principal:
    org = await venture_org(db, venture_id)
    run_as = (await db.execute(text("SELECT venture_service_account(:v)"), {"v": venture_id})).scalar_one()
    return vc.Principal(org, venture_id, run_as)


@router.post("/ventures/{venture_id}/calls/test", response_model=TestOut)
async def test_call(venture_id: uuid.UUID, body: TestIn, user_id: UserId, db: TenantDB, svc: Svc,
                    background: BackgroundTasks) -> TestOut:
    """A call in the app: you play the caller (type, or speak with the voice button); Kritvia answers
    exactly as it would on the phone. Test calls make no leads or tasks."""
    await venture_org(db, venture_id)
    if not await _can_write(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "test calls need an operator or admin role")
    await limiter.hit(f"call-test:{user_id}", per_minute=30)
    p = await _principal(db, venture_id)
    if body.call_id is None:
        async with tenant_tx(p.run_as, "agent", "voice") as conn:
            call_id, first = await vc.new_call(conn, EnvelopeCrypto(conn, svc.keys), p, direction="inbound", phone=None,
                                               test=True, created_by=user_id)
            s = await vc.settings_for(conn, venture_id)
        return TestOut(call_id=call_id, say=first, ended=False, outcome=None, language=s.language)
    row = (await db.execute(text("SELECT id, test, ended_at FROM calls WHERE id = :id AND venture_id = :v"),
                            {"id": body.call_id, "v": venture_id})).first()
    if row is None or not row.test:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "test call not found")
    if body.hang_up or row.ended_at is not None:
        await vc.finish(svc, p, body.call_id, status="completed")
        s = await vc.settings_for(db, venture_id)
        return TestOut(call_id=body.call_id, say="", ended=True, outcome=None, language=s.language)
    step, s = await vc.turn(svc, p, body.call_id, heard=body.said, digits=body.digits)
    if step.kind == "transfer":       # nobody to put a test call through to: as if they didn't pick up
        nxt, s = await vc.turn(svc, p, body.call_id, heard="", dial_status="no-answer")
        return TestOut(call_id=body.call_id, say=f"{step.say} {nxt.say}", ended=False, outcome=step.outcome,
                       transfer_to=step.number, language=s.language)
    if step.ended:
        background.add_task(vc.finish, svc, p, body.call_id, status="completed")
    return TestOut(call_id=body.call_id, say=step.say, ended=step.ended, outcome=step.outcome, language=s.language)


@router.post("/ventures/{venture_id}/calls", response_model=PlaceOut, status_code=201)
async def place_call(venture_id: uuid.UUID, body: PlaceIn, user_id: UserId, svc: Svc, db: TenantDB) -> PlaceOut:
    await venture_org(db, venture_id)
    phone = tw.normalise_phone(body.phone)
    if phone is None:
        raise HTTPException(422, "that phone number doesn't look right")
    await limiter.hit(f"call-place:{user_id}", per_minute=10)
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="voice_call",
                                 input={"phone": phone, "name": body.name, "purpose": body.purpose.strip()},
                                 title="Phone call", trigger_kind="manual")
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found") from None
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    r = (await db.execute(text(
        "SELECT r.status, r.state_enc, (SELECT a.id FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending'"
        " ORDER BY a.created_at DESC LIMIT 1) AS pending FROM workflow_runs r WHERE r.id = :id"), {"id": run_id})).first()
    from kritvia_api.engine.runner import STATE_PURPOSE
    state = json.loads(await EnvelopeCrypto(db, svc.keys).decrypt(venture_id, STATE_PURPOSE, r.state_enc))
    return PlaceOut(run_id=run_id, status=r.status, pending_approval_id=r.pending, answer=state.get("answer"))


@router.get("/ventures/{venture_id}/calls", response_model=list[CallOut])
async def list_calls(venture_id: uuid.UUID, db: TenantDB, svc: Svc, limit: int = 30) -> list[CallOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT * FROM calls WHERE venture_id = :v ORDER BY started_at DESC LIMIT :l"),
                             {"v": venture_id, "l": min(max(limit, 1), 100)})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return [await _call_out(crypto, venture_id, r) for r in rows]


@router.get("/ventures/{venture_id}/calls/{call_id}", response_model=CallDetail)
async def get_call(venture_id: uuid.UUID, call_id: uuid.UUID, db: TenantDB, svc: Svc) -> CallDetail:
    await venture_org(db, venture_id)
    r = (await db.execute(text("SELECT * FROM calls WHERE id = :id AND venture_id = :v"),
                          {"id": call_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "call not found")
    return await _call_out(EnvelopeCrypto(db, svc.keys), venture_id, r, detail=True)  # type: ignore[return-value]


@router.delete("/ventures/{venture_id}/calls/{call_id}", status_code=204)
async def delete_call(venture_id: uuid.UUID, call_id: uuid.UUID, db: TenantDB) -> Response:
    """Delete a call and what was said in it (a do-not-call request it led to stays)."""
    await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin deletes calls")
    done = (await db.execute(text("DELETE FROM calls WHERE id = :id AND venture_id = :v RETURNING id"),
                             {"id": call_id, "v": venture_id})).first()
    if done is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "call not found")
    return Response(status_code=204)


# ------------------------------------------------------------------------------------- Twilio hooks --
async def _signed(request: Request, connector_id: uuid.UUID, svc) -> tuple[vc.Principal, dict[str, str], str]:
    """The business behind the hook, after Twilio's signature checks out with its own auth token."""
    await limiter.hit(f"hook-ip:{client_ip(request)}", per_minute=600)
    body = await request.body()
    if len(body) > 64 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload too large")
    form = {k: str(v) for k, v in (await request.form()).items()}
    async with tenant_tx(None, "system") as conn:
        pr = (await conn.execute(text("SELECT * FROM private.voice_principal(:c)"), {"c": connector_id})).first()
    token = None
    if pr is not None:
        async with tenant_tx(pr.run_as, "agent", "voice") as conn:
            enc = (await conn.execute(text("SELECT secret_enc FROM connector_tokens WHERE connector_id = :c"),
                                      {"c": connector_id})).scalar()
            if enc is not None:
                token = await EnvelopeCrypto(conn, svc.keys).decrypt_str(pr.venture_id, SECRET, enc)
    url = _url(request.url.path) + (f"?{request.url.query}" if request.url.query else "")
    if pr is None or token is None or not tw.valid(token, url, form, request.headers.get("X-Twilio-Signature")):
        await security_event("webhook.bad_signature", "warning", request=request, provider="twilio_voice")
        raise HTTPException(status.HTTP_403_FORBIDDEN, "bad signature")
    return vc.Principal(pr.org_id, pr.venture_id, pr.run_as, pr.connector_id), form, token


def _xml(body: str) -> Response:
    return Response(content=body, media_type=XML)


def _render(step: vc.Step, s: vc.Settings, turn_url: str) -> Response:
    v = tw.Voice(language=s.language, voice=s.voice)
    if step.kind == "transfer" and step.number:
        return _xml(tw.transfer(step.say, step.number, v, after=f"{turn_url}&dial=1"))
    if step.kind == "goodbye":
        return _xml(tw.goodbye(step.say, v))
    return _xml(tw.listen(step.say, turn_url, v))


async def _ready(p: vc.Principal) -> tuple[bool, vc.Settings]:
    async with tenant_tx(p.run_as, "agent", "voice") as conn:
        s = await vc.settings_for(conn, p.venture_id)
        plan = await plan_for_venture(conn, p.venture_id)
    return bool(s.enabled and plan.allows_integration("voice")), s


def _wss(path: str) -> str:
    return _url(path).replace("https://", "wss://", 1).replace("http://", "ws://", 1)


async def _stream_twiml(conn, svc, p: vc.Principal, s: vc.Settings, connector_id: uuid.UUID,
                        call_id: uuid.UUID) -> str | None:
    """In 'stream' mode Kritvia speaks and listens itself (the business's voice settings); otherwise None."""
    from kritvia_api.services import voice_speech as vs
    if s.twilio_mode != "stream":
        return None
    stack = await vs.stack_for(conn, EnvelopeCrypto(conn, svc.keys), p.venture_id)
    if vs.tts_ready(stack):
        return None          # no voice set up: Twilio's own speech instead of silence
    return tw.stream(_wss(f"/hooks/voice/stream/twilio/{connector_id}"),
                     {"call": str(call_id), "sig": vc.stream_sig(connector_id, call_id)})


@router.post("/hooks/voice/twilio/{connector_id}/incoming", response_class=Response)
async def twilio_incoming(connector_id: uuid.UUID, request: Request, svc: Svc) -> Response:
    p, form, _ = await _signed(request, connector_id, svc)
    ok, s = await _ready(p)
    v = tw.Voice(language=s.language, voice=s.voice)
    if not ok:
        return _xml(tw.goodbye(vc.line(s, "off"), v))
    sid = form.get("CallSid", "")[:80]
    caller = tw.normalise_phone(form.get("From", "")) or None
    async with tenant_tx(p.run_as, "agent", "voice") as conn:
        crypto = EnvelopeCrypto(conn, svc.keys)
        existing = (await conn.execute(text("SELECT id FROM calls WHERE connector_id = :c AND provider_call_id = :s"),
                                       {"c": connector_id, "s": sid})).scalar()
        if existing:
            call_id = existing
            first = (await vc.opening_line(svc, p, call_id))[0]
        else:
            call_id, first = await vc.new_call(conn, crypto, p, direction="inbound", phone=caller, test=False,
                                               provider_call_id=sid)
        streamed = await _stream_twiml(conn, svc, p, s, connector_id, call_id)
    if streamed:
        return _xml(streamed)
    return _xml(tw.listen(first, _url(f"/hooks/voice/twilio/{connector_id}/turn?call={call_id}"), v))


@router.post("/hooks/voice/twilio/{connector_id}/outgoing", response_class=Response)
async def twilio_outgoing(connector_id: uuid.UUID, call: uuid.UUID, request: Request, svc: Svc) -> Response:
    """The customer picked up a call Kritvia placed: the approved opening, then the conversation."""
    p, form, _ = await _signed(request, connector_id, svc)
    first, s = await vc.opening_line(svc, p, call)
    async with tenant_tx(p.run_as, "agent", "voice") as conn:
        await conn.execute(text("UPDATE calls SET provider_call_id = coalesce(provider_call_id, :s) WHERE id = :id"
                                " AND venture_id = :v"), {"s": form.get("CallSid", "")[:80], "id": call, "v": p.venture_id})
        streamed = await _stream_twiml(conn, svc, p, s, connector_id, call)
    if streamed:
        return _xml(streamed)
    v = tw.Voice(language=s.language, voice=s.voice)
    return _xml(tw.listen(first, _url(f"/hooks/voice/twilio/{connector_id}/turn?call={call}"), v))


@router.post("/hooks/voice/twilio/{connector_id}/turn", response_class=Response)
async def twilio_turn(connector_id: uuid.UUID, call: uuid.UUID, request: Request, svc: Svc,
                      background: BackgroundTasks, dial: int = 0) -> Response:
    p, form, _ = await _signed(request, connector_id, svc)
    async with tenant_tx(p.run_as, "agent", "voice") as conn:
        ok = (await conn.execute(text("SELECT 1 FROM calls WHERE id = :id AND venture_id = :v AND connector_id = :c"
                                      " AND provider_call_id = :s"),
                                 {"id": call, "v": p.venture_id, "c": connector_id, "s": form.get("CallSid", "")})).first()
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "call not found")
    step, s = await vc.turn(svc, p, call, heard=form.get("SpeechResult", ""), digits=form.get("Digits") or None,
                            dial_status=(form.get("DialCallStatus") or "failed") if dial else None)
    return _render(step, s, _url(f"/hooks/voice/twilio/{connector_id}/turn?call={call}"))


TWILIO_STATUS = {"completed": "completed", "busy": "busy", "no-answer": "no_answer", "failed": "failed",
                 "canceled": "canceled"}


@router.post("/hooks/voice/twilio/{connector_id}/status", response_class=Response)
async def twilio_status(connector_id: uuid.UUID, request: Request, svc: Svc, background: BackgroundTasks) -> Response:
    p, form, _ = await _signed(request, connector_id, svc)
    st = TWILIO_STATUS.get(form.get("CallStatus", ""))
    if st is None:
        return Response(status_code=204)
    async with tenant_tx(p.run_as, "agent", "voice") as conn:
        call_id = (await conn.execute(text("SELECT id FROM calls WHERE connector_id = :c AND provider_call_id = :s"),
                                      {"c": connector_id, "s": form.get("CallSid", "")})).scalar()
    if call_id is None:
        return Response(status_code=204)
    try:
        duration = int(form.get("CallDuration") or 0)
    except ValueError:
        duration = None
    background.add_task(vc.finish, svc, p, call_id, status=st, duration_s=duration)
    return Response(status_code=204)


# ------------------------------------------------------------------------------------- media streams --
async def _pump(ws: WebSocket, session) -> None:
    """Messages from the phone company into the call until either side ends it."""
    import asyncio
    closed = asyncio.ensure_future(session.closed.wait())
    try:
        while True:
            recv = asyncio.ensure_future(ws.receive_text())
            done, _ = await asyncio.wait({recv, closed}, return_when=asyncio.FIRST_COMPLETED)
            if closed in done:
                recv.cancel()
                break
            try:
                msg = json.loads(recv.result())
            except ValueError:
                continue
            if not isinstance(msg, dict) or not await session.handle(msg):
                break
    except Exception:  # noqa: BLE001 - the caller hung up (socket closed) or the stream broke
        pass
    finally:
        closed.cancel()
        await session.finish()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


@router.websocket("/hooks/voice/stream/exotel/{connector_id}")
async def exotel_stream(ws: WebSocket, connector_id: uuid.UUID) -> None:
    """Exotel's Voicebot applet: the caller's audio in, Kritvia's voice out. The link carries the business's
    secret (inbound, set in its Exotel flow) or a signature for one call Kritvia placed (outbound)."""
    import hashlib
    import hmac
    from kritvia_api.engine.context import get_services
    from kritvia_api.services import voice_stream as vstream
    svc = get_services()
    q = ws.query_params
    async with tenant_tx(None, "system") as conn:
        pr = (await conn.execute(text("SELECT * FROM private.exotel_principal(:c)"), {"c": connector_id})).first()
    call_id: uuid.UUID | None = None
    ok = False
    if pr is not None and q.get("k") and pr.secret_hash:
        ok = hmac.compare_digest(hashlib.sha256(q["k"].encode()).hexdigest(), pr.secret_hash)
    elif pr is not None and q.get("call") and q.get("sig"):
        try:
            call_id = uuid.UUID(q["call"])
            ok = hmac.compare_digest(vc.stream_sig(connector_id, call_id), q["sig"])
        except ValueError:
            ok = False
    if not ok:
        await security_event("webhook.bad_signature", "warning", provider="exotel_voice")
        await ws.close(code=1008)
        return
    p = vc.Principal(pr.org_id, pr.venture_id, pr.run_as, pr.connector_id)
    ready, _ = await _ready(p)
    if not ready:
        await ws.close(code=1000)        # the flow goes on to its next applet (Hangup)
        return
    await ws.accept()
    session = vstream.StreamSession(svc, p, vstream.ExotelAdapter(), ws.send_json, call_id=call_id)
    await _pump(ws, session)


@router.websocket("/hooks/voice/stream/twilio/{connector_id}")
async def twilio_stream(ws: WebSocket, connector_id: uuid.UUID) -> None:
    """Twilio Media Streams (stream mode): the call's signature comes in the start message's parameters."""
    import hmac
    from kritvia_api.engine.context import get_services
    from kritvia_api.services import voice_stream as vstream
    svc = get_services()
    async with tenant_tx(None, "system") as conn:
        pr = (await conn.execute(text("SELECT * FROM private.voice_principal(:c)"), {"c": connector_id})).first()
    if pr is None:
        await ws.close(code=1008)
        return
    await ws.accept()
    start = None
    for _ in range(3):                     # "connected", then "start"
        try:
            msg = json.loads(await ws.receive_text())
        except Exception:  # noqa: BLE001
            break
        if isinstance(msg, dict) and msg.get("event") == "start":
            start = msg
            break
    params = ((start or {}).get("start") or {}).get("customParameters") or {}
    try:
        call_id = uuid.UUID(str(params.get("call")))
        good = hmac.compare_digest(vc.stream_sig(connector_id, call_id), str(params.get("sig") or ""))
    except ValueError:
        good = False
    if start is None or not good:
        await security_event("webhook.bad_signature", "warning", provider="twilio_voice")
        await ws.close(code=1008)
        return
    p = vc.Principal(pr.org_id, pr.venture_id, pr.run_as, pr.connector_id)

    async def put_through(call_sid: str, number: str) -> bool:
        async with tenant_tx(p.run_as, "agent", "voice") as conn:
            row = (await conn.execute(text(
                "SELECT c.meta ->> 'account_sid' AS sid, t.secret_enc FROM connectors c"
                " JOIN connector_tokens t ON t.connector_id = c.id WHERE c.id = :c"), {"c": connector_id})).first()
            token = await EnvelopeCrypto(conn, svc.keys).decrypt_str(p.venture_id, SECRET, row.secret_enc) if row else None
        if not token or not call_sid:
            return False
        try:
            await svc.twilio.update_call(row.sid, token, call_sid,
                                         f'<Response><Dial timeout="25"><Number>{number}</Number></Dial></Response>')
            return True
        except tw.TwilioError:
            return False

    session = vstream.StreamSession(svc, p, vstream.TwilioAdapter(), ws.send_json, call_id=call_id,
                                    transfer=put_through)
    if await session.handle(start):
        await _pump(ws, session)
    else:
        await session.finish()
        await ws.close()


EXOTEL_STATUS = {"completed": "completed", "busy": "busy", "no-answer": "no_answer", "failed": "failed",
                 "canceled": "canceled", "cancelled": "canceled"}


@router.post("/hooks/voice/exotel/{connector_id}/status", response_class=Response)
async def exotel_status(connector_id: uuid.UUID, call: uuid.UUID, sig: str, request: Request,
                        background: BackgroundTasks) -> Response:
    """Exotel's status callback for a call Kritvia placed (signed link): busy / no answer / failed / done."""
    import hmac
    from kritvia_api.engine.context import get_services
    await limiter.hit(f"hook-ip:{client_ip(request)}", per_minute=600)
    if not hmac.compare_digest(vc.stream_sig(connector_id, call), sig):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "bad signature")
    async with tenant_tx(None, "system") as conn:
        pr = (await conn.execute(text("SELECT * FROM private.exotel_principal(:c)"), {"c": connector_id})).first()
    if pr is None:
        return Response(status_code=204)
    try:
        if "json" in (request.headers.get("content-type") or ""):
            body = await request.json()
        else:
            body = dict(await request.form())
    except Exception:  # noqa: BLE001
        body = {}
    lowered = {str(k).lower(): str(v) for k, v in (body or {}).items()} if isinstance(body, dict) else {}
    st = EXOTEL_STATUS.get(lowered.get("status", "").lower())
    if st is None:
        return Response(status_code=204)
    try:
        duration = int(float(lowered.get("duration") or lowered.get("conversationduration") or 0))
    except ValueError:
        duration = None
    p = vc.Principal(pr.org_id, pr.venture_id, pr.run_as, pr.connector_id)
    background.add_task(vc.finish, get_services(), p, call, status=st, duration_s=duration)
    return Response(status_code=204)
