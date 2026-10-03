"use client";

import { useQuery } from "@tanstack/react-query";
import { Locate, Minus, Network, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { EntityDetail } from "@/components/knowledge/entities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { api, unwrap } from "@/lib/api";
import { titleCase } from "@/lib/format";
import { forceLayout } from "@/lib/force-layout";

/** Mid-tone colours that read on light and dark surfaces. */
export const TYPE_COLOR: Record<string, string> = {
  person: "#6366f1",
  company: "#0ea5e9",
  project: "#10b981",
  property: "#f59e0b",
  vendor: "#ef4444",
  sku: "#a855f7",
  loan: "#eab308",
  product: "#ec4899",
  place: "#f97316",
  other: "#94a3b8",
};

const W = 1000;
const H = 640;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function MindMap({ ventureId }: { ventureId: string }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [focus, setFocus] = useState<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const g = useQuery({
    queryKey: ["graph", ventureId, focus?.id ?? "", focus ? "" : dq],
    queryFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/graph", {
          params: { path: { venture_id: ventureId }, query: { focus: focus?.id, q: focus ? undefined : dq || undefined, limit: 120 } },
        }),
      ),
  });

  const nodes = useMemo(() => (g.data?.nodes ?? []).filter((n) => !hidden.has(n.type)), [g.data, hidden]);
  const ids = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const links = useMemo(() => (g.data?.links ?? []).filter((l) => ids.has(l.source) && ids.has(l.target)), [g.data, ids]);
  const pos = useMemo(() => {
    const p = forceLayout(nodes.map((n) => ({ id: n.id })), links, nodes.length > 80 ? 200 : 300, focus?.id);
    const xs = Object.values(p).map((v) => v.x);
    const ys = Object.values(p).map((v) => v.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // Fit the drawing to the canvas (room for labels), but don't blow up a 2–3 node map.
    const s = Math.min((W - 160) / Math.max(x1 - x0, 1e-6), (H - 100) / Math.max(y1 - y0, 1e-6), 260);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const out: Record<string, { x: number; y: number }> = {};
    for (const [id, v] of Object.entries(p)) out[id] = { x: W / 2 + (v.x - cx) * s, y: H / 2 + (v.y - cy) * s };
    return out;
  }, [nodes, links, focus?.id]);
  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));
  const types = Array.from(new Set((g.data?.nodes ?? []).map((n) => n.type))).sort();
  const neighbours = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected.id]);
    for (const l of links) {
      if (l.source === selected.id) s.add(l.target);
      if (l.target === selected.id) s.add(l.source);
    }
    return s;
  }, [selected, links]);

  useEffect(() => setView({ x: 0, y: 0, k: 1 }), [focus?.id, dq]);

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-node]")) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const f = W / rect.width;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x) * f, y: d.vy + (e.clientY - d.y) * f }));
  };
  const zoom = (by: number) => setView((v) => ({ ...v, k: Math.min(4, Math.max(0.4, v.k * by)) }));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          {focus ? (
            <Badge tone="accent" className="gap-1">
              Around {focus.name}
              <button type="button" aria-label="Show the whole map" onClick={() => setFocus(null)} className="ml-1">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ) : (
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-subtle" aria-hidden />
              <label htmlFor="map-q" className="sr-only">
                Search the map
              </label>
              <Input id="map-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person, company, deal…" className="pl-8" />
            </div>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}>
              <Minus className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => zoom(1.25)}>
              <Plus className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Reset view" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
              <Locate className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {types.length > 1 ? (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2" role="group" aria-label="Show types">
            {types.map((t) => {
              const off = hidden.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={!off}
                  onClick={() => setHidden((h) => { const n = new Set(h); if (off) n.delete(t); else n.add(t); return n; })}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${off ? "border-border text-subtle line-through" : "border-border text-muted"}`}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: TYPE_COLOR[t] ?? TYPE_COLOR.other }} />
                  {titleCase(t)}
                </button>
              );
            })}
          </div>
        ) : null}
        {g.isPending ? (
          <div className="p-4"><SkeletonRows /></div>
        ) : g.isError ? (
          <ErrorState error={g.error} onRetry={() => void g.refetch()} />
        ) : !nodes.length ? (
          <EmptyState icon={Network} title={dq ? "Nothing matches" : "The map is empty"} description={dq ? "Try another name." : "People, companies and deals appear here as Kritvia reads your documents, emails and meetings."} />
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block aspect-[25/16] w-full cursor-grab touch-none bg-surface-2/40 active:cursor-grabbing"
            role="img"
            aria-label={`Mind map of ${nodes.length} entities and ${links.length} links`}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onWheel={(e) => zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)}
          >
            <g transform={`translate(${view.x + (W / 2) * (1 - view.k)} ${view.y + (H / 2) * (1 - view.k)}) scale(${view.k})`}>
              {links.map((l, i) => {
                const a = pos[l.source];
                const b = pos[l.target];
                if (!a || !b) return null;
                const dim = neighbours && !(neighbours.has(l.source) && neighbours.has(l.target));
                return (
                  <g key={i} opacity={dim ? 0.12 : 0.7}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" className="text-border" strokeWidth={1 + Math.min(l.count, 4) * 0.5} />
                    {view.k > 1.3 || (selected && !dim) ? (
                      <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} className="fill-subtle" fontSize={10} textAnchor="middle">
                        {titleCase(l.type)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              {nodes.map((n) => {
                const p = pos[n.id];
                if (!p) return null;
                const r = 6 + 14 * Math.sqrt(n.degree / maxDeg);
                const dim = neighbours && !neighbours.has(n.id);
                const isSel = selected?.id === n.id;
                return (
                  <g
                    key={n.id}
                    data-node
                    transform={`translate(${p.x} ${p.y})`}
                    opacity={dim ? 0.25 : 1}
                    className="cursor-pointer outline-none focus-visible:[&>circle]:stroke-[var(--accent)]"
                    tabIndex={0}
                    role="button"
                    aria-label={`${n.name}, ${n.type}, ${n.degree} links`}
                    onClick={() => setSelected({ id: n.id, name: n.name })}
                    onDoubleClick={() => setFocus({ id: n.id, name: n.name })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setSelected({ id: n.id, name: n.name });
                    }}
                  >
                    <circle r={r} fill={TYPE_COLOR[n.type] ?? TYPE_COLOR.other} stroke={isSel ? "currentColor" : "var(--surface)"} strokeWidth={isSel ? 3 : 1.5} className={isSel ? "text-fg" : ""} />
                    {r > 9 || isSel || view.k > 1.2 || nodes.length < 40 ? (
                      <text y={r + 13} textAnchor="middle" fontSize={12} className="fill-fg font-medium" paintOrder="stroke" stroke="var(--surface)" strokeWidth={3}>
                        {n.name.length > 26 ? n.name.slice(0, 25) + "…" : n.name}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </g>
          </svg>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-subtle">
          <span>
            {nodes.length} of {g.data?.total_entities ?? 0} entities · {links.length} links
            {g.data?.truncated ? " · showing the best connected; search to find others" : ""}
          </span>
          <span>Click to see sources · double-click to centre the map on it · drag to move · scroll to zoom</span>
        </div>
      </Card>
      <Card className="p-4">
        {selected ? (
          <>
            <div className="mb-3 flex items-start justify-between gap-2">
              <h2 className="text-base font-semibold">{selected.name}</h2>
              <Button size="sm" onClick={() => setFocus(selected)}>
                Centre map here
              </Button>
            </div>
            <EntityDetail ventureId={ventureId} entityId={selected.id} onOpen={(id, name) => setSelected({ id, name })} />
          </>
        ) : (
          <div className="py-8 text-center text-sm text-subtle">
            <Network className="mx-auto mb-2 h-6 w-6" aria-hidden />
            Select anything on the map to see how it&apos;s connected, what Kritvia knows about it, and where each fact came from.
          </div>
        )}
      </Card>
    </div>
  );
}
