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
from functools import lru_cache

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
# Parentheses are only treated as a cue when they hold a few plain words (no digits or symbols),
# so dictated asides like "budget (3 lakh)" survive.
_ANNOTATION = re.compile(r"\[[^\]\n]*\]|\*[^*\n]+\*|\((?:[A-Za-z]+[ '-]?){1,5}\)")
# Supplementary private-use code points: never real dictation; used internally as placeholders.
_PRIVATE_USE = re.compile("[\U000F0000-\U0010FFFF]")

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


MAX_FORMS = 25_000  # forms per compiled vocabulary (the API caps terms well below this)


def _trie_pattern(forms: list[str]) -> str:
    """Regex alternation shaped as a trie, so matching cost doesn't grow with the vocabulary size.
    A space in a form matches any run of whitespace."""
    trie: dict = {}
    for f in forms:
        node = trie
        for ch in f:
            node = node.setdefault(ch, {})
        node[""] = True

    def emit(node: dict) -> str:
        end = "" in node
        branches = []
        for ch in sorted((c for c in node if c), key=lambda c: -_depth(node[c])):
            branches.append((r"\s+" if ch == " " else re.escape(ch)) + emit(node[ch]))
        if not branches:
            return ""
        body = branches[0] if len(branches) == 1 else "(?:" + "|".join(branches) + ")"
        return f"(?:{body})?" if end else body

    return emit(trie)


def _depth(node: dict) -> int:
    return 1 + max((_depth(v) for k, v in node.items() if k), default=0)


@dataclass(frozen=True)
class _Compiled:
    ci: re.Pattern[str] | None
    ci_map: dict[str, VocabEntry]
    cs: re.Pattern[str] | None
    cs_map: dict[str, VocabEntry]


def _norm(s: str) -> str:
    return " ".join(s.split())


@lru_cache(maxsize=64)
def _compile(entries: tuple[VocabEntry, ...]) -> _Compiled:
    ci_map: dict[str, VocabEntry] = {}
    cs_map: dict[str, VocabEntry] = {}
    n = 0
    for e in entries:  # earlier entries win a clash (personal terms are loaded first)
        term = _norm(e.term)
        if not term:
            continue
        for f in (term, *(_norm(x) for x in e.sounds_like)):
            if not f or n >= MAX_FORMS:
                continue
            n += 1
            if e.case_sensitive and f == term:
                cs_map.setdefault(f, e)
            else:
                ci_map.setdefault(f.lower(), e)
    # the trie emits longest alternatives first, so "kreet via ai" wins over "kreet via"
    ci = re.compile(f"{_B_BEFORE}{_trie_pattern(list(ci_map))}{_B_AFTER}", re.IGNORECASE) if ci_map else None
    cs = re.compile(f"{_B_BEFORE}{_trie_pattern(list(cs_map))}{_B_AFTER}") if cs_map else None
    return _Compiled(ci, ci_map, cs, cs_map)


def apply_vocabulary(text_: str, entries: list[VocabEntry]) -> tuple[str, list[uuid.UUID]]:
    """Replace each misheard form with its term, and enforce the term's own spelling/casing.
    One pass per case mode; replaced text is never re-matched. Returns (text, ids that changed text)."""
    if not text_ or not entries:
        return text_, []
    c = _compile(tuple(entries))
    out = _PRIVATE_USE.sub("", text_)
    used: list[uuid.UUID] = []
    placeholders: list[str] = []

    def replace(m: re.Match[str], table: dict[str, VocabEntry], fold: bool) -> str:
        key = _norm(m.group(0))
        e = table.get(key.lower() if fold else key)
        if e is None:
            return m.group(0)
        term = _norm(e.term)
        if m.group(0) != term and e.id and e.id not in used:
            used.append(e.id)
        placeholders.append(term)
        return chr(0xF0000 + len(placeholders) - 1)

    if c.cs:
        out = c.cs.sub(lambda m: replace(m, c.cs_map, False), out)
    if c.ci:
        out = c.ci.sub(lambda m: replace(m, c.ci_map, True), out)
    if placeholders:
        out = _PRIVATE_USE.sub(lambda m: placeholders[ord(m.group(0)) - 0xF0000], out)
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
                          limit: int = 1000) -> list[VocabEntry]:
    """Terms the current DB principal can see: its own personal ones first, then shared ones."""
    rows = (await conn.execute(text(
        "SELECT t.id, t.term, t.sounds_like, t.case_sensitive FROM vocabulary_terms t"
        " LEFT JOIN vocabulary_usage u ON u.term_id = t.id WHERE t.venture_id = :v"
        + ("" if personal else " AND t.user_id IS NULL")
        + " ORDER BY (t.user_id IS NULL), coalesce(u.uses, 0) DESC, t.updated_at DESC LIMIT :n"),
        {"v": venture_id, "n": limit})).all()
    return [VocabEntry(r.id, r.term, tuple(r.sounds_like or ()), r.case_sensitive) for r in rows]


