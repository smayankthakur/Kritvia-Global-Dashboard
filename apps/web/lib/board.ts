import type { Schemas } from "./api";

export type Board = Schemas["BoardOut"];
export type Role = Schemas["RoleOut"];
export type Ticket = Schemas["TicketOut"];

export const ROLE_ORDER = ["front_desk", "sales", "accounts", "ops"] as const;
export type RoleKey = (typeof ROLE_ORDER)[number];

export const ROLE_TITLES: Record<RoleKey, string> = {
  front_desk: "Front desk",
  sales: "Sales",
  accounts: "Accounts",
  ops: "Operations",
};

export const ROLE_BLURBS: Record<RoleKey, string> = {
  front_desk: "Answers what comes in",
  sales: "Follows up on enquiries",
  accounts: "Checks papers and money",
  ops: "Keeps the day running",
};

export const COLUMNS = [
  { key: "waiting_approval", title: "Needs you", hint: "Drafts waiting for a yes" },
  { key: "open", title: "In progress", hint: "Agents working" },
  { key: "blocked", title: "Stuck", hint: "Budget used or an error" },
  { key: "done", title: "Done", hint: "Finished this week" },
] as const;
export type ColumnKey = (typeof COLUMNS)[number]["key"];

/** Agents grouped by role, in org-chart order; roles with no agent still appear. */
export function groupRoles(roles: Role[]): { key: RoleKey; agents: Role[] }[] {
  return ROLE_ORDER.map((key) => ({ key, agents: roles.filter((r) => r.role === key) }));
}

/** Tickets per column; done keeps only the last 7 days, cancelled is dropped. */
export function groupTickets(tickets: Ticket[], now: Date = new Date()): Record<ColumnKey, Ticket[]> {
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const out: Record<ColumnKey, Ticket[]> = { waiting_approval: [], open: [], blocked: [], done: [] };
  for (const t of tickets) {
    if (t.status === "cancelled") continue;
    if (t.status === "done" && Date.parse(t.finished_at ?? t.updated_at) < weekAgo) continue;
    out[t.status as ColumnKey]?.push(t);
  }
  return out;
}

/** 0..1 of the budget used; null when there is no budget. */
export function budgetFraction(role: Pick<Role, "monthly_tokens" | "used_tokens">): number | null {
  if (role.monthly_tokens == null) return null;
  if (role.monthly_tokens === 0) return 1;
  return Math.min(role.used_tokens / role.monthly_tokens, 1);
}

export function budgetTone(fraction: number | null): "neutral" | "success" | "warning" | "danger" {
  if (fraction == null) return "neutral";
  if (fraction >= 1) return "danger";
  if (fraction >= 0.8) return "warning";
  return "success";
}

/** 1.2M, 340k, 980 */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Model spend in rupees for display (USD at a fixed indicative rate; the cap is in tokens). */
export function formatSpend(usd: number, rate = 84): string {
  const inr = usd * rate;
  if (inr === 0) return "₹0";
  if (inr < 1) return "under ₹1";
  return `₹${Math.round(inr).toLocaleString("en-IN")}`;
}

/** Parses a budget typed as "500k", "1.5M", "20000" into tokens. */
export function parseTokens(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/,/g, "");
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** A card note an owner can act on, from the runner's error text. */
export function humanNote(note: string): string {
  if (/all deployments failed/i.test(note)) return "The AI providers could not be reached. Retry in a minute.";
  if (/budget/i.test(note)) return note;
  if (/step limit/i.test(note)) return "The agent went round in circles and was stopped.";
  if (/ConnectError|Timeout/i.test(note)) return "A service did not answer in time. Retry.";
  return note.replace(/^[A-Za-z]+Error: /, "");
}
