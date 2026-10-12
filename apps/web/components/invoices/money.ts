/** Money and wording helpers for invoices. Amounts travel as whole paise; people type rupees. */
import { formatINR } from "@/lib/format";

/** "11,800.50" / "₹11800" / "1180.5" → paise, or null when it isn't an amount. */
export function toPaise(input: string): number | null {
  const s = input.trim().replace(/^(₹|rs\.?|inr)\s*/i, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [r, f = ""] = s.split(".");
  const paise = Number(r) * 100 + Number((f + "00").slice(0, 2));
  return paise > 0 && Number.isSafeInteger(paise) ? paise : null;
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
  status: "open" | "paid" | "cancelled";
  due_on: string;
  overdue_days: number;
  reminders_paused: boolean;
  reminders_sent: number;
  customer_email?: string | null;
  customer_phone?: string | null;
}

/** "Due in 3 days" / "Due today" / "12 days overdue" / "Paid" / "Cancelled". */
export function dueLabel(inv: InvoiceLike, today: Date = new Date()): { text: string; tone: "danger" | "warning" | "neutral" | "success" } {
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
