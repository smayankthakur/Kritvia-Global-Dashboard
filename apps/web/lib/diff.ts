/** Client-side preview of what a human changed in an agent's draft (mirrors the API's diff). */

export type Payload = Record<string, unknown>;

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

export interface PayloadFieldDiff {
  field: string;
  before: unknown;
  after: unknown;
  lines: DiffLine[] | null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Payload)[k], (b as Payload)[k]));
}

/** Line diff via longest common subsequence (payload bodies are small). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

/** Fields of `before` whose value differs in `after`. Keys absent from `before` are ignored,
 * exactly like the API, which rejects unknown fields. */
export function diffPayload(before: Payload, after: Payload | null | undefined): PayloadFieldDiff[] {
  if (!after) return [];
  const out: PayloadFieldDiff[] = [];
  for (const field of Object.keys(before)) {
    const b = before[field];
    const a = field in after ? after[field] : b;
    if (deepEqual(a, b)) continue;
    out.push({
      field,
      before: b,
      after: a,
      lines: typeof a === "string" && typeof b === "string" ? diffLines(b, a) : null,
    });
  }
  return out;
}

/** Parse a unified diff (as returned by the API's `FieldDiff.unified`) into display lines. */
export function parseUnified(unified: string): DiffLine[] {
  return unified
    .split("\n")
    .filter((l) => !l.startsWith("---") && !l.startsWith("+++") && !l.startsWith("@@"))
    .map((l) => {
      if (l.startsWith("+")) return { type: "add" as const, text: l.slice(1) };
      if (l.startsWith("-")) return { type: "del" as const, text: l.slice(1) };
      return { type: "same" as const, text: l.startsWith(" ") ? l.slice(1) : l };
    });
}

/**
 * Build the `edited_payload` for "approve with edits": the original payload with the
 * edited values applied — same keys only, original types preserved.
 */
export function buildEditedPayload(original: Payload, edits: Payload): Payload {
  const out: Payload = { ...original };
  for (const [k, v] of Object.entries(edits)) {
    if (!(k in original)) continue;
    const o = original[k];
    if (Array.isArray(o) && typeof v === "string") {
      out[k] = v
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (typeof o === "number" && typeof v === "string") {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : o;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}
