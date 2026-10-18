"""Speech for phone calls, with the business's own keys (BYOK) or Kritvia's.

Speech-to-text (what the caller said):
  platform   Kritvia's speech chain (the model router's dictation tier: Groq Whisper, then the server's
             own Whisper), never a provider whose terms allow training on the audio
  sarvam     the business's Sarvam key (Indian languages; saaras/saarika)
  openai     the business's OpenAI key, or any OpenAI-compatible server (Groq, a self-hosted Whisper)
  deepgram   the business's Deepgram key (nova-3, Hindi-English code-switching with language=multi)
  local      the speech server on Kritvia's own machine (speaches: faster-whisper), VOICE_LOCAL_URL

Text-to-speech (Kritvia's voice):
  platform   Kritvia's own voice: the speech server on Kritvia's machine (same as local), when it runs
  sarvam     the business's Sarvam key
  openai     the business's OpenAI key, or any OpenAI-compatible server
  elevenlabs the business's ElevenLabs key
  local      speaches on Kritvia's own machine (Kokoro / Piper voices), VOICE_LOCAL_URL

Keys are stored encrypted (voice_keys) and never shown again. Audio isn't kept: each turn is sent to
the chosen provider and only the text stays (in the call's encrypted conversation).
"""
from __future__ import annotations

import base64
import logging
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.services import voice_media as vm

log = logging.getLogger(__name__)
KEY = "voice_keys.key"
STT_PROVIDERS = ("platform", "sarvam", "openai", "deepgram", "local")
TTS_PROVIDERS = ("platform", "sarvam", "openai", "elevenlabs", "local")
KEYED = ("sarvam", "openai", "deepgram", "elevenlabs")

DEFAULTS = {
    "sarvam": {"tts_model": "bulbul:v2", "voice": "anushka", "stt_model": ""},
    "openai": {"tts_model": "gpt-4o-mini-tts", "voice": "marin", "stt_model": "gpt-4o-mini-transcribe",
               "base": "https://api.openai.com/v1"},
    "elevenlabs": {"tts_model": "eleven_flash_v2_5", "voice": "21m00Tcm4TlvDq8ikWAM"},
    "deepgram": {"stt_model": "nova-3"},
    "local": {"tts_model": "speaches-ai/Kokoro-82M-v1.0-ONNX", "voice": "hf_alpha",
              "stt_model": "Systran/faster-whisper-small"},
}

_transport: httpx.AsyncBaseTransport | None = None


def set_transport(t: httpx.AsyncBaseTransport | None) -> None:
    """Tests: answer the providers' HTTP calls."""
    global _transport
    _transport = t


def _http(timeout: float = 30) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, transport=_transport)


class SpeechError(Exception):
    pass


@dataclass
class Stack:
    stt: str = "platform"
    tts: str = "platform"
    language: str = "hi-IN"
    stt_model: str | None = None
    tts_model: str | None = None
    voice: str | None = None
    keys: dict[str, tuple[str, str | None]] | None = None    # provider -> (key, base_url)

    def key(self, provider: str) -> tuple[str, str | None]:
        k = (self.keys or {}).get(provider)
        if not k:
            raise SpeechError(f"no {provider} key is saved for this business")
        return k


async def stack_for(conn, crypto, venture_id: uuid.UUID) -> Stack:
    s = (await conn.execute(text("SELECT language, stt_provider, tts_provider, stt_model, tts_model, tts_voice"
                                 " FROM phone_settings WHERE venture_id = :v"), {"v": venture_id})).first()
    rows = (await conn.execute(text("SELECT provider, key_enc, base_url FROM voice_keys WHERE venture_id = :v"),
                               {"v": venture_id})).all()
    keys = {r.provider: (await crypto.decrypt_str(venture_id, KEY, r.key_enc), r.base_url) for r in rows}
    if s is None:
        return Stack(keys=keys)
    return Stack(stt=s.stt_provider, tts=s.tts_provider, language=s.language, stt_model=s.stt_model,
                 tts_model=s.tts_model, voice=s.tts_voice, keys=keys)


def tts_ready(stack: Stack) -> str | None:
    """None when Kritvia can speak with this set-up, else why not."""
    st = get_settings()
    if stack.tts == "platform" and not st.voice_local_url:
        return "Kritvia's own voice isn't set up on this server; choose a voice provider with your key"
    if stack.tts == "local" and not st.voice_local_url:
        return "the local speech server isn't running on this server"
    if stack.tts in KEYED and not (stack.keys or {}).get(stack.tts):
        return f"save your {stack.tts} key first"
    return None


