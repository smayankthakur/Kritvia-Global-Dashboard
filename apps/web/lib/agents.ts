/** Which agents belong on a business's Agents page, and which go under "More agents" (round 3, A4). */

/** Kinds served by one specialist agent family: kitchen agents, loan checks, shipment agents. */
const SPECIALIST = ["kitchen", "finance", "trade"] as const;

/**
 * True when an agent fits a business of this kind. Agents list the kinds they work for; "general" alone is too
 * wide (a salon is "general" and has no kitchen, loans or shipments), so an agent made for exactly one
 * specialist kind fits only that kind.
 */
export function agentFits(wf: { venture_kinds: readonly string[] }, kind: string): boolean {
  if (!wf.venture_kinds.includes(kind)) return false;
  const specific = wf.venture_kinds.filter((k) => k !== "general");
  if (specific.length === 1 && (SPECIALIST as readonly string[]).includes(specific[0]!)) return specific[0] === kind;
  return true;
}

/** Split agents into the main list and "More agents". One that is switched on always stays in the main list. */
export function splitAgents<W extends { name: string; venture_kinds: readonly string[] }>(
  workflows: readonly W[],
  kind: string,
  enabled: ReadonlySet<string>,
): { main: W[]; more: W[] } {
  const main: W[] = [];
  const more: W[] = [];
  for (const w of workflows) (agentFits(w, kind) || enabled.has(w.name) ? main : more).push(w);
  return { main, more };
}

/** The agent a link names, from "#agent-prospector". */
export function agentFromHash(hash: string | null | undefined): string | null {
  const m = /^#agent-([a-z0-9_]+)$/.exec(hash ?? "");
  return m ? m[1]! : null;
}
