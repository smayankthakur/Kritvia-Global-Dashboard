// Auto-learn: when the user corrects a word in text Kritvia just dictated, offer to remember it.
// The single-region diff is ported from AIT-Scribe's AutoLearnDiffing (MIT, (c) AI Thinkers LLC);
// the server repeats the same check before saving (apps/api/kritvia_api/services/speech.py).

const PUNCT = /^[\s.,!?;:"'`()[\]{}—–-]+|[\s.,!?;:"'`()[\]{}—–-]+$/g;

export function stripPunct(w: string): string {
  return w.replace(PUNCT, "");
}

function same(a: string, b: string): boolean {
  return stripPunct(a).toLowerCase() === stripPunct(b).toLowerCase();
}

export interface Correction {
  heard: string;
  correct: string;
}

/** The one contiguous word span the user changed, or null (identical, pure insertion/deletion). */
export function singleDiffRegion(oldText: string, newText: string): Correction | null {
  const a = oldText.split(/\s+/).filter(Boolean);
  const b = newText.split(/\s+/).filter(Boolean);
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && same(a[p]!, b[p]!)) p++;
  let s = 0;
  while (s < n - p && same(a[a.length - 1 - s]!, b[b.length - 1 - s]!)) s++;
  const oldD = a.slice(p, a.length - s);
  const newD = b.slice(p, b.length - s);
  if (!oldD.length || !newD.length) {
    // a pure casing fix of exactly one word still counts ("kritvia" -> "Kritvia")
    if (a.length === b.length) {
      const diffs = a.map((x, i) => [x, b[i]!] as const).filter(([x, y]) => stripPunct(x) !== stripPunct(y));
      if (diffs.length === 1) {
        const [x, y] = diffs[0]!;
        if (stripPunct(x) && stripPunct(y)) return { heard: stripPunct(x), correct: stripPunct(y) };
      }
    }
    return null;
  }
  const heard = oldD.map(stripPunct).join(" ").trim();
  const correct = newD.map(stripPunct).join(" ").trim();
  if (!heard || !correct || heard === correct) return null;
  return { heard, correct };
}

/** A name or term, not a rewritten sentence. */
export function isLearnable(c: Correction | null): c is Correction {
  if (!c) return false;
  const { heard, correct } = c;
  if (!heard || !correct || heard === correct) return false;
  if (heard.length > 64 || correct.length > 64) return false;
  if (heard.split(/\s+/).length > 4 || correct.split(/\s+/).length > 4) return false;
  return /[\p{L}\p{N}]/u.test(correct);
}

/**
 * Where the dictated text sits in the field now. `before` is the field's text in front of the
 * insertion point and `after` the text that followed it at insertion time; if the user only
 * edited inside the dictated span, both are still intact and the middle is the edited dictation.
 */
export function editedInsertion(value: string, before: string, after: string): string | null {
  if (!value.startsWith(before)) return null;
  if (!value.endsWith(after)) return null;
  if (value.length < before.length + after.length) return null;
  return value.slice(before.length, value.length - after.length).trim();
}

/** Detect a learnable correction of the dictated text in the field's current value. */
export function detectCorrection(inserted: string, value: string, before: string, after: string): Correction | null {
  const edited = editedInsertion(value, before, after);
  if (edited === null || edited === inserted.trim()) return null;
  const c = singleDiffRegion(inserted, edited);
  return isLearnable(c) ? c : null;
}
