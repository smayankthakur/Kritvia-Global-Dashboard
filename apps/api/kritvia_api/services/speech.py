"""Speech post-processing: transcript cleanup, vocabulary, spelling hints and auto-learn.

The cleanup filters and the auto-learn diff are ported from AIT-Scribe
(https://github.com/aithinkers/scribe, MIT, (c) AI Thinkers LLC) — see
THIRD_PARTY_NOTICES.md. Kritvia additions: Indic-safe word boundaries, the
"sounds like" vocabulary model, and spelling hints drawn from the venture's
knowledge graph.

Order of operations (same as Scribe): hallucination strip -> stuck-loop trim ->
filler removal -> profanity mask -> vocabulary replacement.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Letters, digits and combining marks of Latin and the Indic scripts (Devanagari .. Malayalam,
# Sinhala). Python's \b treats Devanagari vowel signs (category Mn) as non-word characters, which
# would let "क" match inside "कि"; these explicit look-arounds don't.
_WORD = r"0-9A-Za-z_À-ɏऀ-෿"
_B_BEFORE = rf"(?<![{_WORD}])"
_B_AFTER = rf"(?![{_WORD}])"

# ------------------------------------------------------------------ filters --
# [BLANK_AUDIO], (dramatic music), *cough*: closed-caption artefacts Whisper emits on silence.
_ANNOTATION = re.compile(r"\[[^\]\n]*\]|\([^)\n]*\)|\*[^*\n]+\*")

_FILLER = re.compile(rf"{_B_BEFORE}(?:uh+|um+|uhm+|er+|erm+){_B_AFTER},?", re.IGNORECASE)
_DOUBLE_COMMA = re.compile(r",\s*,")
_SPACES = re.compile(r"\s{2,}")

_PROFANITY = ("fuck", "fucking", "shit", "bullshit", "ass", "asshole", "damn", "bitch", "bastard", "dick",
              "cock", "pussy", "cunt", "whore", "slut", "motherfucker",
              # common Hindi/Hinglish
              "chutiya", "chutiye", "bhenchod", "behenchod", "madarchod", "bhosdike", "gaandu", "harami")
_PROFANITY_RE = re.compile(rf"{_B_BEFORE}(?:{'|'.join(map(re.escape, _PROFANITY))}){_B_AFTER}", re.IGNORECASE)


def strip_annotations(text_: str) -> str:
    """Remove bracketed caption annotations only. Real words are never rejected: Scribe found that
    dropping "likely hallucinations" like "thank you" wiped legitimate short dictations."""
    if not text_ or not text_.strip():
        return ""
    if not _ANNOTATION.search(text_):
        return _SPACES.sub(" ", text_).strip()
    out = _SPACES.sub(" ", _ANNOTATION.sub(" ", text_)).strip()
    # punctuation orphaned by the removal: "[BLANK_AUDIO]. Okay." -> "Okay."
    return re.sub(r"^[.,!?;:\-—\"' ]+", "", out).strip()


def trim_stuck_loops(text_: str) -> str:
    """Whisper's repetition collapse: a >= 3-word phrase repeated >= 4 times in a row.
    Keeps the first occurrence plus one repeat."""
    words = text_.split()
    if len(words) < 12:
        return text_
    for n in range(3, min(8, len(words) // 4) + 1):  # shortest period first: 'a b c' x8, not 'a b c a b c' x4
        for start in range(0, len(words) - n * 4 + 1):
            phrase = words[start:start + n]
            reps, nxt = 1, start + n
            while nxt + n <= len(words) and words[nxt:nxt + n] == phrase:
                reps += 1
                nxt += n
            if reps >= 4:
                return " ".join(words[:start + n * 2] + words[nxt:])
    return text_


def remove_fillers(text_: str) -> str:
    """Drop vocalised pauses (uh, um, er, erm and their length variants). Keeps hmm/ah/mhm."""
    if not text_ or not text_.strip():
        return ""
    capital = text_[0].isupper()
    out = _FILLER.sub("", text_)
    out = _SPACES.sub(" ", _DOUBLE_COMMA.sub(",", out)).strip().rstrip(",;: \t")
    out = re.sub(r"\s+([,.!?;:])", r"\1", out)
    out = re.sub(r"^[,;:]\s*", "", out)
    if out and capital and out[0].islower():
        out = out[0].upper() + out[1:]
    return out


def mask_profanity(text_: str) -> str:
    return _PROFANITY_RE.sub(lambda m: "*" * len(m.group(0)), text_)


# --------------------------------------------------------------- vocabulary --
@dataclass(frozen=True)
class VocabEntry:
    id: uuid.UUID | None
    term: str
    sounds_like: tuple[str, ...] = ()
    case_sensitive: bool = False


def _phrase_re(phrase: str, case_sensitive: bool) -> re.Pattern[str]:
    body = r"\s+".join(re.escape(p) for p in phrase.split())
    return re.compile(rf"{_B_BEFORE}{body}{_B_AFTER}", 0 if case_sensitive else re.IGNORECASE)


def apply_vocabulary(text_: str, entries: list[VocabEntry]) -> tuple[str, list[uuid.UUID]]:
    """Replace each misheard form with its term, and enforce the term's own spelling/casing.
    Longer phrases first so "kreet via ai" wins over "kreet via". Returns (text, ids used)."""
    if not text_ or not entries:
        return text_, []
    rules: list[tuple[str, VocabEntry]] = []
    for e in entries:
        term = e.term.strip()
        if not term:
            continue
        for s in e.sounds_like:
            if s.strip() and s.strip().lower() != term.lower():
                rules.append((s.strip(), e))
        rules.append((term, e))  # casing / spacing of the term itself
    rules.sort(key=lambda r: len(r[0]), reverse=True)
    used: list[uuid.UUID] = []
    out = text_
    placeholders: dict[str, str] = {}
    for i, (heard, e) in enumerate(rules):
        term = e.term.strip()
        pat = _phrase_re(heard, e.case_sensitive and heard == term)
        token = chr(0xF0000 + i)  # private-use code point: later (shorter) rules cannot match it
        changed = False

        def _sub(m: re.Match[str], term: str = term, token: str = token) -> str:
            nonlocal changed
            changed = changed or m.group(0) != term
            placeholders[token] = term
            return token

        out = pat.sub(_sub, out)
        if changed and e.id and e.id not in used:
            used.append(e.id)
    for token, term in placeholders.items():
        out = out.replace(token, term)
    return out, used


# --------------------------------------------------------------- auto-learn --
_PUNCT = " \t\n\r.,!?;:\"'`()[]{}—–-"


def _strip(w: str) -> str:
    return w.strip(_PUNCT)


def single_diff_region(old: str, new: str) -> tuple[str, str] | None:
    """The one contiguous word span the user changed, as (heard, correct), or None.
    Pure insertions/deletions are not corrections. Mirrors Scribe's AutoLearnDiffing."""
    a, b = old.split(), new.split()
    p = 0
    n = min(len(a), len(b))
    while p < n and _strip(a[p]).lower() == _strip(b[p]).lower():
        p += 1
    s = 0
    while s < n - p and _strip(a[-1 - s]).lower() == _strip(b[-1 - s]).lower():
        s += 1
    old_d, new_d = a[p:len(a) - s], b[p:len(b) - s]
    if not old_d or not new_d:
        # identical ignoring case/punctuation: a pure casing fix of one word still counts
        if len(a) == len(b):
            diffs = [(x, y) for x, y in zip(a, b) if _strip(x) != _strip(y)]
            if len(diffs) == 1 and _strip(diffs[0][0]) and _strip(diffs[0][1]):
                return _strip(diffs[0][0]), _strip(diffs[0][1])
        return None
    heard = " ".join(_strip(w) for w in old_d).strip()
    correct = " ".join(_strip(w) for w in new_d).strip()
    if not heard or not correct or heard == correct:
        return None
    return heard, correct


