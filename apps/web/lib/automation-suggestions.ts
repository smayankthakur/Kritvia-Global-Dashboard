/**
 * Ready-made automations for the Automations page. Each one is a complete draft the API accepts as
 * is (POST /ventures/{v}/automations), so adding one needs no AI call; the person can still change
 * the time, channel and recipients before saving. They only use numbers Kritvia reports on
 * (services/automations.py: facts). AGENT_SUGGESTIONS point at agents that already run on their own.
 */
import type { Schemas } from "@/lib/api";

type Draft = Omit<Schemas["AutomationIn"], "recipients"> & { recipients?: string[] };

export type SuggestionGroup = "money" | "customers" | "team";

export interface Suggestion {
  id: string;
  group: SuggestionGroup;
  title: string;
  why: string;
  draft: Draft;
}

const MON = 0;
const FRI = 4;
const SAT = 5;
const SUN = 6;

function s(id: string, group: SuggestionGroup, title: string, why: string, d: Omit<Draft, "name" | "weekdays" | "day_of_month"> & Partial<Draft>): Suggestion {
  return { id, group, title, why, draft: { name: title, weekdays: [], day_of_month: null, ...d } };
}

export const SUGGESTIONS: Suggestion[] = [
  // --- Money ---
  s("payments-today", "money", "Today's payments", "Every evening, what came in today and what is still due.", {
    said: "Every evening at 7 tell me today's payments", task: "Summarise today's payments received and what is still to collect.",
    period: "today", freq: "daily", at_time: "19:00", channel: "telegram",
  }),
  s("weekly-sales", "money", "Weekly sales", "Monday morning: last week's money received and invoices issued.", {
    said: "Every Monday at 9 send me last week's sales", task: "Report last week's sales: money received and invoices issued, compared in one line.",
    period: "last_week", freq: "weekly", weekdays: [MON], at_time: "09:00", channel: "email",
  }),
  s("overdue-monday", "money", "Overdue invoices", "Who owes you, largest first, to start the week's follow-ups.", {
    said: "Every Monday at 10 list overdue invoices", task: "List the overdue invoices, largest first, with the total overdue.",
    period: "today", freq: "weekly", weekdays: [MON], at_time: "10:00", channel: "email",
  }),
  s("dues-week", "money", "Falling due this week", "Invoices that become due in the next 7 days, so you can remind early.", {
    said: "Every Monday at 9:30 tell me which invoices fall due this week", task: "Report the open invoices falling due in the next 7 days and their total.",
    period: "next_7_days", freq: "weekly", weekdays: [MON], at_time: "09:30", channel: "email",
  }),
  s("month-so-far", "money", "Month so far", "Friday evening check on this month's collections.", {
    said: "Every Friday at 6 pm send me this month's numbers so far", task: "Summarise this month so far: money received, invoices issued, still to collect.",
    period: "this_month", freq: "weekly", weekdays: [FRI], at_time: "18:00", channel: "email",
  }),
  s("ca-monthly", "money", "Monthly summary for your CA", "On the 1st, last month's sales and dues, ready to forward to your accountant.", {
    said: "On the 1st of every month email last month's sales summary", task: "Prepare last month's sales summary for the accountant: money received, invoices issued, still to collect, overdue.",
    period: "last_month", freq: "monthly", day_of_month: 1, at_time: "10:00", channel: "email",
  }),
  s("mid-month", "money", "Mid-month cash check", "On the 15th: are collections on track this month?", {
    said: "On the 15th of every month tell me how collections are going", task: "Say how this month's collections are going so far and what is overdue.",
    period: "this_month", freq: "monthly", day_of_month: 15, at_time: "11:00", channel: "email",
  }),
  // --- Customers & bookings ---
  s("today-bookings", "customers", "Today's appointments", "Each morning, the day's bookings with times and names.", {
    said: "Every morning at 8 send me today's appointments", task: "List today's bookings in time order with customer and service.",
    period: "today", freq: "daily", at_time: "08:00", channel: "telegram",
  }),
  s("tomorrow-bookings", "customers", "Tomorrow's appointments", "Each evening, tomorrow's schedule so you can plan.", {
    said: "Every evening at 8 send me tomorrow's appointments", task: "List tomorrow's bookings in time order with customer and service.",
    period: "tomorrow", freq: "daily", at_time: "20:00", channel: "telegram",
  }),
  s("no-shows", "customers", "No-shows and cancellations", "Sunday evening: the week's no-shows and cancellations.", {
    said: "Every Sunday at 7 pm tell me this week's no-shows and cancellations", task: "Report the last 7 days' bookings: done, no-shows and cancellations.",
    period: "last_7_days", freq: "weekly", weekdays: [SUN], at_time: "19:00", channel: "email",
  }),
  s("leads-today", "customers", "New enquiries today", "Each evening, how many new leads came in.", {
    said: "Every evening at 6:30 tell me today's new leads", task: "Report today's new leads and any won.",
    period: "today", freq: "daily", at_time: "18:30", channel: "app",
  }),
  s("leads-week", "customers", "Leads and wins this week", "Friday afternoon: new leads and wins for the week.", {
    said: "Every Friday at 5 send me this week's leads and wins", task: "Report the last 7 days' new leads and wins.",
    period: "last_7_days", freq: "weekly", weekdays: [FRI], at_time: "17:00", channel: "email",
  }),
  s("monthly-review", "customers", "Monthly business review", "On the 1st: every number for last month in one short report.", {
    said: "On the 1st of every month send me a full review of last month", task: "Write a short review of last month: money, invoices, bookings, leads and agents' drafts.",
    period: "last_month", freq: "monthly", day_of_month: 1, at_time: "09:00", channel: "email",
  }),
  // --- Team & agents ---
  s("morning-brief", "team", "Morning brief", "Each morning, yesterday's numbers and drafts waiting for you.", {
    said: "Every morning at 8:30 send me yesterday's numbers", task: "Give a morning brief: yesterday's money received, new leads, bookings, and drafts waiting for a yes.",
    period: "yesterday", freq: "daily", at_time: "08:30", channel: "telegram",
  }),
  s("waiting-nudge", "team", "Drafts waiting for your yes", "A nudge at 11 on working days if drafts are waiting.", {
    said: "Monday to Saturday at 11 tell me how many drafts are waiting", task: "Say how many drafts are waiting for a yes right now.",
    period: "today", freq: "weekly", weekdays: [MON, 1, 2, 3, FRI, SAT], at_time: "11:00", channel: "telegram",
  }),
  s("agents-week", "team", "What the agents did", "Saturday: drafts the agents made and how many you approved.", {
    said: "Every Saturday at 10 tell me what the agents did this week", task: "Report the last 7 days' drafts by the agents and how many were approved.",
    period: "last_7_days", freq: "weekly", weekdays: [SAT], at_time: "10:00", channel: "email",
  }),
];

