export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** lower_snake_case codes used by rate cards, loan types, purposes. */
export function toCode(s: string, max = 40): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

/** A rate-card code made from the item's name, unique among `taken`: "Hair cut" → "hair_cut", then "hair_cut_2". */
export function codeFromName(name: string, taken: Iterable<string>, max = 40): string {
  const used = new Set(taken);
  let base = toCode(name, max);
  if (base.length < 2) base = base ? `${base}_item` : "";
  if (!base || !used.has(base)) return base;
  for (let n = 2; ; n++) {
    const tail = `_${n}`;
    const c = `${base.slice(0, max - tail.length)}${tail}`;
    if (!used.has(c)) return c;
  }
}
