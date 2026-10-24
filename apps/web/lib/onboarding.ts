import type { VentureKind } from "./access";

/** Business templates: the kind decides which screens a business gets; the template decides
 * which agents start switched on, which agents and roles are offered at setup, and what standing
 * instructions the agents begin with. */
export interface Template {
  id: string;
  kind: VentureKind;
  title: string;
  example: string;
  gets: string;
  /** Agents switched on at setup (others stay available on the Agents page). */
  workflows: string[];
  /** Starting instructions per agent; the owner edits them later. */
  instructions?: Record<string, string>;
}

/** What a salon, clinic or local service needs (test report round 3, A3). */
const LOCAL_SERVICE = ["inbox_assistant", "booking_reminders", "reviews", "assistant", "collections"];

export const TEMPLATES: Template[] = [
  {
    id: "agency",
    kind: "software",
    title: "Agency or services",
    example: "Digital agency, consultancy, IT services",
    gets: "Inbox assistant, lead triage with priced proposals, meeting digests",
    workflows: ["inbox_assistant", "lead_triage", "meeting_digest"],
  },
  {
    id: "loans",
    kind: "finance",
    title: "Loans & real estate",
    example: "Loan DSA, mortgage broker, property dealer",
    gets: "Loan document checks and client follow-ups, inbox assistant, meeting digests",
    workflows: ["inbox_assistant", "loan_verification", "meeting_digest"],
  },
  {
    id: "kitchen",
    kind: "kitchen",
    title: "Restaurant or cloud kitchen",
    example: "Cloud kitchen, restaurant, caterer",
    gets: "Nightly stock and purchase plan, inbox assistant for orders and queries",
    workflows: ["inbox_assistant", "kitchen_daily", "meeting_digest"],
    instructions: { inbox_assistant: "Customers ask about orders, menu and delivery. For order problems, ask for the order number and apologise once." },
  },
  {
    id: "trade",
    kind: "trade",
    title: "Exporter, importer or C&F agent",
    example: "Exporter, importer, customs broker (CHA), freight forwarder",
    gets: "Shipment files with document checklists, export invoices and packing lists, a morning list of cut-offs, LC and payment dates, updates to buyers and clients",
    workflows: ["inbox_assistant", "trade_watch", "lead_triage", "meeting_digest"],
    instructions: { inbox_assistant: "Messages are from buyers, suppliers, clients, shipping lines and forwarders. Quote prices only from the rate card, with the Incoterm. For a shipment query, ask for the file number, BL or container number. Never promise a sailing or clearance date the team hasn't confirmed." },
  },
  {
    id: "retail",
    kind: "general",
    title: "Shop or e-commerce",
    example: "Retail store, D2C brand, wholesaler",
    gets: "Inbox assistant for product, order and payment queries; reviews; payment reminders; lead triage for bulk enquiries",
    workflows: ["inbox_assistant", "lead_triage", "reviews", "collections", "assistant"],
    instructions: { inbox_assistant: "Answer product, stock, delivery and return questions from what you know. For an order query, ask for the order number. Never promise a refund; say the team will confirm." },
  },
  {
    id: "clinic",
    kind: "general",
    title: "Clinic, salon or local services",
    example: "Clinic, salon, repair service, tutor",
    gets: "Inbox assistant for appointments and questions, booking reminders, Google reviews, payment reminders and your assistant",
    workflows: LOCAL_SERVICE,
    instructions: { inbox_assistant: "Most messages are appointment requests. Offer the next two available slots from the calendar when you know them, otherwise ask for a preferred day and time. Never give medical or legal advice." },
  },
  {
    id: "coaching",
    kind: "general",
    title: "Coaching or education",
    example: "Coaching institute, online course, training company",
    gets: "Inbox assistant, class and demo reminders, reviews, fee reminders, and lead triage for course enquiries",
    workflows: [...LOCAL_SERVICE, "lead_triage"],
    instructions: { lead_triage: "Enquiries are usually from students or parents. Mention batch timings and the free demo class." },
  },
  {
    id: "freelancer",
    kind: "general",
    title: "Freelancer or consultant",
    example: "Designer, developer, CA, architect",
    gets: "Lead triage with proposals from your rate card, inbox assistant, payment reminders, meeting digests",
    workflows: ["inbox_assistant", "lead_triage", "collections", "meeting_digest"],
  },
  {
    id: "other",
    kind: "general",
    title: "Something else",
    example: "Any business with an inbox",
    gets: "Inbox assistant, memory, voice notes, approvals; switch on more agents later",
    workflows: ["inbox_assistant", "assistant", "meeting_digest"],
  },
];

/** Agents that only make sense for one kind of business: a salon is never offered the kitchen, loan or shipment agents. */
const KIND_ONLY: Record<string, VentureKind> = {
  kitchen_daily: "kitchen",
  loan_verification: "finance",
  trade_watch: "trade",
  trade_update: "trade",
};

/** The agents offered at setup for this template: the catalogue's agents for its kind, minus another kind's
 * own agents, with the ones the template switches on first (in the template's order). */
export function offeredAgents<W extends { name: string; venture_kinds: string[] }>(template: Template, catalogue: W[]): { main: W[]; more: W[] } {
  const fits = catalogue.filter((w) => w.venture_kinds.includes(template.kind) && (KIND_ONLY[w.name] ?? template.kind) === template.kind);
  const main = template.workflows.map((n) => fits.find((w) => w.name === n)).filter((w): w is W => Boolean(w));
  return { main, more: fits.filter((w) => !template.workflows.includes(w.name)) };
}

export const ROLE_OPTIONS: { role: string; label: string; hint: string; kind?: VentureKind }[] = [
  { role: "approver", label: "Approver", hint: "Approve agent drafts (emails, invites)" },
  { role: "loan_officer", label: "Loan officer", hint: "See loan files; approve client follow-ups", kind: "finance" },
  { role: "kitchen_manager", label: "Kitchen manager", hint: "Approve purchase orders", kind: "kitchen" },
  { role: "operator", label: "Operator", hint: "Run workflows and edit data" },
];

/** The roles offered for a business of this kind (no Loan officer for a salon). */
export function rolesFor(kind: VentureKind): typeof ROLE_OPTIONS {
  return ROLE_OPTIONS.filter((r) => !r.kind || r.kind === kind);
}

export const DEFAULT_ROLES: Record<VentureKind, string[]> = {
  software: ["approver"],
  finance: ["loan_officer"],
  kitchen: ["kitchen_manager"],
  trade: ["approver"],
  general: ["approver"],
};

/** The template a business was set up with: its saved industry, else the first one of its kind. */
export function templateFor(industry: string | null | undefined, kind: string | null | undefined): Template {
  return (
    TEMPLATES.find((t) => t.id === industry) ??
    TEMPLATES.find((t) => t.kind === kind) ??
    (TEMPLATES.find((t) => t.id === "other") as Template)
  );
}

/** Businesses created during setup, in the order they were made, so a reload doesn't reorder them (A22).
 * The access list has no creation time, so the order is remembered in this browser. */
const ORDER_KEY = "kv-onboarding-order";

export function rememberCreated(ids: string[]): void {
  try {
    window.localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* private mode: falls back to name order */
  }
}

export function createdOrder(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Oldest first: the remembered creation order, then by name (stable whatever order the API sends). */
export function byCreation<T extends { venture_id: string; venture_name: string }>(ventures: T[], order: string[]): T[] {
  const pos = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...ventures].sort((a, b) => pos(a.venture_id) - pos(b.venture_id) || a.venture_name.localeCompare(b.venture_name) || a.venture_id.localeCompare(b.venture_id));
}
