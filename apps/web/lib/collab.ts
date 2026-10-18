/** Who works with whom (the mind map's People & projects view): colours, labels and the
 * plain-language "why" behind each link. */
import type { Schemas } from "@/lib/api";

export type Collab = Schemas["CollabOut"];
export type CollabLink = Schemas["CollabLink"];
export type CollabPerson = Schemas["CollabPerson"];
export type TeamColor = Schemas["TeamOut"]["color"];

/** Team colours: the validated categorical palette, stepped for light and dark (CSS variables in
 * globals.css). Identity only, always with the team's name beside it. */
export const TEAM_COLOR: Record<TeamColor, string> = {
  blue: "var(--team-blue)",
  orange: "var(--team-orange)",
  aqua: "var(--team-aqua)",
  yellow: "var(--team-yellow)",
  pink: "var(--team-pink)",
  green: "var(--team-green)",
  violet: "var(--team-violet)",
  red: "var(--team-red)",
};
export const TEAM_COLORS = Object.keys(TEAM_COLOR) as TeamColor[];
export const NO_TEAM = "var(--fg-subtle)";

export const PERIODS: [number, string][] = [
  [30, "Last 30 days"],
  [90, "Last 90 days"],
  [180, "Last 6 months"],
  [365, "Last 12 months"],
];

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "")).toUpperCase();
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 shared tasks · 1 handoff · 1 meeting · same team" */
export function reasons(l: CollabLink): string[] {
  const out: string[] = [];
  if (l.shared_tasks) out.push(plural(l.shared_tasks, "shared task"));
  if (l.handoffs) out.push(plural(l.handoffs, "task handed over", "tasks handed over"));
  if (l.meetings) out.push(plural(l.meetings, "meeting"));
  if (l.emails) out.push(plural(l.emails, "email"));
  if (l.other_docs) out.push(plural(l.other_docs, "document"));
  if (l.same_team) out.push("same team");
  return out;
}

/** The other end of a link. */
export function other(l: CollabLink, id: string): string {
  return l.source === id ? l.target : l.source;
}

/** A person's collaborators, closest first. */
export function collaborators(g: Collab, id: string): CollabLink[] {
  return g.links
    .filter((l) => l.kind === "works_with" && (l.source === id || l.target === id))
    .sort((a, b) => b.strength - a.strength);
}

/** The closest pairs, optionally among a set of people (a project's or a team's). */
export function topPairs(g: Collab, among?: Set<string>, n = 5): CollabLink[] {
  return g.links
    .filter((l) => l.kind === "works_with" && (!among || (among.has(l.source) && among.has(l.target))))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, n);
}

/** The person ids linked to a project or a team node. */
export function membersOf(g: Collab, nodeId: string): Set<string> {
  const s = new Set<string>();
  for (const l of g.links) {
    if ((l.kind === "on_project" || l.kind === "in_team") && l.target === nodeId) s.add(l.source);
  }
  return s;
}

export interface TeamInfo {
  id: string;
  name: string;
  color: TeamColor;
}

/** The colour a person or project wears: their first team's (by name), else neutral. */
export function colourFor(teamIds: (string | null | undefined)[], teams: TeamInfo[]): string {
  const mine = teams.filter((t) => teamIds.includes(t.id)).sort((a, b) => a.name.localeCompare(b.name));
  return mine[0] ? TEAM_COLOR[mine[0].color] : NO_TEAM;
}

/** Hexagon points for a team node. */
export function hexagon(r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    return `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`;
  }).join(" ");
}
