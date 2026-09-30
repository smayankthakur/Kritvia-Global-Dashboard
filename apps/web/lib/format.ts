/** Money, numbers and dates for an Indian business: INR with lakh/crore grouping, times in IST. */

export const IST = "Asia/Kolkata";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** ₹2,95,000.00 — API decimals arrive as strings; both forms are accepted. */
export function formatINR(v: number | string | null | undefined, opts: { whole?: boolean } = {}): string {
  const n = toNumber(v);
  if (n === null) return "—";
  return (opts.whole ? inr0 : inr).format(n);
}

export function formatNumber(v: number | string | null | undefined, maxFractionDigits = 2): string {
  const n = toNumber(v);
  if (n === null) return "—";
  return maxFractionDigits === 2 ? num.format(n) : new Intl.NumberFormat("en-IN", { maximumFractionDigits: maxFractionDigits }).format(n);
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 30 Sep 2026, 21:05 IST */
export function formatDateTime(v: string | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  const p = istParts(d);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute} IST`;
}

/** 30 Sep 2026. Plain dates ("2026-09-30") are calendar dates, not instants. */
export function formatDate(v: string | Date | null | undefined): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-");
    return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  }
  const d = toDate(v);
  if (!d) return "—";
  const p = istParts(d);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}

export function formatTime(v: string | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  const p = istParts(d);
  return `${p.hour}:${p.minute}`;
}

/** "3 min ago", "2 h ago", "4 d ago" (falls back to the date after a month). */
export function formatRelative(v: string | Date | null | undefined, now: Date = new Date()): string {
  const d = toDate(v);
  if (!d) return "—";
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  let out: string;
  if (a < 45) out = "just now";
  else if (a < 3600) out = `${Math.round(a / 60)} min`;
  else if (a < 86400) out = `${Math.round(a / 3600)} h`;
  else if (a < 30 * 86400) out = `${Math.round(a / 86400)} d`;
  else return formatDate(d);
  if (out === "just now") return out;
  return future ? `in ${out}` : `${out} ago`;
}

export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Transcript offsets: 75.4 -> "1:15", 3725 -> "1:02:05" */
export function formatTimestamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function istParts(d: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** ISO instant -> value for <input type="datetime-local"> expressed in IST. */
export function toISTInput(v: string | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return "";
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** <input type="datetime-local"> value (read as IST) -> ISO 8601 with +05:30 offset. */
export function fromISTInput(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v;
  return `${v}:00+05:30`;
}

/** Today's date in IST as YYYY-MM-DD, optionally shifted by whole days. */
export function istDate(offsetDays = 0, now: Date = new Date()): string {
  const d = new Date(now.getTime() + offsetDays * 86400_000);
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[_.-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
