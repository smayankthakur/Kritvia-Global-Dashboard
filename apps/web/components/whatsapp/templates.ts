/** Helpers for WhatsApp message templates: the blanks ({{1}}, {{2}}, …), the preview, and Meta's
 * wording rules checked before a template is sent for review. The server checks them again. */

const BLANK = /\{\{\s*(\d+)\s*\}\}/g;

/** Number of blanks in a template body. */
export function blanks(body: string): number {
  let max = 0;
  for (const m of body.matchAll(BLANK)) max = Math.max(max, Number(m[1]));
  return max;
}

/** The message as the customer will see it; blanks not filled in yet stay as [1], [2]. */
export function fillTemplate(body: string, params: string[]): string {
  return body.replace(BLANK, (_, n: string) => params[Number(n) - 1]?.trim() || `[${n}]`);
}

/** Why Meta would reject this body, in plain words, or null when it looks fine. */
export function templateProblem(body: string): string | null {
  const b = body.trim();
  if (!b) return "Write the message.";
  if (b.length > 1024) return "Keep the message under 1024 characters.";
  const nums = [...b.matchAll(BLANK)].map((m) => Number(m[1]));
  const distinct = [...new Set(nums)].sort((x, y) => x - y);
  if (distinct.some((n, i) => n !== i + 1)) return "Number the blanks in order: {{1}}, {{2}}, {{3}}.";
  if (/^\{\{\s*\d+\s*\}\}/.test(b) || /\{\{\s*\d+\s*\}\}[.!?\s]*$/.test(b))
    return "A message can't start or end with a blank. Add a few words around it.";
  const rest = b.replace(BLANK, "");
  if (/\{\{[^}]*\}\}/.test(rest)) return "Blanks are written {{1}}, {{2}} … with numbers only.";
  if (nums.length && (rest.match(/\w+/g) ?? []).length < 2 * nums.length + 1)
    return "Add more words around the blanks. WhatsApp rejects messages that are mostly blanks.";
  return null;
}

/** Why a filled-in blank would be refused, or null. */
export function paramProblem(value: string): string | null {
  if (!value.trim()) return "Fill in every blank.";
  if (/[\n\t]| {4,}/.test(value)) return "A blank can't contain new lines or long runs of spaces.";
  if (value.length > 300) return "Keep each blank under 300 characters.";
  return null;
}

export type Tone = "success" | "warning" | "danger" | "neutral" | "info";

/** Meta's review status in plain words. */
export function templateStatus(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "APPROVED":
      return { label: "Approved", tone: "success" };
    case "PENDING":
    case "IN_APPEAL":
      return { label: "In review", tone: "info" };
    case "REJECTED":
      return { label: "Rejected", tone: "danger" };
    case "PAUSED":
      return { label: "Paused", tone: "warning" };
    case "DISABLED":
      return { label: "Switched off", tone: "danger" };
    default:
      return { label: status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " "), tone: "neutral" };
  }
}

export const CATEGORIES = [
  {
    id: "UTILITY",
    label: "Update",
    hint: "About something the customer asked for or bought: an order, a booking, a payment, a delivery.",
  },
  {
    id: "MARKETING",
    label: "Offer or news",
    hint: "Offers, new products, festival greetings, “come back” messages. Costs more per message.",
  },
] as const;

export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "en_US", label: "English (US)" },
  { id: "en_GB", label: "English (UK)" },
  { id: "hi", label: "Hindi" },
] as const;

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.id === code)?.label ?? code;
}

/** "order_ready" → "Order ready" */
export function templateTitle(name: string): string {
  const s = name.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Templates the team can send from Kritvia right now. */
export function sendableTemplates<T extends { status: string; sendable: boolean }>(all: T[]): T[] {
  return all.filter((t) => t.status === "APPROVED" && t.sendable);
}
