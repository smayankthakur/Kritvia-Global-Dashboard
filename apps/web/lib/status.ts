export interface Incident {
  started_at: string;
  resolved_at: string | null;
  summary: string;
}

/** "about 15 minutes", "2 h 10 min" — the watchdog checks every 5 minutes, so this is approximate. */
export function incidentLength(i: Incident, now: Date = new Date()): string {
  const end = i.resolved_at ? Date.parse(i.resolved_at) : now.getTime();
  const mins = Math.max(5, Math.round((end - Date.parse(i.started_at)) / 60_000));
  if (mins < 60) return `about ${mins} minutes`;
  const h = Math.floor(mins / 60);
  return `${h} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
}
