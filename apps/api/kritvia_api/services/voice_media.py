"""Audio for phone calls: mu-law <-> 16-bit PCM, resampling, WAV, loudness, and turn detection.

Phone networks carry 8 kHz audio: Twilio Media Streams send mu-law, Exotel sends 16-bit PCM (8 or 16
kHz). Speech-to-text wants 16 kHz PCM; text-to-speech returns 8-48 kHz. Python 3.12's audioop does the
heavy lifting when it is there; pure-Python fallbacks keep this working on later Pythons.

TurnDetector decides when the caller has finished speaking: an adaptive noise floor (phone lines hum),
speech when a 20 ms frame is clearly above it, the end of a turn after END_MS of quiet. It also reports
the start of speech, which is how a caller interrupts Kritvia (barge-in).
"""
from __future__ import annotations

import array
import io
import math
import sys
import wave
import warnings
from dataclasses import dataclass, field

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    try:
        import audioop  # type: ignore[import-not-found]   # Python <= 3.12
    except ImportError:  # pragma: no cover - Python 3.13+
        audioop = None

_BIG = sys.byteorder == "big"


# ------------------------------------------------------------------------------------------ mu-law --
def _ulaw_decode_table() -> list[int]:
    out = []
    for b in range(256):
        u = ~b & 0xFF
        sign, exp, mant = u & 0x80, (u >> 4) & 0x07, u & 0x0F
        s = ((mant << 3) + 0x84) << exp
        s -= 0x84
        out.append(-s if sign else s)
    return out


_ULAW = _ulaw_decode_table()


def _ulaw_encode_one(s: int) -> int:
    sign = 0x80 if s < 0 else 0
    s = min(-s if s < 0 else s, 32635) + 0x84
    exp = 7
    mask = 0x4000
    while exp > 0 and not s & mask:
        exp -= 1
        mask >>= 1
    mant = (s >> (exp + 3)) & 0x0F
    return ~(sign | (exp << 4) | mant) & 0xFF


def _samples(pcm: bytes) -> array.array:
    a = array.array("h")
    a.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if _BIG:
        a.byteswap()
    return a


def _bytes(a: array.array) -> bytes:
    if _BIG:
        a = array.array("h", a)
        a.byteswap()
    return a.tobytes()


def ulaw_to_pcm(data: bytes) -> bytes:
    if audioop is not None:
        return audioop.ulaw2lin(data, 2)
    return _bytes(array.array("h", (_ULAW[b] for b in data)))


def pcm_to_ulaw(pcm: bytes) -> bytes:
    if audioop is not None:
        return audioop.lin2ulaw(pcm[: len(pcm) - len(pcm) % 2], 2)
    return bytes(_ulaw_encode_one(s) for s in _samples(pcm))


# -------------------------------------------------------------------------------------- resampling --
def resample(pcm: bytes, src: int, dst: int) -> bytes:
    """16-bit mono PCM from `src` Hz to `dst` Hz."""
    if src == dst or not pcm:
        return pcm
    if audioop is not None:
        return audioop.ratecv(pcm[: len(pcm) - len(pcm) % 2], 2, 1, src, dst, None)[0]
    s = _samples(pcm)
    n = max(1, int(len(s) * dst / src))
    out = array.array("h", [0]) * n
    step = src / dst
    for i in range(n):
        x = i * step
        j = int(x)
        f = x - j
        a = s[j] if j < len(s) else 0
        b = s[j + 1] if j + 1 < len(s) else a
        out[i] = int(a + (b - a) * f)
    return _bytes(out)


def rms(pcm: bytes) -> int:
    if not pcm:
        return 0
    if audioop is not None:
        return audioop.rms(pcm[: len(pcm) - len(pcm) % 2], 2)
    s = _samples(pcm)
    return int(math.sqrt(sum(x * x for x in s) / max(len(s), 1)))


def silence(ms: int, rate: int) -> bytes:
    return b"\x00\x00" * int(rate * ms / 1000)


# --------------------------------------------------------------------------------------------- WAV --
def to_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def from_wav(data: bytes) -> tuple[bytes, int]:
    """(16-bit mono PCM, sample rate). Stereo is mixed down; 8-bit is widened."""
    with wave.open(io.BytesIO(data), "rb") as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if audioop is not None:
        if width != 2:
            frames = audioop.lin2lin(frames, width, 2)
        if ch == 2:
            frames = audioop.tomono(frames, 2, 0.5, 0.5)
        return frames, rate
    if width != 2 or ch != 1:  # pragma: no cover - only without audioop
        raise ValueError("only 16-bit mono WAV is supported here")
    return frames, rate


# -------------------------------------------------------------------------------- turn detection --
@dataclass
class TurnDetector:
    """Feed 16-bit PCM at `rate`; get ("speech_start", None) and ("utterance", pcm) events."""
    rate: int
    frame_ms: int = 20
    start_ms: int = 100          # this much speech starts a turn
    end_ms: int = 700            # this much quiet ends it
    min_ms: int = 300            # shorter bursts (a cough, a click) are dropped
    max_ms: int = 15_000         # a turn this long is cut and answered
    floor: float = 200.0
    _buf: bytes = b""
    _speech: bytearray = field(default_factory=bytearray)
    _voiced_run: int = 0
    _quiet_run: int = 0
    _talking: bool = False
    _pre: list[bytes] = field(default_factory=list)

    @property
    def frame_bytes(self) -> int:
        return int(self.rate * self.frame_ms / 1000) * 2

    def threshold(self) -> float:
        return max(self.floor * 3.0, 350.0)

    def feed(self, pcm: bytes) -> list[tuple[str, bytes | None]]:
        events: list[tuple[str, bytes | None]] = []
        self._buf += pcm
        fb = self.frame_bytes
        while len(self._buf) >= fb:
            frame, self._buf = self._buf[:fb], self._buf[fb:]
            level = rms(frame)
            voiced = level > self.threshold()
            if not self._talking:
                if not voiced:
                    self.floor = 0.95 * self.floor + 0.05 * level
                self._pre = (self._pre + [frame])[-(self.start_ms // self.frame_ms + 5):]
                self._voiced_run = self._voiced_run + 1 if voiced else 0
                if self._voiced_run * self.frame_ms >= self.start_ms:
                    self._talking, self._quiet_run = True, 0
                    self._speech = bytearray(b"".join(self._pre))
                    self._pre = []
                    events.append(("speech_start", None))
                continue
            self._speech += frame
            self._quiet_run = 0 if voiced else self._quiet_run + 1
            length_ms = len(self._speech) // 2 * 1000 // self.rate
            if self._quiet_run * self.frame_ms >= self.end_ms or length_ms >= self.max_ms:
                spoken = bytes(self._speech)
                self._talking, self._speech, self._voiced_run, self._quiet_run = False, bytearray(), 0, 0
                if length_ms - self.end_ms >= self.min_ms or length_ms >= self.max_ms:
                    events.append(("utterance", spoken))
        return events

    @property
    def talking(self) -> bool:
        return self._talking
