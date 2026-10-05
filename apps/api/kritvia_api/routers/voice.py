"""Voice: dictation, vocabulary, auto-learn, voice settings and dictation insights.

Dictation flow (web voice button, floating widget, desktop companion):
  audio -> speech model (user's engine; spelling hints from vocabulary + knowledge graph,
  filtered by each deployment's data policy) -> cleanup (caption artefacts, stuck loops,
  fillers, profanity) -> vocabulary replacement -> text, plus one metadata row for Insights.
In 'note' mode the text is also saved to the venture's knowledge base as a note.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import date, datetime, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field, StringConstraints, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services import memory, speech
from kritvia_api.services.model_router import (ENGINES, SARVAM_LANGUAGES, CallContext, PolicyViolation,
                                               RouterError, transcribe)

router = APIRouter(tags=["voice"])

Engine = Literal["auto", "sarvam", "whisper", "local"]
Mode = Literal["type", "note", "ask"]
Surface = Literal["web", "desktop"]
MAX_DICTATION_BYTES = 10 * 1024 * 1024
MIN_AUDIO_MS = 700          # shorter = an accidental tap, not a dictation (Scribe's threshold)
TYPING_WPM = 40             # what dictation is compared against for "time saved"

# ------------------------------------------------------------------ languages --
LANGUAGES: list[tuple[str, str]] = [
    ("auto", "Auto-detect"), ("en", "English"), ("hi", "Hindi"), ("bn", "Bengali"), ("ta", "Tamil"),
    ("te", "Telugu"), ("mr", "Marathi"), ("gu", "Gujarati"), ("kn", "Kannada"), ("ml", "Malayalam"),
    ("pa", "Punjabi"), ("or", "Odia"), ("as", "Assamese"), ("ur", "Urdu"), ("ne", "Nepali"),
    ("sa", "Sanskrit"), ("sd", "Sindhi"), ("ks", "Kashmiri"), ("doi", "Dogri"), ("mni", "Manipuri"),
    ("brx", "Bodo"), ("mai", "Maithili"), ("sat", "Santali"), ("kok", "Konkani"),
    ("es", "Spanish"), ("fr", "French"), ("de", "German"), ("ar", "Arabic"), ("zh", "Chinese"),
    ("ja", "Japanese"), ("pt", "Portuguese"), ("ru", "Russian"),
]
WHISPER_UNSUPPORTED = {"as", "ks", "doi", "mni", "brx", "mai", "sat", "kok", "or"}
LANGUAGE_CODES = {c for c, _ in LANGUAGES}


class LanguageOut(BaseModel):
    code: str
    name: str
    sarvam: bool
    whisper: bool


class EngineOut(BaseModel):
    engine: str
    available: bool
    detail: str


class VoiceOptionsOut(BaseModel):
    languages: list[LanguageOut]
    engines: list[EngineOut]


@router.get("/voice/options", response_model=VoiceOptionsOut)
async def voice_options(_: UserId, svc: Svc) -> VoiceOptionsOut:
    """Languages and which speech engines this deployment can actually use."""
    cfg = svc.router.config
    chain = cfg.tiers.get("dictation") or cfg.tiers.get("speech") or []
    families = {cfg.engine(d) for d in chain}
    sarvam_ok = "sarvam" in families and bool(svc.router.sarvam_api_key)
    engines = [
        EngineOut(engine="auto", available=True, detail="Best available: Sarvam for Indian languages, then Whisper"),
        EngineOut(engine="sarvam", available=sarvam_ok,
                  detail="Sarvam — Hindi, Hinglish and 22 Indian languages"
                  if sarvam_ok else "Sarvam is not configured (SARVAM_API_KEY)"),
        EngineOut(engine="whisper", available="whisper" in families, detail="Whisper (hosted)"),
        EngineOut(engine="local", available="local" in families,
                  detail="On our own server only — audio never leaves Kritvia's infrastructure"),
    ]
    langs = [LanguageOut(code=c, name=n, sarvam=c == "auto" or c in SARVAM_LANGUAGES,
                         whisper=c not in WHISPER_UNSUPPORTED) for c, n in LANGUAGES]
    return VoiceOptionsOut(languages=langs, engines=engines)


# ------------------------------------------------------------------ settings --
class VoiceSettings(BaseModel):
    engine: Engine = "auto"
    language: str = "auto"
    remove_fillers: bool = True
    profanity_filter: bool = False
    auto_learn: bool = False   # off until the person switches it on (Privacy Policy 2)
    hotkey: str = Field(default="ControlRight", pattern=r"^[A-Za-z0-9]{2,24}$")
    widget_enabled: bool = True

    @field_validator("language")
    @classmethod
    def _lang(cls, v: str) -> str:
        if v not in LANGUAGE_CODES:
            raise ValueError("unsupported language")
        return v


SETTINGS_COLS = "engine, language, remove_fillers, profanity_filter, auto_learn, hotkey, widget_enabled"


async def _settings(db, user_id: uuid.UUID) -> VoiceSettings:
    row = (await db.execute(text(f"SELECT {SETTINGS_COLS} FROM voice_settings WHERE user_id = :u"),
                            {"u": user_id})).first()
    return VoiceSettings(**row._mapping) if row else VoiceSettings()


@router.get("/me/voice-settings", response_model=VoiceSettings)
async def get_voice_settings(user_id: UserId, db: TenantDB) -> VoiceSettings:
    return await _settings(db, user_id)


@router.put("/me/voice-settings", response_model=VoiceSettings)
async def put_voice_settings(body: VoiceSettings, user_id: UserId, db: TenantDB) -> VoiceSettings:
    try:
        async with db.begin_nested():
            await db.execute(text(
                f"INSERT INTO voice_settings (user_id, {SETTINGS_COLS}) VALUES (:u, :engine, :language,"
                " :remove_fillers, :profanity_filter, :auto_learn, :hotkey, :widget_enabled)"
                " ON CONFLICT (user_id) DO UPDATE SET engine = EXCLUDED.engine, language = EXCLUDED.language,"
                " remove_fillers = EXCLUDED.remove_fillers, profanity_filter = EXCLUDED.profanity_filter,"
                " auto_learn = EXCLUDED.auto_learn, hotkey = EXCLUDED.hotkey,"
                " widget_enabled = EXCLUDED.widget_enabled, updated_at = now()"),
                {"u": user_id, **body.model_dump()})
    except DBAPIError as exc:
        raise_for_db(exc, "user not found")
    return await _settings(db, user_id)


# ----------------------------------------------------------------- dictation --
class DictationOut(BaseModel):
    text: str
    language: str | None
    engine: str
    deployment: str
    words: int
    vocabulary_applied: int
    fallback: bool = Field(description="True when the chosen engine was unavailable and another one answered")
    status: Literal["ok", "too_short", "no_speech"] = "ok"
    note_document_id: uuid.UUID | None = None


async def _readable(conn, venture_id: uuid.UUID) -> tuple[uuid.UUID, bool]:
    org = await venture_org(conn, venture_id)
    can_write = (await conn.execute(text("SELECT :v = ANY (private.writable_ventures())"),
                                    {"v": venture_id})).scalar()
    return org, bool(can_write)


async def dictate(*, venture_id: uuid.UUID, user_id: uuid.UUID, svc, data: bytes, filename: str,
                  sensitive: bool, language: str | None, engine: str | None, mode: str, surface: str,
                  duration_ms: int | None) -> DictationOut:
    async with tenant_tx(user_id) as conn:
        org, can_write = await _readable(conn, venture_id)
        if mode == "note" and not can_write:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "saving notes needs write access to this venture")
        prefs = await _settings(conn, user_id)
        vocab = await speech.load_vocabulary(conn, venture_id)
        hints = await speech.load_hints(conn, venture_id, vocab)

    eng = engine or prefs.engine
    lang = language or prefs.language
    if duration_ms is not None and duration_ms < MIN_AUDIO_MS:
        return DictationOut(text="", language=None, engine=eng, deployment="", words=0, vocabulary_applied=0,
                            fallback=False, status="too_short")
    cfg = svc.router.config
    try:
        tr = await transcribe(
            svc.router, CallContext(org_id=org, venture_id=venture_id, user_id=user_id, workflow="voice"),
            data, filename, sensitive=sensitive, language=lang, tier="dictation" if "dictation" in cfg.tiers
            else "speech", engine=eng,
            hints_for=lambda d: hints.for_policy(cfg.is_private(d)))
    except PolicyViolation as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    except RouterError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"speech model unavailable: {exc}") from None

    # CPU work (a large vocabulary compiles once, then is cached) stays off the event loop
    cleaned, used = await asyncio.to_thread(speech.clean_transcript, tr.text, speech.CleanupOptions(
        remove_fillers=prefs.remove_fillers, profanity_filter=prefs.profanity_filter, vocabulary=vocab))
    words = speech.word_count(cleaned)
    audio_ms = duration_ms if duration_ms is not None else int(
        max((s["end"] for s in tr.segments), default=0) * 1000)
    note_id = None
    async with tenant_tx(user_id) as conn:
        if used:
            await conn.execute(text("SELECT vocabulary_touch(CAST(:ids AS uuid[]))"), {"ids": used})
        if cleaned:
            await conn.execute(text(
                "INSERT INTO dictation_events (org_id, venture_id, user_id, surface, mode, engine, language,"
                " audio_ms, words) VALUES (:o, :v, :u, :s, :m, :e, :l, :a, :w)"),
                {"o": org, "v": venture_id, "u": user_id, "s": surface, "m": mode, "e": tr.engine,
                 "l": tr.language or (None if lang == "auto" else lang), "a": max(0, min(audio_ms, 3_600_000)),
                 "w": words})
    if mode == "note" and cleaned:
        actor = memory.UserActor(user_id, org, venture_id, svc.router, svc.keys)
        stamp = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%d %b %Y, %H:%M")
        try:
            res = await memory.ingest(actor, title=f"Voice note — {stamp}", kind="note", text_override=cleaned,
                                      created_by=user_id, sensitive=sensitive, extraction_focus="general")
        except DBAPIError as exc:
            raise_for_db(exc, "venture not found")
        note_id = res.document_id
    return DictationOut(
        text=cleaned, language=tr.language, engine=tr.engine, deployment=tr.deployment, words=words,
        vocabulary_applied=len(used), fallback=eng not in ("auto", tr.engine),
        status="ok" if cleaned else "no_speech", note_document_id=note_id)


async def read_dictation(file: UploadFile) -> bytes:
    data = await file.read(MAX_DICTATION_BYTES + 1)
    if len(data) > MAX_DICTATION_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "voice notes are limited to 10 MB")
    if not data:
        raise HTTPException(422, "empty file")
    return data


@router.post("/ventures/{venture_id}/voice/dictate", response_model=DictationOut)
async def dictate_endpoint(
    venture_id: uuid.UUID, user_id: UserId, svc: Svc, file: UploadFile = File(...),
    sensitive: bool = Form(default=False), language: str | None = Form(default=None),
    engine: Engine | None = Form(default=None), mode: Mode = Form(default="type"),
    surface: Surface = Form(default="web"), duration_ms: int | None = Form(default=None, ge=0, le=3_600_000),
) -> DictationOut:
    """Dictation: short recording -> cleaned text in the user's vocabulary.
    mode 'note' also saves it to the knowledge base; 'ask' only returns the text for the caller to ask."""
    if language is not None and language not in LANGUAGE_CODES:
        raise HTTPException(422, "unsupported language")
    data = await read_dictation(file)
    return await dictate(venture_id=venture_id, user_id=user_id, svc=svc, data=data,
                         filename=file.filename or "voice.webm", sensitive=sensitive, language=language,
                         engine=engine, mode=mode, surface=surface, duration_ms=duration_ms)


# ---------------------------------------------------------------- vocabulary --
Scope = Literal["personal", "shared"]
Form64 = Annotated[str, StringConstraints(max_length=64)]
MAX_PERSONAL_TERMS = 1000   # per person per venture
MAX_SHARED_TERMS = 2000     # per venture


class TermIn(BaseModel):
    term: str = Field(min_length=1, max_length=64)
    sounds_like: list[Form64] = Field(default_factory=list, max_length=20)
    case_sensitive: bool = False
    scope: Scope = "personal"

    @field_validator("term")
    @classmethod
    def _term(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("term is empty")
        return v

    @field_validator("sounds_like")
    @classmethod
    def _sl(cls, v: list[str]) -> list[str]:
        return normalise_forms(v)


def normalise_forms(forms: list[str]) -> list[str]:
    out: list[str] = []
    for s in forms:
        s = " ".join(s.split())[:64]
        if s and s.lower() not in {x.lower() for x in out}:
            out.append(s)
    return out


class TermPatch(BaseModel):
    term: str | None = Field(default=None, min_length=1, max_length=64)
    sounds_like: list[Form64] | None = Field(default=None, max_length=20)
    case_sensitive: bool | None = None


class TermOut(BaseModel):
    id: uuid.UUID
    term: str
    sounds_like: list[str]
    case_sensitive: bool
    scope: Scope
    source: str
    uses: int
    created_at: datetime
    updated_at: datetime


TERM_COLS = ("id, term, sounds_like, case_sensitive, CASE WHEN user_id IS NULL THEN 'shared' ELSE 'personal' END"
             " AS scope, source, coalesce((SELECT uses FROM vocabulary_usage u WHERE u.term_id = vocabulary_terms.id), 0)"
             " AS uses, created_at, updated_at")


@router.get("/ventures/{venture_id}/vocabulary", response_model=list[TermOut])
async def list_terms(venture_id: uuid.UUID, db: TenantDB, q: str | None = Query(default=None, max_length=64),
                     scope: Scope | None = None) -> list[TermOut]:
    await venture_org(db, venture_id)
    where = ["venture_id = :v"]
    params: dict = {"v": venture_id}
    if q:
        where.append("(term ILIKE :q OR array_to_string(sounds_like, ' ') ILIKE :q)")
        params["q"] = f"%{q.replace('%', '').replace('_', '')}%"
    if scope:
        where.append("user_id IS NULL" if scope == "shared" else "user_id IS NOT NULL")
    rows = (await db.execute(text(f"SELECT {TERM_COLS} FROM vocabulary_terms WHERE {' AND '.join(where)}"
                                  " ORDER BY lower(term) LIMIT 1000"), params)).all()
    return [TermOut(**r._mapping) for r in rows]


async def _upsert_term(db, venture_id: uuid.UUID, user_id: uuid.UUID, body: TermIn, source: str) -> TermOut:
    """Create the term, or merge sounds-like forms into an existing term with the same spelling."""
    owner = user_id if body.scope == "personal" else None
    if owner is None:
        org, can_write = await _readable(db, venture_id)
        if not can_write:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "shared terms need write access to this venture")
    n = (await db.execute(text(
        "SELECT count(*) FROM vocabulary_terms WHERE venture_id = :v AND "
        + ("user_id IS NULL" if owner is None else "user_id = :u")), {"v": venture_id, "u": owner})).scalar() or 0
    cap = MAX_SHARED_TERMS if owner is None else MAX_PERSONAL_TERMS
    if n >= cap:
        exists = (await db.execute(text(
            "SELECT 1 FROM vocabulary_terms WHERE venture_id = :v AND lower(btrim(term)) = lower(btrim(:t)) AND "
            + ("user_id IS NULL" if owner is None else "user_id = :u")),
            {"v": venture_id, "u": owner, "t": body.term})).first()
        if not exists:
            raise HTTPException(status.HTTP_409_CONFLICT, f"vocabulary is full ({cap} terms) — remove unused ones first")
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "INSERT INTO vocabulary_terms (org_id, venture_id, user_id, term, sounds_like, case_sensitive,"
                " source, created_by) SELECT org_id, id, :owner, :t, :sl, :cs, :src, :u FROM ventures WHERE id = :v"
                " ON CONFLICT (venture_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),"
                " lower(btrim(term))) DO UPDATE SET"
                " sounds_like = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM"
                "   unnest(vocabulary_terms.sounds_like || EXCLUDED.sounds_like) x)::text[],"
                " updated_at = now()"  # spelling and case rule of an existing term change only via PATCH
                f" RETURNING {TERM_COLS}"),
                {"owner": owner, "t": body.term, "sl": body.sounds_like, "cs": body.case_sensitive,
                 "src": source, "u": user_id, "v": venture_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    return TermOut(**row._mapping)


@router.post("/ventures/{venture_id}/vocabulary", response_model=TermOut, status_code=201)
async def add_term(venture_id: uuid.UUID, body: TermIn, user_id: UserId, db: TenantDB) -> TermOut:
    """Personal terms: anyone who can see the venture. Shared terms: members who can write."""
    return await _upsert_term(db, venture_id, user_id, body, "manual")


class VocabularyImportIn(BaseModel):
    terms: list[TermIn] = Field(min_length=1, max_length=500)


class VocabularyImportOut(BaseModel):
    imported: int


@router.post("/ventures/{venture_id}/vocabulary/import", response_model=VocabularyImportOut)
async def import_terms(venture_id: uuid.UUID, body: VocabularyImportIn, user_id: UserId, db: TenantDB) -> VocabularyImportOut:
    for t in body.terms:
        await _upsert_term(db, venture_id, user_id, t, "import")
    return VocabularyImportOut(imported=len(body.terms))


@router.patch("/ventures/{venture_id}/vocabulary/{term_id}", response_model=TermOut)
async def patch_term(venture_id: uuid.UUID, term_id: uuid.UUID, body: TermPatch, db: TenantDB) -> TermOut:
    sets, params = [], {"v": venture_id, "id": term_id}
    if body.term is not None:
        sets.append("term = :t")
        params["t"] = " ".join(body.term.split())
    if body.sounds_like is not None:
        sets.append("sounds_like = :sl")
        params["sl"] = normalise_forms(body.sounds_like)
    if body.case_sensitive is not None:
        sets.append("case_sensitive = :cs")
        params["cs"] = body.case_sensitive
    if not sets:
        raise HTTPException(422, "nothing to change")
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                f"UPDATE vocabulary_terms SET {', '.join(sets)}, updated_at = now()"
                f" WHERE id = :id AND venture_id = :v RETURNING {TERM_COLS}"), params)).first()
    except DBAPIError as exc:
        raise_for_db(exc, "term not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "term not found")
    return TermOut(**row._mapping)


@router.delete("/ventures/{venture_id}/vocabulary/{term_id}", status_code=204)
async def delete_term(venture_id: uuid.UUID, term_id: uuid.UUID, db: TenantDB) -> None:
    try:
        async with db.begin_nested():
            n = (await db.execute(text("DELETE FROM vocabulary_terms WHERE id = :id AND venture_id = :v"),
                                  {"id": term_id, "v": venture_id})).rowcount
    except DBAPIError as exc:
        raise_for_db(exc, "term not found")
    if not n:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "term not found")


class LearnIn(BaseModel):
    """Either the pair directly, or the text as inserted and as the user left it."""
    heard: str | None = Field(default=None, max_length=200)
    correct: str | None = Field(default=None, max_length=200)
    original: str | None = Field(default=None, max_length=5000)
    edited: str | None = Field(default=None, max_length=5000)
    scope: Scope = "personal"
    save: bool = True


class LearnOut(BaseModel):
    learned: bool
    heard: str | None = None
    correct: str | None = None
    term: TermOut | None = None


@router.post("/ventures/{venture_id}/vocabulary/learn", response_model=LearnOut)
async def learn(venture_id: uuid.UUID, body: LearnIn, user_id: UserId, db: TenantDB) -> LearnOut:
    """Auto-learn: a one-span correction of dictated text becomes "<heard> sounds like <correct>".
    With save=false it only reports what would be learned (the widget asks the user first)."""
    await venture_org(db, venture_id)
    pair: tuple[str, str] | None
    if body.heard is not None and body.correct is not None:
        pair = (" ".join(body.heard.split()), " ".join(body.correct.split()))
    elif body.original is not None and body.edited is not None:
        pair = speech.single_diff_region(body.original, body.edited)
    else:
        raise HTTPException(422, "send heard+correct or original+edited")
    if pair is None or not speech.is_learnable(*pair):
        return LearnOut(learned=False)
    heard, correct = pair
    if not body.save:
        return LearnOut(learned=False, heard=heard, correct=correct)
    sounds = [] if heard.lower() == correct.lower() else [heard]
    term = await _upsert_term(db, venture_id, user_id,
                              TermIn(term=correct, sounds_like=sounds, scope=body.scope), "auto_learn")
    return LearnOut(learned=True, heard=heard, correct=correct, term=term)


class SuggestionOut(BaseModel):
    term: str
    type: str
    mentions: int


@router.get("/ventures/{venture_id}/vocabulary/suggestions", response_model=list[SuggestionOut])
async def suggestions(venture_id: uuid.UUID, db: TenantDB,
                      limit: int = Query(default=30, ge=1, le=100)) -> list[SuggestionOut]:
    """Names from the knowledge graph not yet in the vocabulary — people, clients, vendors, products —
    most connected first. Role-restricted records (e.g. loan applicants) are never suggested: a
    shared term is visible to everyone in the venture."""
    await venture_org(db, venture_id)
    rows = (await db.execute(text(
        "SELECT e.name AS term, e.type, (SELECT count(*) FROM edges x WHERE x.src_id = e.id OR x.dst_id = e.id)"
        " AS mentions FROM entities e WHERE e.venture_id = :v AND e.type <> 'other' AND e.access_roles IS NULL"
        " AND NOT EXISTS (SELECT 1 FROM vocabulary_terms t WHERE t.venture_id = e.venture_id"
        "   AND lower(btrim(t.term)) = lower(btrim(e.name)))"
        " AND length(e.name) BETWEEN 2 AND 64"
        " ORDER BY mentions DESC, e.created_at DESC LIMIT :n"), {"v": venture_id, "n": limit})).all()
    return [SuggestionOut(**r._mapping) for r in rows]


# ------------------------------------------------------------------ insights --
class DayCount(BaseModel):
    day: date
    words: int
    dictations: int


class Breakdown(BaseModel):
    key: str
    words: int
    dictations: int


class InsightsOut(BaseModel):
    dictations: int
    words: int
    audio_minutes: float
    avg_wpm: int
    time_saved_minutes: int
    streak_days: int
    vocabulary_terms: int
    days: list[DayCount]
    by_engine: list[Breakdown]
    by_language: list[Breakdown]
    by_surface: list[Breakdown]
    by_mode: list[Breakdown]


IST = ZoneInfo("Asia/Kolkata")


@router.get("/me/dictation/insights", response_model=InsightsOut)
async def insights(user_id: UserId, db: TenantDB, venture_id: uuid.UUID | None = None,
                   days: int = Query(default=84, ge=7, le=366)) -> InsightsOut:
    """Your own dictation stats (never anyone else's): words, speed, time saved, streak."""
    f = "user_id = :u" + (" AND venture_id = :v" if venture_id else "")
    p = {"u": user_id, "v": venture_id, "tz": "Asia/Kolkata"}
    tot = (await db.execute(text(f"SELECT count(*) AS n, coalesce(sum(words), 0) AS w,"
                                 f" coalesce(sum(audio_ms), 0) AS ms FROM dictation_events WHERE {f}"), p)).first()
    since = datetime.now(IST).date() - timedelta(days=days - 1)
    day_rows = (await db.execute(text(
        f"SELECT (created_at AT TIME ZONE :tz)::date AS day, sum(words) AS words, count(*) AS dictations"
        f" FROM dictation_events WHERE {f} AND (created_at AT TIME ZONE :tz)::date >= :since"
        " GROUP BY 1 ORDER BY 1"), {**p, "since": since})).all()
    active = (await db.execute(text(
        f"SELECT DISTINCT (created_at AT TIME ZONE :tz)::date AS day FROM dictation_events WHERE {f}"
        " ORDER BY 1 DESC LIMIT 400"), p)).scalars().all()

    async def breakdown(col: str) -> list[Breakdown]:
        rows = (await db.execute(text(
            f"SELECT coalesce({col}, 'unknown') AS key, sum(words) AS words, count(*) AS dictations"
            f" FROM dictation_events WHERE {f} GROUP BY 1 ORDER BY 2 DESC LIMIT 20"), p)).all()
        return [Breakdown(key=r.key, words=r.words, dictations=r.dictations) for r in rows]

    vocab_n = (await db.execute(text(
        "SELECT count(*) FROM vocabulary_terms WHERE (user_id = :u OR user_id IS NULL)"
        + (" AND venture_id = :v" if venture_id else "")), p)).scalar() or 0
    minutes = tot.ms / 60000
    wpm = int(round(tot.w / minutes)) if minutes >= 0.1 else 0
    saved = max(0, int(round(tot.w / TYPING_WPM - minutes)))
    return InsightsOut(
        dictations=tot.n, words=tot.w, audio_minutes=round(minutes, 1), avg_wpm=wpm, time_saved_minutes=saved,
        streak_days=streak(active, datetime.now(IST).date()), vocabulary_terms=vocab_n,
        days=[DayCount(day=r.day, words=r.words, dictations=r.dictations) for r in day_rows],
        by_engine=await breakdown("engine"), by_language=await breakdown("language"),
        by_surface=await breakdown("surface"), by_mode=await breakdown("mode"))


def streak(active_days_desc: list[date], today: date) -> int:
    """Consecutive days with a dictation, ending today (or yesterday, so the streak survives the morning)."""
    days = set(active_days_desc)
    cur = today if today in days else today - timedelta(days=1)
    n = 0
    while cur in days:
        n += 1
        cur -= timedelta(days=1)
    return n


@router.delete("/me/dictation/history", status_code=204)
async def clear_history(user_id: UserId, db: TenantDB) -> None:
    """Delete your dictation statistics (they never contained text or audio)."""
    await db.execute(text("DELETE FROM dictation_events WHERE user_id = :u"), {"u": user_id})


__all__ = ["router", "dictate", "ENGINES"]
