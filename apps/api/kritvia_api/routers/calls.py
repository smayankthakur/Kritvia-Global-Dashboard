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
Twilio (signed with the business's auth token):
  POST   /hooks/voice/twilio/{connector}/incoming | /turn | /outgoing | /status
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status
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
    s = await vc.settings_for(db, venture_id)
    con = (await db.execute(text("SELECT id, meta ->> 'account_sid' AS account_sid, account_email, status FROM connectors"
                                 " WHERE venture_id = :v AND provider = 'twilio_voice'"), {"v": venture_id})).first()
    kind = (await db.execute(text("SELECT coalesce(kind, 'general') FROM venture_settings WHERE venture_id = :v"),
                             {"v": venture_id})).scalar() or "general"
    p = await plan_for_venture(db, venture_id)
    includes = p.allows_integration("voice") and p.allows_agent("voice_call", kind)
    name, _ = await vc.business_line(db, venture_id)
    dnd = (await db.execute(text("SELECT count(*) FROM voice_dnd WHERE venture_id = :v"), {"v": venture_id})).scalar()
    number = None
    if con is not None:
        number = VoiceNumber(number=con.account_email or "", account=(con.account_sid or "")[-4:], status=con.status,
                             **hook_urls(con.id))
    return VoiceOut(enabled=s.enabled, language=s.language, voice=s.voice, greeting=s.greeting,
                    greeting_preview=vc.greeting(name, s), transfer_number=s.transfer_number, open_days=list(s.open_days),
                    open_from=s.open_from, open_to=s.open_to, max_minutes=s.max_minutes,
                    outbound_enabled=s.outbound_enabled, dlt_entity_id=s.dlt_entity_id, caller_id_kind=s.caller_id_kind,
                    registered_at=s.registered_at, number=number, plan_includes=includes,
                    can_admin=await _can_admin(db, venture_id),
                    answering=bool(s.enabled and includes and con is not None and con.status == "active"),
                    dnd_count=int(dnd or 0))


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
    return _xml(tw.listen(first, _url(f"/hooks/voice/twilio/{connector_id}/turn?call={call_id}"), v))


@router.post("/hooks/voice/twilio/{connector_id}/outgoing", response_class=Response)
async def twilio_outgoing(connector_id: uuid.UUID, call: uuid.UUID, request: Request, svc: Svc) -> Response:
    """The customer picked up a call Kritvia placed: the approved opening, then the conversation."""
    p, form, _ = await _signed(request, connector_id, svc)
    first, s = await vc.opening_line(svc, p, call)
    async with tenant_tx(p.run_as, "agent", "voice") as conn:
        await conn.execute(text("UPDATE calls SET provider_call_id = coalesce(provider_call_id, :s) WHERE id = :id"
                                " AND venture_id = :v"), {"s": form.get("CallSid", "")[:80], "id": call, "v": p.venture_id})
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
