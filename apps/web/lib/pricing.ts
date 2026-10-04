/**
 * The 2026–27 price list, as shown on the public pages. The API (apps/api/kritvia_api/plans.py)
 * is the source of truth for limits; tests/pricing.test.ts keeps the two in step.
 */
export interface PlanCard {
  code: string;
  name: string;
  price_inr: number;
  price_annual_inr: number | null;
  monthly_tokens: number | null;
  tagline: string;
  audience: string;
  highlights: string[];
  featured: boolean;
}

export const PLAN_CARDS: PlanCard[] = [
  {
    code: "free",
    name: "Free",
    price_inr: 0,
    price_annual_inr: null,
    monthly_tokens: 300_000,
    tagline: "For exploring Kritvia.",
    audience: "See what agents can do for your business",
    highlights: ["1 business, 2 people", "Inbox assistant and lead triage", "10 proposals a month", "Agents always ask before acting", "Business memory up to 500 MB", "Gmail and website lead form"],
    featured: false,
  },
  {
    code: "starter",
    name: "Starter",
    price_inr: 2499,
    price_annual_inr: 24_990,
    monthly_tokens: 3_000_000,
    tagline: "For individuals and small businesses.",
    audience: "Solo founders and micro-businesses",
    highlights: [
      "1 business, 5 people",
      "Inbox, lead and proposal agents",
      "The agent for your kind of business",
      "Calendar, Google Drive and WhatsApp",
      "Each agent can earn one action it does alone",
      "10 GB business memory",
      "Basic analytics",
    ],
    featured: false,
  },
  {
    code: "growth",
    name: "Growth",
    price_inr: 6999,
    price_annual_inr: 69_990,
    monthly_tokens: 15_000_000,
    tagline: "For businesses automating daily operations.",
    audience: "Agencies, consultants and growing SMBs",
    highlights: [
      "3 businesses, 15 people",
      "Every agent: inbox, lead, proposal, document and kitchen",
      "Autonomous actions and approval policies",
      "All integrations, including Tally",
      "50 GB business memory",
      "Advanced analytics",
      "Priority support",
    ],
    featured: true,
  },
  {
    code: "scale",
    name: "Scale",
    price_inr: 14_999,
    price_annual_inr: 1_49_990,
    monthly_tokens: 50_000_000,
    tagline: "For growing teams and multiple businesses.",
    audience: "Serious SMBs and multi-team companies",
    highlights: [
      "10 businesses, 50 people",
      "All agents and all integrations",
      "Autonomous and custom workflows",
      "Advanced permissions and audit logs",
      "250 GB business memory",
      "Advanced analytics and API access",
      "Priority processing and support",
    ],
    featured: false,
  },
];

export const ENTERPRISE = {
  code: "enterprise",
  name: "Enterprise",
  from_inr: 29_999,
  tagline: "Custom businesses, users and AI usage, quoted for you.",
  highlights: ["Unlimited or custom businesses", "100+ people", "Custom agents and workflows", "API, SSO and RBAC", "Dedicated environment and SLA", "Onboarding and data migration", "Dedicated success manager"],
  contact: "mailto:support@sitelytc.com?subject=Kritvia%20Enterprise",
};

export const TOKEN_PACKS = [
  { code: "pack_5m", tokens: 5_000_000, price_inr: 1499 },
  { code: "pack_20m", tokens: 20_000_000, price_inr: 4999 },
  { code: "pack_50m", tokens: 50_000_000, price_inr: 9999 },
];

export type Period = "monthly" | "annual";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
export const rupees = (n: number) => inr.format(n);

export function tokensLabel(n: number | null): string {
  if (n === null) return "Unlimited AI";
  if (n >= 1_000_000) return `${n % 1_000_000 ? (n / 1_000_000).toFixed(1) : n / 1_000_000}M`;
  return `${Math.round(n / 1000)}K`;
}

/** What the card shows as the big number, and the line under it. */
export function priceFor(p: Pick<PlanCard, "price_inr" | "price_annual_inr">, period: Period): { big: string; note: string } {
  if (!p.price_inr) return { big: rupees(0), note: "Free forever" };
  if (period === "annual" && p.price_annual_inr) {
    return { big: rupees(Math.floor(p.price_annual_inr / 12)), note: `Billed ${rupees(p.price_annual_inr)} a year` };
  }
  return { big: rupees(p.price_inr), note: "Billed monthly" };
}

const CORE_AGENTS = new Set(["inbox_assistant", "lead_triage", "meeting_digest"]);
const KIND_AGENT: Record<string, string> = { finance: "loan_verification", kitchen: "kitchen_daily" };

/** Mirrors Plan.allows_agent in the API: which agents a plan lets a business of this kind switch on. */
export function agentAllowed(agents: string | undefined, workflow: string, kind: string): boolean {
  if (!agents || agents === "all" || CORE_AGENTS.has(workflow)) return true;
  return agents === "kind" && KIND_AGENT[kind] === workflow;
}
