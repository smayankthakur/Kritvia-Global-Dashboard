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
export function senderLabel(sentBy: "customer" | "kritvia" | "person", customer: string): string {
  if (sentBy === "customer") return customer;
  return sentBy === "kritvia" ? "Kritvia (approved)" : "Your team";
}

/** Why a person can't send right now, or null when they can. */
export function cannotSend(chat: { opted_out: boolean; window_open: boolean }, canWrite: boolean): string | null {
  if (!canWrite) return "Your role can read chats but not answer them.";
  if (chat.opted_out) return "This customer wrote STOP. Kritvia won't message them again.";
  if (!chat.window_open)
    return "The customer last wrote more than 24 hours ago. WhatsApp only allows a reply after they write again.";
  return null;
}
