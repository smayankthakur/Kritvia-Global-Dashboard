/**
 * Plain words for the technical names the API uses, so owners never read "gmail.send", "venture_admin",
 * "logged" or "LLMOutputError" (test report round 3, A17). One place, used by the approval cards, the inbox
 * list, the run pages and the members list.
 */

const ACTIONS: Record<string, string> = {
  "gmail.send": "Email",
  "whatsapp.send": "WhatsApp",
  "whatsapp.template": "WhatsApp",
  "telegram.send": "Telegram",
  "google.review_reply": "Google review reply",
  "social.post": "Social post",
  "calendar.create_event": "Meeting invite",
  "voice.call": "Phone call",
  "browser.submit": "Website form",
  "kritvia.do": "Change in Kritvia",
};

/** "gmail.send" → "Email". Unknown actions read as words ("foo.bar_baz" → "Foo bar baz"). */
export function actionLabel(action: string | null | undefined): string {
  if (!action) return "";
  if (ACTIONS[action]) return ACTIONS[action];
  const words = action.replace(/[._-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : action;
}

const ROLES: Record<string, string> = {
  org_owner: "Org owner",
  venture_admin: "Owner/admin",
  approver: "Approver",
  operator: "Operator",
  viewer: "Viewer",
  kitchen_manager: "Kitchen manager",
  loan_officer: "Loan officer",
};

/** "venture_admin" → "Owner/admin". */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  if (ROLES[role]) return ROLES[role];
  const words = role.replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : role;
}

/** ["approver", "venture_admin"] → "Approver or Owner/admin". */
export function rolesLabel(roles: readonly string[] | null | undefined): string {
  return (roles ?? []).map(roleLabel).filter(Boolean).join(" or ");
}

const SENT: Record<string, string> = {
  logged: "Not sent (no mailbox connected)",
  sent: "Sent",
  queued: "Waiting to send",
  failed: "Couldn't be sent",
  skipped: "Not sent",
};

/** A send result's status ("logged" means it was only written down, never sent). */
export function sentLabel(status: unknown): string {
  if (typeof status === "boolean") return status ? "Sent" : "Not sent";
  if (typeof status !== "string") return "";
  return SENT[status] ?? status.replace(/_/g, " ");
}

const OUTCOMES: Record<string, string> = {
  saved_unscored: "Saved without a score",
  replied: "Replied",
  spam: "Marked as spam",
  not_done: "Not done",
};

/** How a run ended, in words ("saved_unscored" → "Saved without a score"). */
export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "";
  if (OUTCOMES[outcome]) return OUTCOMES[outcome];
  const words = outcome.replace(/_/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : outcome;
}

export const AI_FAILED = "The AI couldn't finish this one. Try again.";
export const TECH_FAILED = "Something went wrong on our side. Try again.";

/** Error classes that mean the AI model gave up or gave unusable output. */
const AI_CLASS = /^(LLM\w*|AllProvidersFailed|Provider\w*|Model\w*|AgentBudgetExceeded|StructuredOutput\w*|OutputParser\w*)$/;
/** A Python/JS exception class name: "LLMOutputError", "TimeoutError", "AllProvidersFailed". */
const CLASS_AT_START = /^([A-Z][A-Za-z0-9]*(?:Error|Exception|Failed|Exceeded|Timeout))\b/;
const CLASS_INSIDE = /\b([A-Z][A-Za-z0-9]*(?:Error|Exception|Failed|Exceeded|Timeout))\b(?::[^)\n]*)?/g;

/**
 * An error as an owner should read it. A message that starts with an exception class becomes one plain
 * sentence; a class named inside a longer sentence ("4 runs failed (last: LLMOutputError: …)") is replaced
 * in place. Plain messages pass through unchanged.
 */
export function plainError(text: string | null | undefined): string {
  if (!text) return "";
  const t = text.trim();
  const m = CLASS_AT_START.exec(t);
  if (m) return AI_CLASS.test(m[1]!) ? AI_FAILED : TECH_FAILED;
  return t.replace(CLASS_INSIDE, (_all, cls: string) => (AI_CLASS.test(cls) ? "the AI couldn't finish it" : "a technical problem"));
}

/** True when the text names an exception class, i.e. there is something technical worth hiding. */
export function isTechnicalError(text: string | null | undefined): boolean {
  if (!text) return false;
  CLASS_INSIDE.lastIndex = 0;
  return CLASS_INSIDE.test(text.trim());
}
