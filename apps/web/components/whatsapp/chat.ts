/** Helpers for the WhatsApp page. */

/** "919811122233" → "+91 98111 22233" (Indian numbers), otherwise "+<digits>". */
export function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return `+${d}`;
}

/** What to call a chat in the list: the customer's WhatsApp name, else their number. */
export function chatName(c: { name?: string | null; phone: string }): string {
  return c.name?.trim() || formatPhone(c.phone);
}

/** Who wrote a message, as shown above the bubble. */
export function senderLabel(sentBy: "customer" | "kritvia" | "person" | "phone", customer: string): string {
  if (sentBy === "customer") return customer;
  if (sentBy === "phone") return "You, from the phone";
  return sentBy === "kritvia" ? "Kritvia (approved)" : "Your team";
}

/** Why a person can't type a reply right now, or null when they can. */
export function cannotSend(chat: { opted_out: boolean; window_open: boolean }, canWrite: boolean): string | null {
  if (!canWrite) return "Your role can read chats but not answer them.";
  if (chat.opted_out) return "This customer wrote STOP. Kritvia won't message them again.";
  if (!chat.window_open)
    return "WhatsApp allows typed messages only within 24 hours of the customer's last message. Until they write again, send an approved template.";
  return null;
}

/** True when the only way to write to this customer now is an approved template. */
export function needsTemplate(chat: { opted_out: boolean; window_open: boolean }, canWrite: boolean): boolean {
  return canWrite && !chat.opted_out && !chat.window_open;
}

/** "+91 98111 22233", "98111 22233" (assumed India) or "919811122233" → digits with country code, or null. */
export function normalisePhone(input: string): string | null {
  const raw = input.trim();
  let d = raw.replace(/\D/g, "");
  if (!raw.startsWith("+") && d.length === 10 && /^[6-9]/.test(d)) d = `91${d}`;
  if (d.startsWith("0")) return null;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}