export const GROUPS: Record<SuggestionGroup, string> = {
  money: "Money",
  customers: "Customers and bookings",
  team: "You and your agents",
};

/** Agents that already work on their own; switched on in Agents (or their own page). */
export interface AgentSuggestion {
  workflow: string;
  title: string;
  what: string;
  href: (ventureId: string) => string;
  kinds?: string[];
}

const agentLink = (name: string) => (v: string) => `/v/${v}/agents#agent-${name}`;

export const AGENT_SUGGESTIONS: AgentSuggestion[] = [
  { workflow: "inbox_assistant", title: "Answer every enquiry", what: "Drafts a reply to each new email or WhatsApp message, for your yes; offers booking slots.", href: agentLink("inbox_assistant") },
  { workflow: "collections", title: "Chase unpaid invoices", what: "Polite payment reminders with your pay link, before and after the due date.", href: agentLink("collections") },
  { workflow: "booking_reminders", title: "Remind customers of bookings", what: "Reminds customers the day before their booking, after your yes. Fewer no-shows.", href: agentLink("booking_reminders") },
  { workflow: "reviews", title: "Ask for Google reviews", what: "After a booking is done or an invoice is paid, asks for a review; drafts replies to new reviews.", href: (v) => `/v/${v}/reviews` },
  { workflow: "whatsapp_followup", title: "Follow up on WhatsApp", what: "One short nudge to enquiries that went quiet after your reply, after your yes.", href: agentLink("whatsapp_followup") },
  { workflow: "lead_triage", title: "Qualify leads and draft proposals", what: "Reads each enquiry, scores it, and drafts a proposal from your rate card.", href: agentLink("lead_triage"), kinds: ["software", "general"] },
  { workflow: "prospector", title: "Find new customers", what: "Finds businesses on Google Maps every day and drafts a first message.", href: agentLink("prospector"), kinds: ["software", "general"] },
  { workflow: "meeting_digest", title: "Meeting notes and follow-ups", what: "Turns a recording into notes, tasks and a follow-up email.", href: (v) => `/v/${v}/meetings` },
  { workflow: "kitchen_daily", title: "Kitchen demand and purchase orders", what: "Every night, forecasts demand and drafts purchase orders.", href: agentLink("kitchen_daily"), kinds: ["kitchen", "general"] },
  { workflow: "loan_verification", title: "Check loan documents", what: "Reads uploaded loan papers and lists what's missing or doesn't match.", href: (v) => `/v/${v}/loans`, kinds: ["finance", "general"] },
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The schedule in words, as the API says it (services/automations.py: describe). */
export function describeSchedule(d: { freq: string; weekdays?: number[]; day_of_month?: number | null; at_time: string }): string {
  const [hh, mm] = d.at_time.split(":").map(Number) as [number, number];
  const clock = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
  if (d.freq === "daily") return `Every day at ${clock}`;
  if (d.freq === "weekly") {
    const days = [...(d.weekdays ?? [])].sort((a, b) => a - b).map((i) => DAYS[i]!);
    const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}` : (days[0] ?? "");
    return `Every ${list} at ${clock}`;
  }
  return `On day ${d.day_of_month ?? 1} of every month at ${clock}`;
}
