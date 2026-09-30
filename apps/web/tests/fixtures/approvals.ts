import type { Schemas } from "@/lib/api";

type Approval = Schemas["ApprovalOut"];

const base: Omit<Approval, "action" | "payload" | "title" | "summary" | "agent" | "step"> = {
  id: "7a1d5b44-0000-4000-8000-000000000001",
  venture_id: "11111111-0000-4000-8000-000000000001",
  venture_name: "Sitelytc",
  run_id: "22222222-0000-4000-8000-000000000001",
  workflow: "lead_triage",
  capability: "email.send",
  status: "pending",
  sensitive: false,
  required_roles: ["approver", "venture_admin"],
  can_decide: true,
  final_payload: null,
  diff: [],
  comment: null,
  decided_by_email: null,
  decided_at: null,
  executed_at: null,
  execution_result: null,
  expires_at: "2026-10-03T06:30:00Z",
  created_at: "2026-09-30T06:30:00Z",
};

export const emailApproval: Approval = {
  ...base,
  step: "draft",
  agent: "proposal",
  action: "gmail.send",
  title: "Send proposal to Rao Foods",
  summary: "Score 78 (hot). Estimate ₹3,54,000.00 incl. GST. Draws on: Pricing notes.",
  payload: {
    to: "asha@raofoods.example",
    subject: "Proposal: Next.js website + WhatsApp ordering",
    body: "Hi Asha,\n\nThanks for reaching out.\n\n| Item | Qty | Amount |\n|---|---|---|\n| Next.js page | 8 | ₹1,00,000 |\n| AI workflow | 1 | ₹2,00,000 |\n\nRegards,\nTeam Sitelytc",
    thread_id: null,
  },
};

export const inviteApproval: Approval = {
  ...base,
  id: "7a1d5b44-0000-4000-8000-000000000002",
  step: "invite",
  agent: "scheduler",
  action: "calendar.create_event",
  capability: "calendar.write",
  title: "Invite Rao Foods to a discovery call",
  summary: "Proposed 2026-10-02 11:00 IST, 30 min. Edit the time if needed.",
  payload: {
    summary: "Discovery call — Asha × Sitelytc",
    start: "2026-10-02T11:00:00+05:30",
    end: "2026-10-02T11:30:00+05:30",
    attendees: ["asha@raofoods.example"],
    description: "Walk through the proposal and next steps.",
  },
};
