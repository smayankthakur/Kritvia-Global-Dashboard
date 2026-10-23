/** Money and wording helpers for invoices. Amounts travel as whole paise; people type rupees. */
import { formatINR } from "@/lib/format";

/** What people type around an amount in India: ₹ / Rs / INR in front, "/-", "only" or "rupees" after,
 * commas in lakh or thousand groups, spaces. Returns the bare number text (sign kept). */
function bare(input: string): string {
  return input
    .trim()
    .replace(/^(₹|rs\.?|inr)\s*/i, "")
    .replace(/\s*(\/-|-\/|rupees?|rs\.?|only)\s*$/i, "")
    .replace(/\s*(\/-|-\/)\s*$/i, "")
    .replace(/^(₹|rs\.?|inr)\s*/i, "")
    .replace(/[,\s]/g, "");
}

function parse(input: string, { zero = false, negative = false }: { zero?: boolean; negative?: boolean } = {}): number | null {
  let s = bare(input);
  let sign = 1;
  if (negative && /^[-−]/.test(s)) {
    sign = -1;
    s = s.slice(1).replace(/^(₹|rs\.?|inr)/i, "");
  }
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [r, f = ""] = s.split(".");
  const paise = Number(r) * 100 + Number((f + "00").slice(0, 2));
  if (!Number.isSafeInteger(paise)) return null;
  if (paise === 0) return zero ? 0 : null;
  return sign * paise;
}

/** "11,800.50" / "₹11800" / "₹400/-" / "Rs. 500 only" → paise (more than zero), or null when it isn't one. */
export function toPaise(input: string): number | null {
  return parse(input);
}

/** Like toPaise, but 0 is a fine answer (fixed costs, GST in a bill, a discount, staff pay). */
export function toPaiseOrZero(input: string): number | null {
  return parse(input, { zero: true });
}

/** A bank balance: may be 0 or below zero (an overdraft), e.g. "-50,000". */
export function toPaiseSigned(input: string): number | null {
  return parse(input, { zero: true, negative: true });
}

/** Why what was typed isn't an amount, in words the owner can act on; null when it is one.
 * Empty input is the caller's business (optional fields are usually fine empty). */
export function amountProblem(input: string, opts: { zero?: boolean; negative?: boolean } = {}): string | null {
  if (!input.trim()) return null;
  if (parse(input, opts) !== null) return null;
  const s = input.trim().toLowerCase();
  if (s.includes("%")) return "Write the amount in rupees, not a percentage (e.g. 1800 for 18% of 10,000).";
  if (/\d\s*(k|l|lakh|lac|cr|crore)\b/.test(s)) return "Write the full amount in figures, e.g. 15000 or 1,50,000.";
  if (/^[-−]/.test(s) && !opts.negative) return "The amount can't be below zero.";
  if (/^[-−]?[\d,.\s₹]*0[\d,.]*$/.test(s) && parse(input, { zero: true, negative: true }) === 0 && !opts.zero) return "The amount must be more than ₹0.";
  if (/\.\d{3,}/.test(s)) return "Use at most two digits after the decimal point.";
  return "Write the amount in rupees, e.g. 400 or 11,800.50.";
}

/** 1180050 → "11800.50", 1180000 → "11800" (for an input box). */
export function paiseToInput(paise: number | null | undefined): string {
  if (!paise) return "";
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return p ? `${r}.${String(p).padStart(2, "0")}` : String(r);
}

/** 1180000 → "₹11,800" (paise shown only when there are some). */
export function rupees(paise: number): string {
  return formatINR(paise / 100, { whole: paise % 100 === 0 });
}

export interface InvoiceLike {
  status: "draft" | "open" | "paid" | "cancelled";
  due_on: string;
  overdue_days: number;
  reminders_paused: boolean;
  reminders_sent: number;
  customer_email?: string | null;
  customer_phone?: string | null;
}

/** "Due in 3 days" / "Due today" / "12 days overdue" / "Paid" / "Cancelled" / "Draft: check and issue". */
export function dueLabel(inv: InvoiceLike, today: Date = new Date()): { text: string; tone: "danger" | "warning" | "neutral" | "success" | "info" } {
  if (inv.status === "draft") return { text: "Draft: check and issue", tone: "info" };
  if (inv.status === "paid") return { text: "Paid", tone: "success" };
  if (inv.status === "cancelled") return { text: "Cancelled", tone: "neutral" };
  if (inv.overdue_days > 0) return { text: `${inv.overdue_days} day${inv.overdue_days === 1 ? "" : "s"} overdue`, tone: "danger" };
  const ist = new Date(today.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(inv.due_on) - Date.parse(ist)) / 86_400_000);
  if (days <= 0) return { text: "Due today", tone: "warning" };
  return { text: `Due in ${days} day${days === 1 ? "" : "s"}`, tone: days <= 3 ? "warning" : "neutral" };
}

/** What the reminders are doing for this invoice, in plain words; null when nothing to say. */
export function reminderLabel(inv: InvoiceLike): string | null {
  if (inv.status !== "open") return null;
  if (inv.reminders_paused) return "Reminders paused";
  if (inv.customer_email === null && inv.customer_phone === null) return "No email or phone for reminders";
  if (inv.reminders_sent) return `${inv.reminders_sent} reminder${inv.reminders_sent === 1 ? "" : "s"} sent`;
  return null;
}
