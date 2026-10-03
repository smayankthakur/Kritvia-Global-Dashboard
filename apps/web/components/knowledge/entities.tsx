"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Network, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/dialog";
import { Input } from "@/components/ui/field";
import { EmptyState, ErrorState, QueryState, SkeletonRows } from "@/components/ui/states";
import { api, unwrap } from "@/lib/api";
import { formatTimestamp, titleCase } from "@/lib/format";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function EntityDetail({ ventureId, entityId, onOpen }: { ventureId: string; entityId: string; onOpen: (id: string, name: string) => void }) {
  const q = useQuery({
    queryKey: ["entities", ventureId, entityId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/entities/{entity_id}", { params: { path: { venture_id: ventureId, entity_id: entityId } } })),
  });
  if (q.isPending) return <SkeletonRows />;
  if (q.isError) return <ErrorState error={q.error} />;
  const e = q.data;
  return (
    <div className="space-y-6">
      <Badge tone="accent">{e.type}</Badge>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Relationships</h3>
        {e.edges.length ? (
          <ul className="space-y-1.5">
            {e.edges.map((x, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                {x.direction === "out" ? <ArrowRight className="h-3.5 w-3.5 text-subtle" aria-label="outgoing" /> : <ArrowLeft className="h-3.5 w-3.5 text-subtle" aria-label="incoming" />}
                <span className="text-muted">{titleCase(x.type)}</span>
                <button type="button" className="font-medium hover:text-accent" onClick={() => onOpen(x.other_id, x.other_name)}>
                  {x.other_name}
                </button>
                <Badge>{x.other_type}</Badge>
                <Link href={`/v/${ventureId}/knowledge/${x.document_id}?chunk=${x.chunk_id}`} className="text-xs text-accent hover:underline">
                  source
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-subtle">No relationships recorded.</p>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">Facts</h3>
        {e.facts.length ? (
          <ul className="space-y-2">
            {e.facts.map((f) => (
              <li key={f.id} className="rounded-md border border-border p-2.5 text-sm">
                <div className="mb-1 flex items-center gap-2">
                  <Badge>{f.kind}</Badge>
                  {f.status ? <Badge tone="info">{f.status}</Badge> : null}
                </div>
                <p>{f.statement}</p>
                <Link href={`/v/${ventureId}/knowledge/${f.document_id}?chunk=${f.chunk_id}`} className="mt-1 inline-block text-xs text-accent hover:underline">
                  {f.document_title}
                  {f.source_start_s !== null ? ` · ${formatTimestamp(f.source_start_s)}` : ""}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-subtle">No facts about this entity yet.</p>
        )}
      </section>
    </div>
  );
}

export function EntitiesBrowser({ ventureId }: { ventureId: string }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const dq = useDebounced(q);
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const list = useQuery({
    queryKey: ["entities", ventureId, "list", dq, type],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/entities", { params: { path: { venture_id: ventureId }, query: { q: dq || undefined, type: type || undefined, limit: 200 } } })),
  });
  const types = Array.from(new Set((list.data ?? []).map((e) => e.type))).sort();
  return (
    <div>
      <div className="flex flex-wrap gap-2 border-b border-border p-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-subtle" aria-hidden />
          <label htmlFor="entity-q" className="sr-only">
            Search entities
          </label>
          <Input id="entity-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, companies, products…" className="pl-8" />
        </div>
        {types.length > 1 || type ? (
          <div className="flex flex-wrap gap-1">
            <button type="button" onClick={() => setType("")} className={`rounded-full px-2.5 py-1 text-xs ${!type ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"}`}>
              All
            </button>
            {(type && !types.includes(type) ? [...types, type] : types).map((t) => (
              <button key={t} type="button" onClick={() => setType(t)} className={`rounded-full px-2.5 py-1 text-xs ${type === t ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted"}`}>
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <QueryState query={list} empty={<EmptyState icon={Network} title="No entities found" description="Entities are extracted from documents and meetings as they are ingested." />}>
        {(data) => (
          <ul className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3">
            {data.map((e) => (
              <li key={e.id} className="bg-surface">
                <button type="button" onClick={() => setOpen({ id: e.id, name: e.name })} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-surface-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{e.name}</span>
                    <span className="text-xs text-subtle">
                      {e.facts} fact(s) · {e.edges} link(s)
                    </span>
                  </span>
                  <Badge>{e.type}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Sheet open={Boolean(open)} onClose={() => setOpen(null)} title={open?.name ?? "Entity"} size="lg">
        {open ? <EntityDetail ventureId={ventureId} entityId={open.id} onOpen={(id, name) => setOpen({ id, name })} /> : null}
      </Sheet>
    </div>
  );
}
