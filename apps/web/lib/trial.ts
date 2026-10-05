/** The 15-day free trial, as returned with an organisation's plan (GET /orgs/{id}/plan). */
export interface Trial {
  ends_at: string | null;
  expired: boolean;
  held: boolean;
  days_left: number | null;
}

/** One line about where the trial stands. */
export function trialNote(t: Trial | null | undefined): string {
  if (!t) return "";
  if (t.expired) return "Your free trial has ended. Choose a plan to keep working; your data is safe.";
  if (t.held) return "Free trial. It won't end before online payment opens, and you'll have 3 days after that to choose a plan.";
  const d = t.days_left ?? 0;
  return d <= 0 ? "Free trial: last day today" : `Free trial: ${d} day${d === 1 ? "" : "s"} left`;
}

/** When to nudge in the app: the last 5 days, and after the trial ends. */
export function trialNeedsAttention(t: Trial | null | undefined): boolean {
  return !!t && (t.expired || (!t.held && (t.days_left ?? 99) <= 5));
}
