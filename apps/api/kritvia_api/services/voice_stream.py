"""Live phone calls over media streams: Kritvia listens and speaks itself (its own speech pipeline).

Works with any phone company that streams call audio over a WebSocket. Two are built in:
  ExotelAdapter   Indian numbers (Exotel Voicebot applet; 16-bit PCM at 8/16 kHz, snake_case JSON)
  TwilioAdapter   numbers in the rest of the world (Twilio Media Streams; mu-law 8 kHz, camelCase JSON)

A StreamSession runs one call:
  listen    caller audio -> TurnDetector -> at the end of a turn, speech-to-text (voice_speech)
  think     voice_calls.turn(): the same call brain as the Twilio <Gather> mode and the in-app test call
  speak     text-to-speech -> audio chunks back to the phone company, then a "mark" to know when it
            finished playing
  barge-in  the caller starts talking while Kritvia speaks -> "clear" (the rest isn't played)
  silence   nothing heard for NO_INPUT_S after Kritvia finished speaking counts as a silence (two end the call)
  goodbye   the last words play, then the stream closes (Exotel's flow goes on to its Hangup applet;
            Twilio's TwiML hangs up)
  stop      the call ended: the summary, lead and tasks (voice_calls.finish)
Audio isn't stored; only the text of what was said, as in every call.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import text

from kritvia_api.services import voice_calls as vc
from kritvia_api.services import voice_media as vm
from kritvia_api.services import voice_speech as vs

log = logging.getLogger(__name__)
NO_INPUT_S = 8.0
BYE_GRACE_S = 1.5


class ExotelAdapter:
    name = "exotel"

    def __init__(self) -> None:
        self.sid: str | None = None
        self.rate = 8000
        self.mulaw = False

    def start(self, msg: dict[str, Any]) -> dict[str, Any]:
        st = msg.get("start") or {}
        self.sid = str(msg.get("stream_sid") or st.get("stream_sid") or "")
        fmt = st.get("media_format") or {}
        self.mulaw = "ulaw" in str(fmt.get("encoding", "")).lower() or "mulaw" in str(fmt.get("encoding", "")).lower()
        try:
            self.rate = int(fmt.get("sample_rate") or 8000)
        except (TypeError, ValueError):
            self.rate = 8000
        if self.rate not in (8000, 16000, 24000):
            self.rate = 8000
        return {"call_sid": str(st.get("call_sid") or ""), "from": str(st.get("from") or ""),
                "to": str(st.get("to") or ""), "custom": st.get("custom_parameters") or {}}

    def decode(self, msg: dict[str, Any]) -> bytes:
        raw = base64.b64decode((msg.get("media") or {}).get("payload") or "")
        return vm.ulaw_to_pcm(raw) if self.mulaw else raw

    def chunks(self, pcm: bytes) -> list[dict[str, Any]]:
        """Exotel wants chunks of 3,200-100,000 bytes in multiples of 320."""
        data = vm.pcm_to_ulaw(pcm) if self.mulaw else pcm
        size = 6400
        out = []
        for i in range(0, len(data), size):
            c = data[i:i + size]
            want = max(3200, -(-len(c) // 320) * 320)
            c += (b"\xff" if self.mulaw else b"\x00") * (want - len(c))
            out.append({"event": "media", "stream_sid": self.sid, "media": {"payload": base64.b64encode(c).decode()}})
        return out

    def mark(self, name: str) -> dict[str, Any]:
        return {"event": "mark", "stream_sid": self.sid, "mark": {"name": name}}

    def clear(self) -> dict[str, Any]:
        return {"event": "clear", "stream_sid": self.sid}


class TwilioAdapter:
    name = "twilio"

    def __init__(self) -> None:
        self.sid: str | None = None
        self.rate = 8000

    def start(self, msg: dict[str, Any]) -> dict[str, Any]:
        st = msg.get("start") or {}
        self.sid = str(st.get("streamSid") or msg.get("streamSid") or "")
        return {"call_sid": str(st.get("callSid") or ""), "from": "", "to": "", "custom": st.get("customParameters") or {}}

    def decode(self, msg: dict[str, Any]) -> bytes:
        return vm.ulaw_to_pcm(base64.b64decode((msg.get("media") or {}).get("payload") or ""))

    def chunks(self, pcm: bytes) -> list[dict[str, Any]]:
        data = vm.pcm_to_ulaw(pcm)
        return [{"event": "media", "streamSid": self.sid, "media": {"payload": base64.b64encode(data[i:i + 1600]).decode()}}
                for i in range(0, len(data), 1600)]

    def mark(self, name: str) -> dict[str, Any]:
        return {"event": "mark", "streamSid": self.sid, "mark": {"name": name}}

    def clear(self) -> dict[str, Any]:
        return {"event": "clear", "streamSid": self.sid}


Send = Callable[[dict[str, Any]], Awaitable[None]]
Transfer = Callable[[str, str], Awaitable[bool]]       # (provider call id, number) -> put through?


class StreamSession:
    def __init__(self, svc, p: vc.Principal, adapter, send: Send, *, call_id: uuid.UUID | None = None,
                 transfer: Transfer | None = None, no_input_s: float = NO_INPUT_S) -> None:
        self.svc, self.p, self.adapter, self.send = svc, p, adapter, send
        self.call_id = call_id
        self.transfer = transfer
        self.no_input_s = no_input_s
        self.detector: vm.TurnDetector | None = None
        self.stack: vs.Stack | None = None
        self.provider_call_id = ""
        self.started_at = time.monotonic()
        self.speaking_until = 0.0
        self.last_heard = time.monotonic()
        self.marks = 0
        self.busy = False
        self.ending = False
        self.closed = asyncio.Event()
        self.finished = False
        self.tasks: set[asyncio.Task] = set()
        self.log: list[str] = []          # what happened, for tests and logs (no call content)

    # ------------------------------------------------------------------------------------- events --
    async def handle(self, msg: dict[str, Any]) -> bool:
        """One message from the phone company. False: close the stream."""
        ev = msg.get("event")
        if ev == "start":
            return await self._start(msg)
        if self.detector is None:
            return True
        if ev == "media":
            self._media(msg)
        elif ev == "dtmf":
            digit = str((msg.get("dtmf") or {}).get("digit") or "")[:1]
            if digit and not self.busy:
                self._spawn(self._respond(None, digit))
        elif ev == "mark":
            name = str((msg.get("mark") or {}).get("name") or "")
            if name == f"m{self.marks}":
                self.speaking_until = 0.0
                self.last_heard = time.monotonic()
            if name == "bye":
                self.closed.set()
                return False
        elif ev == "stop":
            await self.finish()
            return False
        return not self.closed.is_set()

    async def _start(self, msg: dict[str, Any]) -> bool:
        info = self.adapter.start(msg)
        self.provider_call_id = info["call_sid"][:80]
        actor = vc.Actor(self.svc, self.p)
        async with actor.tx() as conn:
            crypto = actor.crypto(conn)
            if self.call_id is None:
                from kritvia_api.services import twilio_voice as tw
                existing = (await conn.execute(text(
                    "SELECT id FROM calls WHERE connector_id = :c AND provider_call_id = :s"),
                    {"c": self.p.connector_id, "s": self.provider_call_id})).scalar() if self.provider_call_id else None
                if existing:
                    self.call_id = existing
                else:
                    self.call_id, _ = await vc.new_call(conn, crypto, self.p, direction="inbound",
                                                        phone=tw.normalise_phone(info["from"]) or None, test=False,
                                                        provider_call_id=self.provider_call_id or None)
            else:
                row = (await conn.execute(text("SELECT id FROM calls WHERE id = :id AND venture_id = :v"),
                                          {"id": self.call_id, "v": self.p.venture_id})).first()
                if row is None:
                    self.log.append("unknown call")
                    return False
                if self.provider_call_id:
                    await conn.execute(text("UPDATE calls SET provider_call_id = coalesce(provider_call_id, :s),"
                                            " connector_id = coalesce(connector_id, :c), status = 'in_progress'"
                                            " WHERE id = :id"),
                                       {"s": self.provider_call_id, "c": self.p.connector_id, "id": self.call_id})
            self.stack = await vs.stack_for(conn, crypto, self.p.venture_id)
        why = vs.tts_ready(self.stack)
        if why:
            log.warning("voice stream: can't speak (%s)", why)
            self.log.append("no voice")
            await self.finish()
            return False
        self.detector = vm.TurnDetector(self.adapter.rate)
        first, _ = await vc.opening_line(self.svc, self.p, self.call_id)
        self._spawn(self._speak_only(first))
        self._spawn(self._watch())
        return True

    def _media(self, msg: dict[str, Any]) -> None:
        assert self.detector is not None
        for kind, pcm in self.detector.feed(self.adapter.decode(msg)):
            if kind == "speech_start":
                self.last_heard = time.monotonic()
                if self.speaking and not self.ending:
                    self.log.append("barge-in")
                    self.speaking_until = 0.0
                    self._spawn(self.send(self.adapter.clear()))
            elif kind == "utterance" and pcm and not self.busy and not self.ending:
                self._spawn(self._respond(pcm, None))

    @property
    def speaking(self) -> bool:
        return time.monotonic() < self.speaking_until

    # --------------------------------------------------------------------------------------- turns --
    async def _respond(self, pcm: bytes | None, digits: str | None, *, silent: bool = False) -> None:
        self.busy = True
        try:
            heard = ""
            if pcm:
                try:
                    heard = await vs.transcribe(self.svc, vc.Actor(self.svc, self.p), self.stack, pcm,
                                                self.adapter.rate)
                except vs.SpeechError as exc:
                    log.warning("voice stream: speech-to-text failed: %s", exc)
                if not heard:
                    return                      # noise, not words: keep listening
            elif not digits and not silent:
                return
            self.last_heard = time.monotonic()
            step, _ = await vc.turn(self.svc, self.p, self.call_id, heard=heard, digits=digits,
                                    transfer_ok=self.transfer is not None)
            self.log.append(step.kind)
            if step.kind == "transfer" and self.transfer is not None and step.number:
                await self._speak_only(step.say)
                await self._wait_playback()
                if await self.transfer(self.provider_call_id, step.number):
                    self.ending = True
                    self.closed.set()
                    return
                step, _ = await vc.turn(self.svc, self.p, self.call_id, heard="", dial_status="failed")
            await self._speak_only(step.say)
            if step.ended:
                self.ending = True
                await self.send(self.adapter.mark("bye"))
                self._spawn(self._close_after_playback())
        except Exception:  # noqa: BLE001 - a broken turn must not leave the caller in silence forever
            log.exception("voice stream: turn failed")
        finally:
            self.busy = False

    async def _speak_only(self, say: str) -> None:
        if not say:
            return
        try:
            pcm = await vs.synthesize(self.stack, say, self.adapter.rate)
        except vs.SpeechError as exc:
            log.warning("voice stream: text-to-speech failed: %s", exc)
            return
        for m in self.adapter.chunks(pcm):
            await self.send(m)
        self.marks += 1
        await self.send(self.adapter.mark(f"m{self.marks}"))
        seconds = len(pcm) / 2 / self.adapter.rate
        self.speaking_until = time.monotonic() + seconds
        self.last_heard = time.monotonic() + seconds

    async def _wait_playback(self) -> None:
        while self.speaking:
            await asyncio.sleep(0.1)

    async def _close_after_playback(self) -> None:
        await asyncio.sleep(max(0.0, self.speaking_until - time.monotonic()) + BYE_GRACE_S)
        self.closed.set()

    async def _watch(self) -> None:
        """Silence: nothing heard for a while after Kritvia finished speaking."""
        while not self.closed.is_set():
            await asyncio.sleep(0.25)
            if (not self.busy and not self.ending and not self.speaking and self.detector is not None
                    and not self.detector.talking and time.monotonic() - self.last_heard > self.no_input_s):
                self.last_heard = time.monotonic()
                await self._respond(None, None, silent=True)

    def _spawn(self, coro) -> None:
        t = asyncio.get_running_loop().create_task(coro)
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    async def idle(self) -> None:
        """Tests: wait for every task started so far (except the silence watch)."""
        while True:
            pending = [t for t in self.tasks if not t.done() and t.get_coro().__name__ != "_watch"]
            if not pending:
                return
            await asyncio.gather(*pending, return_exceptions=True)

    async def finish(self) -> None:
        """The call is over (or the stream closed): the summary, lead and tasks, once."""
        self.closed.set()
        for t in list(self.tasks):
            if t.get_coro().__name__ == "_watch":
                t.cancel()
        if self.finished or self.call_id is None:
            return
        self.finished = True
        try:
            await vc.finish(self.svc, self.p, self.call_id, status="completed",
                            duration_s=int(time.monotonic() - self.started_at))
        except Exception:  # noqa: BLE001
            log.exception("voice stream: finishing the call failed")
