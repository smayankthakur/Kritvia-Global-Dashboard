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
  "web.browse": "Looked it up on the web",
  "team.handoff": "Handed to a team lead",
  "voice.call": "Phone call",
  "kritvia.find": "Found how to do it in Kritvia",
  "kritvia.read": "Looked it up in Kritvia",
  "kritvia.do": "Change in Kritvia",
  "routines.create": "New routine",
  "events.recent": "Checked what happened",
  "ads.summary": "Checked the ads",
  "bills.search": "Looked up bills",
  "bank.unmatched": "Checked the bank statement",
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
  "Pune Bakes ko ₹11,800 ka invoice banao, payment reminders on karo, aur har Monday mujhe cash ka hisaab bhejo",
  "Open a Sales Executive role, mark Ramesh present today, and post our Diwali offer on Google",
];

/** A request is still being worked on while its run is queued or running. */
export function inProgress(status: string): boolean {
  return status === "queued" || status === "running";
}