# ----------------------------------------------------------------------------------- speech-to-text --
async def transcribe(svc, actor, stack: Stack, pcm: bytes, rate: int) -> str:
    """What the caller said (empty if nothing intelligible)."""
    if rate != 16000:
        pcm, rate = vm.resample(pcm, rate, 16000), 16000
    audio = vm.to_wav(pcm, rate)
    lang2 = stack.language.split("-")[0]
    try:
        if stack.stt == "platform":
            from kritvia_api.services.model_router import transcribe as router_transcribe
            t = await router_transcribe(svc.router, actor.call_ctx("voice"), audio, "turn.wav",
                                        language=lang2, tier="dictation", no_training=True)
            return t.text.strip()
        async with _http() as h:
            if stack.stt == "sarvam":
                key, base = stack.key("sarvam")
                data: dict[str, Any] = {"language_code": stack.language if stack.language in ("hi-IN", "en-IN") else "unknown"}
                if stack.stt_model:
                    data["model"] = stack.stt_model
                r = await h.post(f"{(base or 'https://api.sarvam.ai').rstrip('/')}/speech-to-text", data=data,
                                 files={"file": ("turn.wav", audio, "audio/wav")}, headers={"api-subscription-key": key})
                _ok(r, "Sarvam")
                return str(r.json().get("transcript") or "").strip()
            if stack.stt == "deepgram":
                key, base = stack.key("deepgram")
                model = stack.stt_model or DEFAULTS["deepgram"]["stt_model"]
                lang = "multi" if lang2 == "hi" else "en"
                r = await h.post(f"{(base or 'https://api.deepgram.com').rstrip('/')}/v1/listen",
                                 params={"model": model, "language": lang, "smart_format": "true"}, content=audio,
                                 headers={"Authorization": f"Token {key}", "Content-Type": "audio/wav"})
                _ok(r, "Deepgram")
                alts = (((r.json().get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}])
                return str(alts[0].get("transcript") or "").strip()
            if stack.stt in ("openai", "local"):
                if stack.stt == "local":
                    key, base = "none", get_settings().voice_local_url
                    if not base:
                        raise SpeechError("the local speech server isn't running on this server")
                    model = stack.stt_model or DEFAULTS["local"]["stt_model"]
                else:
                    key, base = stack.key("openai")
                    model = stack.stt_model or DEFAULTS["openai"]["stt_model"]
                r = await h.post(f"{(base or DEFAULTS['openai']['base']).rstrip('/')}/audio/transcriptions",
                                 data={"model": model, "language": lang2, "response_format": "json"},
                                 files={"file": ("turn.wav", audio, "audio/wav")},
                                 headers={"Authorization": f"Bearer {key}"})
                _ok(r, "the speech server")
                return str(r.json().get("text") or "").strip()
    except httpx.HTTPError as exc:
        raise SpeechError(f"speech-to-text didn't answer ({type(exc).__name__})") from None
    raise SpeechError(f"unknown speech-to-text provider {stack.stt!r}")


# ----------------------------------------------------------------------------------- text-to-speech --
async def synthesize(stack: Stack, say: str, rate: int) -> bytes:
    """Kritvia's words as 16-bit mono PCM at `rate` Hz."""
    say = " ".join(say.split())[:1500]
    if not say:
        return b""
    st = get_settings()
    try:
        async with _http(45) as h:
            if stack.tts == "sarvam":
                key, base = stack.key("sarvam")
                out_rate = 8000 if rate <= 8000 else 16000
                body = {"text": say, "target_language_code": stack.language, "language_code": stack.language,
                        "speaker": stack.voice or DEFAULTS["sarvam"]["voice"],
                        "model": stack.tts_model or DEFAULTS["sarvam"]["tts_model"], "speech_sample_rate": out_rate}
                r = await h.post(f"{(base or 'https://api.sarvam.ai').rstrip('/')}/text-to-speech", json=body,
                                 headers={"api-subscription-key": key})
                _ok(r, "Sarvam")
                pcm, got = _audio_from(r)
                return vm.resample(pcm, got, rate)
            if stack.tts == "elevenlabs":
                key, base = stack.key("elevenlabs")
                voice = stack.voice or DEFAULTS["elevenlabs"]["voice"]
                r = await h.post(f"{(base or 'https://api.elevenlabs.io').rstrip('/')}/v1/text-to-speech/{voice}",
                                 params={"output_format": "pcm_16000"},
                                 json={"text": say, "model_id": stack.tts_model or DEFAULTS["elevenlabs"]["tts_model"]},
                                 headers={"xi-api-key": key})
                _ok(r, "ElevenLabs")
                return vm.resample(r.content, 16000, rate)
            if stack.tts in ("openai", "local", "platform"):
                if stack.tts in ("local", "platform"):
                    key, base, d = "none", st.voice_local_url, DEFAULTS["local"]
                    if not base:
                        raise SpeechError("the local speech server isn't running on this server")
                else:
                    (key, base), d = stack.key("openai"), DEFAULTS["openai"]
                r = await h.post(f"{(base or DEFAULTS['openai']['base']).rstrip('/')}/audio/speech",
                                 json={"model": stack.tts_model or d["tts_model"], "voice": stack.voice or d["voice"],
                                       "input": say, "response_format": "pcm"},
                                 headers={"Authorization": f"Bearer {key}"})
                _ok(r, "the speech server")
                return vm.resample(r.content, 24000, rate)       # OpenAI's "pcm" is 24 kHz 16-bit mono
    except httpx.HTTPError as exc:
        raise SpeechError(f"text-to-speech didn't answer ({type(exc).__name__})") from None
    raise SpeechError(f"unknown voice provider {stack.tts!r}")


def _ok(r: httpx.Response, who: str) -> None:
    if r.status_code in (401, 403):
        raise SpeechError(f"{who} didn't accept the key")
    if r.status_code >= 400:
        try:
            msg = r.json()
            msg = (msg.get("error") or {}).get("message") if isinstance(msg.get("error"), dict) else msg.get("detail") or msg
        except ValueError:
            msg = r.text
        raise SpeechError(f"{who} said: {str(msg)[:200]}")


def _audio_from(r: httpx.Response) -> tuple[bytes, int]:
    """Sarvam answers JSON with base64 WAV in "audios"; a raw WAV body is accepted too."""
    data = r.content
    if "json" in (r.headers.get("content-type") or ""):
        body = r.json()
        audios = body.get("audios") or []
        if not audios:
            raise SpeechError("the voice provider sent no audio")
        data = base64.b64decode(audios[0])
    if data[:4] == b"RIFF":
        return vm.from_wav(data)
    raise SpeechError("the voice provider sent audio in a format Kritvia can't play")
