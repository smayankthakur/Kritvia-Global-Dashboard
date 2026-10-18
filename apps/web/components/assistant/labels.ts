/** Plain-words names for the tools the assistant uses, for its step list. */
const TOOL_LABELS: Record<string, string> = {
  "knowledge.search": "Searched business memory",
  "leads.search": "Looked up leads",
  "crm.update_lead": "Lead update",
  "gmail.send": "Email",
  "whatsapp.send": "WhatsApp message",
  "whatsapp.template": "WhatsApp template",
  "whatsapp.templates": "Looked up WhatsApp templates",
  "telegram.send": "Telegram message",
  "calendar.create_event": "Meeting invite",
  "business.numbers": "Checked the business's numbers",
  "invoices.search": "Looked up invoices",
  "shipments.search": "Looked up shipments",
  "tasks.search": "Looked up tasks",
  "approvals.waiting": "Checked what's waiting for a yes",
  "indiamart.enquiries": "Looked up IndiaMART enquiries",
  "tasks.create": "New task",
  "leads.create": "New lead",
};

export function toolLabel(tool: string): string {
  if (TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  const m = /^app\.([a-z0-9_]+)\.(.+)$/.exec(tool);
  if (m) return `${m[1]}: ${m[2]!.replace(/[_-]+/g, " ")}`;
  return tool;
}

export const EXAMPLES = [
  "Which leads came in this week, and who should I call first?",
  "Is mahine kitna paisa aaya aur kitna baaki hai?",
  "Priya ko proposal ka follow-up email bhejo",
  "Kal 4 baje Ravi ke saath 30 minute ki meeting set karo",
  "Add a task for Neha to send the Acme quote by Friday",
  "What did we quote the last bakery we worked with?",
];

/** A request is still being worked on while its run is queued or running. */
export function inProgress(status: string): boolean {
  return status === "queued" || status === "running";
}