def is_learnable(heard: str, correct: str) -> bool:
    """A correction worth remembering: short (a name or term, not a rewritten sentence)."""
    if not heard or not correct or heard == correct:
        return False
    if len(heard) > 64 or len(correct) > 64:
        return False
    if len(heard.split()) > 4 or len(correct.split()) > 4:
        return False
    return any(ch.isalnum() for ch in correct)


# --------------------------------------------------------------- pipeline --
@dataclass
class CleanupOptions:
    remove_fillers: bool = True
    profanity_filter: bool = False
    vocabulary: list[VocabEntry] = field(default_factory=list)


def clean_transcript(raw: str, opts: CleanupOptions) -> tuple[str, list[uuid.UUID]]:
    out = strip_annotations(raw)
    out = trim_stuck_loops(out)
    if opts.remove_fillers:
        out = remove_fillers(out)
    if opts.profanity_filter:
        out = mask_profanity(out)
    return apply_vocabulary(out, opts.vocabulary)


def clean_segments(segments: list[dict], opts: CleanupOptions) -> list[dict]:
    out = []
    for s in segments:
        t, _ = clean_transcript(s.get("text", ""), opts)
        if t:
            out.append({**s, "text": t})
    return out


# ------------------------------------------------------------ DB helpers --
async def load_vocabulary(conn: AsyncConnection, venture_id: uuid.UUID, *, personal: bool = True,
                          limit: int = 500) -> list[VocabEntry]:
    """Terms the current DB principal can see: shared ones, plus its own personal ones."""
    rows = (await conn.execute(text(
        "SELECT id, term, sounds_like, case_sensitive FROM vocabulary_terms WHERE venture_id = :v"
        + ("" if personal else " AND user_id IS NULL")
        + " ORDER BY (user_id IS NULL), uses DESC, updated_at DESC LIMIT :n"),
        {"v": venture_id, "n": limit})).all()
    return [VocabEntry(r.id, r.term, tuple(r.sounds_like or ()), r.case_sensitive) for r in rows]