HINT_LIMIT = 50


def _dedupe(items: list[str], limit: int = HINT_LIMIT) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for t in items:
        t = _norm(t)
        if t and len(t) <= 64 and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
        if len(out) >= limit:
            break
    return out


@dataclass
class Hints:
    """Spelling hints for the speech model, per data policy.

    local  — models on our own infrastructure: vocabulary + names from the knowledge graph.
    cloud  — hosted models: empty unless the venture opted in (speech_people_hints); then the
             vocabulary and knowledge-graph names that (a) don't name a role-restricted record and
             (b) were never learned only from sensitive documents.
    Role-restricted names (e.g. loan applicants) are never hints for anyone.
    """
    local: list[str] = field(default_factory=list)
    cloud: list[str] = field(default_factory=list)

    def for_policy(self, local_ok: bool) -> list[str]:
        return _dedupe(self.local if local_ok else self.cloud)


HINT_ENTITY_TYPES = ("person", "company", "project", "product", "sku", "vendor", "place", "property")

_ENTITY_HINTS_SQL = (
    "SELECT e.name,"
    # learned from a sensitive document (via an edge or a fact citing one of its chunks)?
    " EXISTS (SELECT 1 FROM edges x JOIN chunks c ON c.id = x.source_chunk_id JOIN documents d ON d.id = c.document_id"
    "         WHERE (x.src_id = e.id OR x.dst_id = e.id) AND d.sensitive)"
    " OR EXISTS (SELECT 1 FROM facts f JOIN chunks c ON c.id = f.source_chunk_id JOIN documents d ON d.id = c.document_id"
    "         WHERE f.subject_id = e.id AND d.sensitive) AS from_sensitive,"
    # ...and seen in at least one ordinary document?
    " EXISTS (SELECT 1 FROM edges x JOIN chunks c ON c.id = x.source_chunk_id JOIN documents d ON d.id = c.document_id"
    "         WHERE (x.src_id = e.id OR x.dst_id = e.id) AND NOT d.sensitive)"
    " OR EXISTS (SELECT 1 FROM facts f JOIN chunks c ON c.id = f.source_chunk_id JOIN documents d ON d.id = c.document_id"
    "         WHERE f.subject_id = e.id AND NOT d.sensitive) AS from_ordinary"
    " FROM entities e WHERE e.venture_id = :v AND e.access_roles IS NULL AND e.type = ANY (:types)"
    " ORDER BY (SELECT count(*) FROM edges x WHERE x.src_id = e.id OR x.dst_id = e.id) DESC, e.created_at DESC"
    " LIMIT 80"
)


async def load_hints(conn: AsyncConnection, venture_id: uuid.UUID, vocab: list[VocabEntry]) -> Hints:
    share = bool((await conn.execute(text(
        "SELECT coalesce((SELECT speech_people_hints FROM venture_settings WHERE venture_id = :v), false)"),
        {"v": venture_id})).scalar())
    terms = [v.term for v in vocab][:200]
    safe_terms: list[str] = list((await conn.execute(
        text("SELECT vocabulary_hint_filter(:v, CAST(:t AS text[]))"), {"v": venture_id, "t": terms})).scalar() or [])
    rows = (await conn.execute(text(_ENTITY_HINTS_SQL), {"v": venture_id, "types": list(HINT_ENTITY_TYPES)})).all()
    names = [r.name for r in rows]
    hints = Hints(local=safe_terms + names)
    if share:
        hints.cloud = safe_terms + [r.name for r in rows if r.from_ordinary and not r.from_sensitive]
    return hints


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
