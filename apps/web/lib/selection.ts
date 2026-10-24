/** Checkbox selections in lists (Leads, Inbox). */

/** A copy of the set with `id` added or removed. */
export function toggled<T>(set: ReadonlySet<T>, id: T, on: boolean): Set<T> {
  const n = new Set(set);
  if (on) n.add(id);
  else n.delete(id);
  return n;
}

/** Only the selected ids that are still in the list (rows can vanish on refresh or delete). */
export function stillListed(selected: ReadonlySet<string>, rows: readonly { id: string }[]): string[] {
  const here = new Set(rows.map((r) => r.id));
  return [...selected].filter((id) => here.has(id));
}

/** Split ids into requests the API accepts (bulk delete takes up to 500 at once). */
export function chunk<T>(ids: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
