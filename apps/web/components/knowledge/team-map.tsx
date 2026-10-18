"use client";

import { useQuery } from "@tanstack/react-query";
import { FolderKanban, List, Locate, Minus, Network, Plus, Search, Users, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { useAccess } from "@/lib/access";
import { api, unwrap } from "@/lib/api";
import {
  colourFor,
  collaborators,
  hexagon,
  initials,
  membersOf,
  NO_TEAM,
  other,
  PERIODS,
  reasons,
  TEAM_COLOR,
  topPairs,
  type Collab,
  type CollabLink,
  type TeamInfo,
} from "@/lib/collab";
import { formatDate } from "@/lib/format";
import { forceLayout } from "@/lib/force-layout";

const W = 1000;
const H = 640;
type Sel = { kind: "node"; id: string } | { kind: "pair"; a: string; b: string } | null;

function nodeName(g: Collab, id: string): string {
  return (
    g.people.find((p) => p.id === id)?.name ??
    g.projects.find((p) => p.id === id)?.name ??
    g.teams.find((t) => t.id === id)?.name ??
    "—"
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-border text-subtle"}`}
    >
      {children}
    </button>
  );
}

function Strength({ value, max }: { value: number; max: number }) {
  return (
    <span className="block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2" aria-hidden>
      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(8, (100 * value) / Math.max(max, 1))}%` }} />
    </span>
  );
}

export function TeamMap({ ventureId }: { ventureId: string }) {
  const { isOwner } = useAccess();
  const [project, setProject] = useState("");
  const [team, setTeam] = useState("");
  const [days, setDays] = useState(90);
  const [src, setSrc] = useState({ tasks: true, docs: true, teams: true, contacts: true });
  const [find, setFind] = useState("");
  const [sel, setSel] = useState<Sel>(null);
  const [asList, setAsList] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // On a phone the map is too small to read: start with the list (the map is one tap away).
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 639px)").matches) setAsList(true);
  }, []);

  const q = useQuery({
    queryKey: ["collab", ventureId, project, team, days, src],
    queryFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/collab", {
          params: {
            path: { venture_id: ventureId },
            query: { project: project || undefined, team: team || undefined, days, ...src },
          },
        }),
      ),
    placeholderData: (prev) => prev,
  });
  const teamsQ = useQuery({
    queryKey: ["venture-teams", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/teams", { params: { path: { venture_id: ventureId } } })),
  });
  const g = q.data;

  useEffect(() => {
    setSel(null);
    setView({ x: 0, y: 0, k: 1 });
  }, [project, team, days]);

  const graph = useMemo(() => {
    if (!g) return null;
    const ids = [...g.people.map((p) => p.id), ...g.projects.map((p) => p.id), ...g.teams.map((t) => t.id)];
    const p = forceLayout(
      ids.map((id) => ({ id })),
      g.links,
      ids.length > 80 ? 200 : 320,
    );
    const xs = Object.values(p).map((v) => v.x);
    const ys = Object.values(p).map((v) => v.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // Fill the canvas: scale each axis on its own (within 2× of the other), so a tall or wide layout
    // spreads out instead of leaving labels piled up in a strip; don't blow up a 2–3 node map.
    const cap = ids.length <= 4 ? 260 : Infinity;
    let sx = Math.min((W - 200) / Math.max(x1 - x0, 1e-6), cap);
    let sy = Math.min((H - 130) / Math.max(y1 - y0, 1e-6), cap);
    sx = Math.min(sx, sy * 2.5);
    sy = Math.min(sy, sx * 2.5);
    const pos: Record<string, { x: number; y: number }> = {};
    for (const [id, v] of Object.entries(p)) pos[id] = { x: W / 2 + (v.x - (x0 + x1) / 2) * sx, y: H / 2 + (v.y - (y0 + y1) / 2) * sy };
    const maxPair = Math.max(1, ...g.links.filter((l) => l.kind === "works_with").map((l) => l.strength));
    const maxPerson = Math.max(1, ...g.people.map((p) => p.strength));
    return { pos, maxPair, maxPerson };
  }, [g]);

  // What the selection lights up.
  const lit = useMemo(() => {
    if (!g || !sel) return null;
    if (sel.kind === "pair") return new Set([sel.a, sel.b]);
    const s = new Set([sel.id]);
    for (const l of g.links) {
      if (l.source === sel.id) s.add(l.target);
      if (l.target === sel.id) s.add(l.source);
    }
    return s;
  }, [g, sel]);

  const found = useMemo(() => {
    const f = find.trim().toLowerCase();
    if (!g || !f) return null;
    return g.people.find((p) => p.name.toLowerCase().includes(f)) ?? null;
  }, [g, find]);
  useEffect(() => {
    if (found) setSel({ kind: "node", id: found.id });
  }, [found]);

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-node],[data-link]")) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const f = W / e.currentTarget.getBoundingClientRect().width;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) * f, y: d.vy + (e.clientY - d.y) * f }));
  };
  const zoom = (by: number) => setView((v) => ({ ...v, k: Math.min(4, Math.max(0.4, v.k * by)) }));

  const boards = g?.boards ?? [];
  const teams = teamsQ.data ?? [];
  // Every team's name and colour (the graph only draws the teams in view; people keep their colours).
  const teamInfo: TeamInfo[] = useMemo(() => {
    const m = new Map<string, TeamInfo>((g?.teams ?? []).map((t) => [t.team_id, { id: t.team_id, name: t.name, color: t.color }]));
    for (const t of teamsQ.data ?? []) m.set(t.id, { id: t.id, name: t.name, color: t.color });
    return [...m.values()];
  }, [g, teamsQ.data]);
  const pairs = g ? g.links.filter((l) => l.kind === "works_with") : [];
  const scope = project ? boards.find((b) => b.id === project)?.name : team ? teams.find((t) => t.id === team)?.name : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-end gap-2 border-b border-border p-3">
          <label className="min-w-36 flex-1 text-xs text-subtle">
            Project
            <Select
              aria-label="Project"
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                if (e.target.value) setTeam("");
              }}
            >
              <option value="">All projects</option>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="min-w-36 flex-1 text-xs text-subtle">
            Team
            <Select
              aria-label="Team"
              value={team}
              onChange={(e) => {
                setTeam(e.target.value);
                if (e.target.value) setProject("");
              }}
            >
              <option value="">All teams</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="min-w-36 flex-1 text-xs text-subtle">
            Period
            <Select aria-label="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {PERIODS.map(([d, l]) => (
                <option key={d} value={d}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
          <div className="relative min-w-40 flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-subtle" aria-hidden />
            <label htmlFor="team-map-find" className="sr-only">
              Find a person
            </label>
            <Input id="team-map-find" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a person…" className="pl-8" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2" role="group" aria-label="What counts as working together">
          <span className="mr-1 text-xs text-subtle">Count:</span>
          <Chip on={src.tasks} onClick={() => setSrc({ ...src, tasks: !src.tasks })}>
            Shared project tasks
          </Chip>
          <Chip on={src.docs} onClick={() => setSrc({ ...src, docs: !src.docs })}>
            Meetings &amp; emails
          </Chip>
          <Chip on={src.teams} onClick={() => setSrc({ ...src, teams: !src.teams })}>
            Same team
          </Chip>
          <Chip on={src.contacts} onClick={() => setSrc({ ...src, contacts: !src.contacts })}>
            Outside contacts
          </Chip>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label={asList ? "Show the map" : "Show as a list"} aria-pressed={asList} onClick={() => setAsList(!asList)}>
              {asList ? <Network className="h-4 w-4" /> : <List className="h-4 w-4" />}
            </Button>
            {!asList ? (
              <>
                <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}>
                  <Minus className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => zoom(1.25)}>
                  <Plus className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Reset view" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
                  <Locate className="h-4 w-4" />
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {scope ? (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
            <Badge tone="accent" className="gap-1">
              {project ? "Project" : "Team"}: {scope}
              <button
                type="button"
                aria-label="Show everyone"
                className="ml-1"
                onClick={() => {
                  setProject("");
                  setTeam("");
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
            {team ? <span>Dashed rings: people outside the team who work with it.</span> : null}
          </div>
        ) : null}

        {q.isPending ? (
          <div className="p-4">
            <SkeletonRows />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !g || !g.people.length ? (
          <EmptyState
            icon={Users}
            title="No one to show yet"
            description={
              <>
                People appear as they work together: tasks on a project board, meetings and emails Kritvia reads, and teams.{" "}
                <Link href={`/v/${ventureId}/tasks`} className="text-accent hover:underline">
                  Open Tasks
                </Link>
                {isOwner ? (
                  <>
                    {" · "}
                    <Link href="/teams" className="text-accent hover:underline">
                      Set up teams
                    </Link>
                  </>
                ) : null}
              </>
            }
          />
        ) : asList ? (
          <PairTable g={g} onPick={(l) => setSel({ kind: "pair", a: l.source, b: l.target })} />
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block aspect-[25/16] w-full cursor-grab touch-none bg-surface-2/40 active:cursor-grabbing"
            role="group"
            aria-label={`Map of ${g.people.length} people, ${g.projects.length} projects and ${g.teams.length} teams, with ${pairs.length} pairs who work together`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onWheel={(e) => zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)}
          >
            <g transform={`translate(${view.x + (W / 2) * (1 - view.k)} ${view.y + (H / 2) * (1 - view.k)}) scale(${view.k})`}>
              {g.links.map((l, i) => {
                const a = graph!.pos[l.source];
                const b = graph!.pos[l.target];
                if (!a || !b) return null;
                const on = !lit || (lit.has(l.source) && lit.has(l.target));
                const isSel = sel?.kind === "pair" && ((sel.a === l.source && sel.b === l.target) || (sel.a === l.target && sel.b === l.source));
                if (l.kind !== "works_with") {
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="currentColor"
                      className="text-border-strong"
                      strokeWidth={1}
                      strokeDasharray={l.kind === "on_project" ? "5 4" : "1.5 4"}
                      opacity={on ? 0.8 : 0.1}
                    />
                  );
                }
                const w = 1.5 + (5 * l.strength) / graph!.maxPair;
                return (
                  <g key={i} data-link opacity={on ? 1 : 0.1}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" className={isSel ? "text-accent" : "text-muted"} strokeWidth={w} strokeLinecap="round" opacity={isSel ? 1 : 0.55} />
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="transparent"
                      strokeWidth={14}
                      className="cursor-pointer"
                      onClick={() => setSel({ kind: "pair", a: l.source, b: l.target })}
                    >
                      <title>{`${nodeName(g, l.source)} & ${nodeName(g, l.target)}: ${reasons(l).join(", ")}`}</title>
                    </line>
                  </g>
                );
              })}
              {g.teams.map((t) => {
                const p = graph!.pos[t.id];
                if (!p) return null;
                const isSel = sel?.kind === "node" && sel.id === t.id;
                return (
                  <NodeShell key={t.id} id={t.id} p={p} label={`${t.name}, team of ${t.members}`} dim={!!lit && !lit.has(t.id)} onSelect={setSel}>
                    <polygon points={hexagon(22)} fill={TEAM_COLOR[t.color]} stroke={isSel ? "currentColor" : "var(--surface)"} strokeWidth={isSel ? 3 : 2} className={isSel ? "text-fg" : ""} />
                    <Users x={-8} y={-8} width={16} height={16} color="#fff" aria-hidden />
                    <NodeLabel y={36} text={t.name} bold />
                  </NodeShell>
                );
              })}
              {g.projects.map((pr) => {
                const p = graph!.pos[pr.id];
                if (!p) return null;
                const isSel = sel?.kind === "node" && sel.id === pr.id;
                const fill = colourFor([pr.team_id], teamInfo);
                return (
                  <NodeShell key={pr.id} id={pr.id} p={p} label={`${pr.name}, project with ${pr.people} people`} dim={!!lit && !lit.has(pr.id)} onSelect={setSel}>
                    <rect x={-15} y={-15} width={30} height={30} rx={7} fill="var(--surface)" stroke={fill} strokeWidth={isSel ? 4 : 2.5} />
                    <FolderKanban x={-8} y={-8} width={16} height={16} color={fill} aria-hidden />
                    <NodeLabel y={30} text={pr.name} />
                  </NodeShell>
                );
              })}
              {g.people.map((pe) => {
                const p = graph!.pos[pe.id];
                if (!p) return null;
                const isSel = sel?.kind === "node" && sel.id === pe.id;
                const r = 13 + 9 * Math.sqrt(pe.strength / graph!.maxPerson);
                const contact = pe.kind === "contact";
                const fill = contact ? "var(--surface)" : colourFor(pe.teams, teamInfo);
                const showLabel = isSel || view.k > 1.2 || g.people.length < 45 || (lit?.has(pe.id) ?? false) || r > 16;
                return (
                  <NodeShell
                    key={pe.id}
                    id={pe.id}
                    p={p}
                    label={`${pe.name}${contact ? ", outside contact" : ""}${pe.outside ? ", outside the team" : ""}`}
                    dim={!!lit && !lit.has(pe.id)}
                    onSelect={setSel}
                  >
                    {pe.outside ? <circle r={r + 5} fill="none" stroke="currentColor" className="text-subtle" strokeDasharray="3 3" /> : null}
                    {pe.leads.length ? <circle r={r + 3} fill="none" stroke={fill} strokeWidth={1.5} /> : null}
                    <circle
                      r={r}
                      fill={fill}
                      stroke={isSel ? "currentColor" : contact ? NO_TEAM : "var(--surface)"}
                      strokeWidth={isSel ? 3 : 1.5}
                      strokeDasharray={contact ? "3 2" : undefined}
                      className={isSel ? "text-fg" : ""}
                    />
                    <text textAnchor="middle" dy="0.35em" fontSize={r > 16 ? 12 : 10} fontWeight={700} fill={contact ? "currentColor" : "#fff"} className={contact ? "text-muted" : ""}>
                      {initials(pe.name)}
                    </text>
                    {showLabel ? <NodeLabel y={r + 15} text={pe.name} /> : null}
                  </NodeShell>
                );
              })}
            </g>
          </svg>
        )}
        {asList ? null : <Legend />}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-subtle">
          <span>
            {g
              ? `${g.people.length} ${g.people.length === 1 ? "person" : "people"} · ${g.projects.length} project${g.projects.length === 1 ? "" : "s"} · ${pairs.length} pair${pairs.length === 1 ? "" : "s"} working together`
              : ""}
            {g?.truncated ? " · showing the most connected; pick a project or team to see everyone" : ""}
          </span>
          <span>Built only from what you can see. Click a person, project, team or line.</span>
        </div>
      </Card>
      <Card className="p-4">
        {g ? (
          <Panel
            g={g}
            teams={teamInfo}
            sel={sel}
            ventureId={ventureId}
            setSel={setSel}
            onProject={(id) => {
              setProject(id);
              setTeam("");
            }}
            onTeam={(id) => {
              setTeam(id);
              setProject("");
            }}
          />
        ) : null}
      </Card>
    </div>
  );
}

function NodeShell({
  id,
  p,
  label,
  dim,
  onSelect,
  children,
}: {
  id: string;
  p: { x: number; y: number };
  label: string;
  dim: boolean;
  onSelect: (s: Sel) => void;
  children: ReactNode;
}) {
  return (
    <g
      data-node
      transform={`translate(${p.x} ${p.y})`}
      opacity={dim ? 0.2 : 1}
      className="cursor-pointer outline-none"
      tabIndex={0}
      role="button"
      aria-label={label}
      onClick={() => onSelect({ kind: "node", id })}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect({ kind: "node", id });
        }
      }}
    >
      {children}
    </g>
  );
}

function NodeLabel({ y, text, bold }: { y: number; text: string; bold?: boolean }) {
  return (
    <text y={y} textAnchor="middle" fontSize={13} className={`fill-fg ${bold ? "font-semibold" : "font-medium"}`} paintOrder="stroke" stroke="var(--surface)" strokeWidth={3}>
      {text.length > 24 ? text.slice(0, 23) + "…" : text}
    </text>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted" aria-label="Legend">
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="6" fill={TEAM_COLOR.blue} />
        </svg>
        Person (team colour)
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={NO_TEAM} strokeDasharray="3 2" />
        </svg>
        Outside contact
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="none" stroke={TEAM_COLOR.green} strokeWidth="2" />
        </svg>
        Project
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <polygon points={hexagon(6.5)} transform="translate(7 7)" fill={TEAM_COLOR.yellow} />
        </svg>
        Team
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="1" y1="4" x2="21" y2="4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        Work together (thicker = more)
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="1" y1="4" x2="21" y2="4" stroke="currentColor" strokeDasharray="5 4" />
        </svg>
        On a project
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="1" y1="4" x2="21" y2="4" stroke="currentColor" strokeDasharray="1.5 4" />
        </svg>
        In a team
      </span>
    </div>
  );
}

function PairTable({ g, onPick }: { g: Collab; onPick: (l: CollabLink) => void }) {
  const rows = g.links.filter((l) => l.kind === "works_with").sort((a, b) => b.strength - a.strength);
  const proj = (ids: string[]) => ids.map((id) => g.projects.find((p) => p.board_id === id)?.name ?? g.boards.find((b) => b.id === id)?.name).filter(Boolean).join(", ");
  if (!rows.length) return <p className="p-6 text-center text-sm text-subtle">No two people work together in this view yet.</p>;
  return (
    <div className="max-h-[640px] overflow-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Who works with whom</caption>
        <thead className="sticky top-0 bg-surface text-left text-xs text-subtle">
          <tr>
            <th className="px-3 py-2 font-medium">People</th>
            <th className="px-3 py-2 font-medium">Projects</th>
            <th className="px-3 py-2 font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={`${l.source}-${l.target}`} className="border-t border-border hover:bg-surface-2/60">
              <td className="px-3 py-2">
                <button type="button" className="text-left font-medium hover:text-accent" onClick={() => onPick(l)}>
                  {nodeName(g, l.source)} &amp; {nodeName(g, l.target)}
                </button>
              </td>
              <td className="px-3 py-2 text-muted">{proj(l.projects) || "—"}</td>
              <td className="px-3 py-2 text-muted">{reasons(l).join(" · ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({
  g,
  teams,
  sel,
  ventureId,
  setSel,
  onProject,
  onTeam,
}: {
  g: Collab;
  teams: TeamInfo[];
  sel: Sel;
  ventureId: string;
  setSel: (s: Sel) => void;
  onProject: (boardId: string) => void;
  onTeam: (teamId: string) => void;
}) {
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name;
  const projName = (id: string) => g.projects.find((p) => p.board_id === id)?.name ?? g.boards.find((b) => b.id === id)?.name;
  const max = Math.max(1, ...g.links.filter((l) => l.kind === "works_with").map((l) => l.strength));
  const PairRow = ({ l, from }: { l: CollabLink; from?: string }) => {
    const label = from ? nodeName(g, other(l, from)) : `${nodeName(g, l.source)} & ${nodeName(g, l.target)}`;
    const ps = l.projects.map(projName).filter(Boolean);
    return (
      <li>
        <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => setSel({ kind: "pair", a: l.source, b: l.target })}>
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <Strength value={l.strength} max={max} />
          </span>
          <span className="block text-xs text-subtle">{[ps.join(", "), ...reasons(l)].filter(Boolean).join(" · ")}</span>
        </button>
      </li>
    );
  };

  if (!sel) {
    const top = topPairs(g, undefined, 6);
    return (
      <div className="space-y-3">
        <h2 className="text-base font-semibold">Who works with whom</h2>
        <p className="text-sm text-muted">
          Two people are linked when they have tasks on the same project board, one hands a task to the other, they&apos;re named in the same meeting or email, or they share a team. Pick a project or a team above to see just its people.
        </p>
        {top.length ? (
          <>
            <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">Closest collaborators</h3>
            <ul className="space-y-0.5">
              {top.map((l) => (
                <PairRow key={`${l.source}-${l.target}`} l={l} />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }

  if (sel.kind === "pair") {
    const l = g.links.find((x) => x.kind === "works_with" && ((x.source === sel.a && x.target === sel.b) || (x.source === sel.b && x.target === sel.a)));
    if (!l) return null;
    return (
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold">
            <button type="button" className="hover:text-accent" onClick={() => setSel({ kind: "node", id: l.source })}>
              {nodeName(g, l.source)}
            </button>{" "}
            &amp;{" "}
            <button type="button" className="hover:text-accent" onClick={() => setSel({ kind: "node", id: l.target })}>
              {nodeName(g, l.target)}
            </button>
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setSel(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <ul className="space-y-1 text-sm">
          {l.projects.length ? <li>On {l.projects.map(projName).filter(Boolean).join(", ")}</li> : null}
          {l.shared_tasks ? <li>{l.shared_tasks} task{l.shared_tasks === 1 ? "" : "s"} side by side on shared projects</li> : null}
          {l.handoffs ? <li>{l.handoffs} task{l.handoffs === 1 ? "" : "s"} one made and gave to the other</li> : null}
          {l.same_team ? <li>Both in {l.teams.map(teamName).filter(Boolean).join(", ")}</li> : null}
        </ul>
        {l.evidence.length ? (
          <>
            <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">Named together in</h3>
            <ul className="space-y-1">
              {l.evidence.map((d) => (
                <li key={d.id} className="text-sm">
                  <Link href={`/v/${ventureId}/knowledge/${d.id}`} className="text-accent hover:underline">
                    {d.title}
                  </Link>
                  <span className="text-xs text-subtle">
                    {" "}
                    · {d.kind === "transcript" ? "meeting" : d.kind}
                    {d.date ? ` · ${formatDate(d.date)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {l.meetings + l.emails + l.other_docs > l.evidence.length ? (
              <p className="text-xs text-subtle">and {l.meetings + l.emails + l.other_docs - l.evidence.length} more</p>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  const person = g.people.find((p) => p.id === sel.id);
  if (person) {
    const mine = collaborators(g, person.id);
    const projects = g.links.filter((l) => l.kind === "on_project" && l.source === person.id);
    return (
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{person.name}</h2>
            <p className="truncate text-xs text-subtle">
              {person.kind === "contact" ? "Outside contact, named in meetings and emails" : person.email}
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setSel(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {person.teams.map((t) => (
            <Badge key={t} tone="neutral">
              {teamName(t)}
              {person.leads.includes(t) ? " · lead" : ""}
            </Badge>
          ))}
          {person.outside ? <Badge tone="info">Outside this team</Badge> : null}
        </div>
        {person.kind === "member" ? (
          <p className="text-sm text-muted">
            {person.open_tasks} open · {person.done_tasks} done tasks
            {person.documents ? ` · named in ${person.documents} meeting${person.documents === 1 ? "" : "s"}, emails or documents` : ""}
          </p>
        ) : null}
        <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">Works with</h3>
        {mine.length ? (
          <ul className="space-y-0.5">
            {mine.map((l) => (
              <PairRow key={`${l.source}-${l.target}`} l={l} from={person.id} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-subtle">No one in this view yet.</p>
        )}
        {projects.length ? (
          <>
            <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">Projects</h3>
            <ul className="space-y-1">
              {projects.map((l) => (
                <li key={l.target} className="flex items-center justify-between gap-2 text-sm">
                  <button type="button" className="truncate hover:text-accent" onClick={() => setSel({ kind: "node", id: l.target })}>
                    {nodeName(g, l.target)}
                  </button>
                  <span className="shrink-0 text-xs text-subtle">
                    {l.shared_tasks ? `${l.shared_tasks} task${l.shared_tasks === 1 ? "" : "s"}` : ""}
                    {l.shared_tasks && l.mentions ? " · " : ""}
                    {l.mentions ? `${l.mentions} mention${l.mentions === 1 ? "" : "s"}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }

  const proj = g.projects.find((p) => p.id === sel.id);
  const tm = g.teams.find((t) => t.id === sel.id);
  if (!proj && !tm) return null;
  const people = membersOf(g, sel.id);
  const ranked = [...people]
    .map((id) => g.people.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => b.strength - a.strength);
  const outsiders = tm
    ? g.people.filter((p) => !people.has(p.id) && collaborators(g, p.id).some((l) => people.has(other(l, p.id))))
    : [];
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-subtle">{proj ? "Project" : "Team"}</p>
          <h2 className="text-base font-semibold">{proj?.name ?? tm?.name}</h2>
          {proj?.team_id ? <p className="text-xs text-subtle">Team: {teamName(proj.team_id)}</p> : null}
          {proj ? <p className="text-xs text-subtle">{proj.open_tasks} open tasks</p> : null}
        </div>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={() => setSel(null)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <Button size="sm" onClick={() => (proj ? onProject(proj.board_id) : onTeam(tm!.team_id))}>
        Show only this {proj ? "project" : "team"}
      </Button>
      <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">People</h3>
      <ul className="space-y-1">
        {ranked.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
            <button type="button" className="truncate hover:text-accent" onClick={() => setSel({ kind: "node", id: p.id })}>
              {p.name}
              {tm && p.leads.includes(tm.team_id) ? " · lead" : ""}
            </button>
            <span className="shrink-0 text-xs text-subtle">{p.kind === "contact" ? "outside contact" : `${p.open_tasks} open`}</span>
          </li>
        ))}
      </ul>
      {topPairs(g, people).length ? (
        <>
          <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">Working most closely</h3>
          <ul className="space-y-0.5">
            {topPairs(g, people).map((l) => (
              <PairRow key={`${l.source}-${l.target}`} l={l} />
            ))}
          </ul>
        </>
      ) : null}
      {outsiders.length ? (
        <>
          <h3 className="text-xs font-semibold tracking-wide text-subtle uppercase">Works with the team from outside</h3>
          <ul className="space-y-1">
            {outsiders.map((p) => (
              <li key={p.id}>
                <button type="button" className="text-sm hover:text-accent" onClick={() => setSel({ kind: "node", id: p.id })}>
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