@dataclass
class Hints:
    """Spelling hints for the speech model. `public` may go to any provider; `people` (names of
    persons from the knowledge graph) only to local/BYOK models unless the venture opted in."""
    public: list[str] = field(default_factory=list)
    people: list[str] = field(default_factory=list)

    def for_policy(self, local_ok: bool, share_people: bool, limit: int = 50) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for t in self.public + (self.people if (local_ok or share_people) else []):
            k = t.lower()
            if k not in seen and 1 <= len(t) <= 64:
                seen.add(k)
                out.append(t)
            if len(out) >= limit:
                break
        return out


HINT_ENTITY_TYPES = ("company", "project", "product", "sku", "vendor", "place", "property")


async def load_hints(conn: AsyncConnection, venture_id: uuid.UUID, vocab: list[VocabEntry]) -> tuple[Hints, bool]:
    """Hints from the vocabulary and from unrestricted knowledge-graph entities (most connected first).
    Role-restricted entities (e.g. loan applicants) are never used as hints."""
    share = bool((await conn.execute(text(
        "SELECT coalesce((SELECT speech_people_hints FROM venture_settings WHERE venture_id = :v), false)"),
        {"v": venture_id})).scalar())
    rows = (await conn.execute(text(
        "SELECT e.name, e.type FROM entities e WHERE e.venture_id = :v AND e.access_roles IS NULL"
        " AND e.type = ANY (:types)"
        " ORDER BY (SELECT count(*) FROM edges x WHERE x.src_id = e.id OR x.dst_id = e.id) DESC,"
        " e.created_at DESC LIMIT 80"),
        {"v": venture_id, "types": list(HINT_ENTITY_TYPES) + ["person"]})).all()
    hints = Hints(public=[v.term for v in vocab])
    for r in rows:
        (hints.people if r.type == "person" else hints.public).append(r.name)
    return hints, share


def whisper_prompt(terms: list[str], max_chars: int = 600) -> str | None:
    """Whisper conditions on a short 'previous text'; a glossary line biases spelling."""
    if not terms:
        return None
    out, total = [], 0
    for t in terms:
        if total + len(t) + 2 > max_chars:
            break
        out.append(t)
        total += len(t) + 2
    return "Glossary: " + ", ".join(out) + "."


def word_count(text_: str) -> int:
    return len(text_.split())
