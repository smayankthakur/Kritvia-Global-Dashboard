import { ApiError, errorMessage, type Schemas } from "./api";

/** Autopilot: one switch per business that lets the agents do routine work by themselves
 * (test report round 3, section D). Money, complaints and orders still come to the owner. */
export type Autopilot = Schemas["AutopilotOut"];
export type AutopilotJob = Schemas["AutopilotJob"];

export const autopilotKey = (ventureId: string) => ["autopilot", ventureId] as const;

/** What each agent does by itself, in the owner's words. Unknown agents fall back to the API's own words. */
const DOES: Record<string, string> = {
  inbox: "Answers customers' questions on WhatsApp, Telegram and email",
  booking_reminders: "Sends the day-before booking reminder",
  collections: "Sends the first two friendly payment reminders",
  reviews: "Replies to 4 and 5 star reviews, and asks pleased customers to leave one",
  social: "Posts on your chosen days, from your own offers",
  followup: "Follows up WhatsApp enquiries that went quiet",
  prospector: "Sends first messages and follow-ups from your offer line",
};

/** Short names for today's numbers. */
const SHORT: Record<string, string> = {
  inbox: "Customer replies",
  booking_reminders: "Booking reminders",
  collections: "Payment reminders",
  reviews: "Review replies",
  social: "Social posts",
  followup: "Follow-ups",
  prospector: "Prospector messages",
};

export function jobSentence(job: Pick<AutopilotJob, "agent" | "what">): string {
  const s = DOES[job.agent];
  if (s) return s;
  const w = job.what.trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : job.agent;
}

export function jobShort(agent: string): string {
  return SHORT[agent] ?? agent.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Jobs autopilot can do on this plan first, then the ones that need a bigger plan. */
export function splitJobs(jobs: AutopilotJob[]): { now: AutopilotJob[]; later: AutopilotJob[] } {
  return { now: jobs.filter((j) => j.on_plan), later: jobs.filter((j) => !j.on_plan) };
}

/** Today's numbers: how much the agents did by themselves (and by which agent, biggest first). */
export function todayNumbers(a: Pick<Autopilot, "today_by_itself" | "waiting" | "held_today">): {
  done: number;
  waiting: number;
  sent: number;
  byAgent: [string, number][];
} {
  const byAgent = Object.entries(a.today_by_itself ?? {})
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort((x, y) => y[1] - x[1]);
  return { done: byAgent.reduce((s, [, n]) => s + n, 0), waiting: a.waiting ?? 0, sent: a.held_today ?? 0, byAgent };
}

/** Why switching autopilot didn't work, in words the owner can act on. */
export function autopilotProblem(e: unknown): string {
  if (e instanceof ApiError && e.status === 403) return "Only an owner or admin of this business can switch autopilot.";
  if (e instanceof ApiError && e.status === 409) return "Fill in the business profile first, in Settings → General.";
  return errorMessage(e);
}

/** The onboarding choice: nothing is picked until the person picks. */
export type AutopilotChoice = "auto" | "approve" | null;

export function choiceProblem(choice: AutopilotChoice): string | null {
  return choice ? null : "Choose how your agents should work: autopilot, or you approve everything.";
}
