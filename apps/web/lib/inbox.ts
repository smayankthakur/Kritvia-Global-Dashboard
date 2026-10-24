/** Choosing what to show next and what may be approved in bulk in the approval inbox (round 3, A6). */

interface Item {
  id: string;
  action: string;
  venture_id: string;
  sensitive: boolean;
  summary: string;
  can_decide: boolean;
  redacted?: boolean;
  status?: string;
}

/** The draft to open after deciding `current`: the next one down the list, else the one above, else none. */
export function nextPendingId(items: readonly { id: string }[], current: string, skip: ReadonlySet<string> = new Set()): string | null {
  const open = (x: { id: string }) => x.id !== current && !skip.has(x.id);
  const i = items.findIndex((x) => x.id === current);
  if (i < 0) return items.find(open)?.id ?? null;
  for (let j = i + 1; j < items.length; j++) if (open(items[j]!)) return items[j]!.id;
  for (let j = i - 1; j >= 0; j--) if (open(items[j]!)) return items[j]!.id;
  return null;
}

/** Summaries that say the draft quotes money the business's records don't have. */
const UNKNOWN_MONEY = /(not in your records|isn't in your records|isn't in your offer|not in your rate card)/i;

/**
 * Why a draft must be looked at on its own instead of being approved with others, or null when it may go
 * in "Approve selected". `noMailbox` holds the businesses that have no Gmail to send email from.
 */
export function bulkSkipReason(a: Item, noMailbox: ReadonlySet<string> = new Set()): string | null {
  if (!a.can_decide || a.redacted) return "You can't decide this one";
  if (a.sensitive) return "Sensitive: open it to decide";
  if (UNKNOWN_MONEY.test(a.summary ?? "")) return "Mentions an amount that isn't in your records";
  if (a.action === "gmail.send" && noMailbox.has(a.venture_id)) return "Gmail isn't connected";
  return null;
}

/** Split a selection into what "Approve selected" approves and what it leaves for one-by-one review. */
export function splitBulk<T extends Item>(items: readonly T[], selected: ReadonlySet<string>, noMailbox: ReadonlySet<string> = new Set()) {
  const approve: T[] = [];
  const skipped: { item: T; reason: string }[] = [];
  for (const a of items) {
    if (!selected.has(a.id)) continue;
    const why = bulkSkipReason(a, noMailbox);
    if (why) skipped.push({ item: a, reason: why });
    else approve.push(a);
  }
  return { approve, skipped };
}

/** Whole hours until a draft expires, when that is under `within` hours (default 12); otherwise null. */
export function expiresSoonHours(expiresAt: string | null | undefined, now: number = Date.now(), within = 12): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  const ms = t - now;
  if (ms <= 0 || ms >= within * 3_600_000) return null;
  return Math.max(0, Math.floor(ms / 3_600_000));
}
