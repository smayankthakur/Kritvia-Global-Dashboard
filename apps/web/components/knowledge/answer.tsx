"use client";

import { FileText, Mic, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import type { Schemas } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";

type Answer = Schemas["AnswerOut"];
type Citation = Schemas["Citation"];

export function citationHref(c: Pick<Citation, "venture_id" | "document_id" | "chunk_id">): string {
  return `/v/${c.venture_id}/knowledge/${c.document_id}?chunk=${c.chunk_id}`;
}

function withCitations(text: string, byN: Map<number, Citation>, onNavigate?: () => void): ReactNode[] {
  const parts = text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g);
  return parts.map((p, i) => {
    const m = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(p);
    if (!m) return <Fragment key={i}>{p}</Fragment>;
    const ns = m[1]!.split(",").map((x) => Number(x.trim()));
    return (
      <Fragment key={i}>
        {ns.map((n) => {
          const c = byN.get(n);
          if (!c) return <sup key={n} className="text-subtle">[{n}]</sup>;
          return (
            <Link
              key={n}
              href={citationHref(c)}
              onClick={onNavigate}
              className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-1 items-center justify-center rounded bg-accent-soft px-1 align-baseline text-[10.5px] font-semibold text-accent-soft-fg hover:bg-accent hover:text-accent-fg"
              aria-label={`Source ${n}: ${c.title}`}
            >
              {n}
            </Link>
          );
        })}
      </Fragment>
    );
  });
}

export function AnswerView({ answer, onNavigate, className }: { answer: Answer; onNavigate?: () => void; className?: string }) {
  const byN = new Map(answer.citations.map((c) => [c.n, c]));
  return (
    <div className={cn("space-y-4", className)}>
      {!answer.supported ? (
        <div className="flex gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning-fg" role="note">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <span className="font-medium">Unsupported answer.</span> No source in the knowledge base backs this reply —
            treat it as unverified.
          </p>
        </div>
      ) : null}
      <div className="text-sm leading-relaxed whitespace-pre-wrap text-fg">{withCitations(answer.answer, byN, onNavigate)}</div>
      {answer.citations.length ? (
        <div>
          <h3 className="mb-2 text-xs font-medium text-subtle">Sources</h3>
          <ol className="flex flex-wrap gap-2">
            {answer.citations.map((c) => (
              <li key={`${c.n}-${c.chunk_id}`}>
                <Link
                  href={citationHref(c)}
                  onClick={onNavigate}
                  title={c.excerpt}
                  className="inline-flex max-w-[18rem] items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs hover:border-accent hover:text-accent"
                >
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-soft px-1 text-[10px] font-semibold text-accent-soft-fg">
                    {c.n}
                  </span>
                  {c.kind === "meeting" || c.kind === "transcript" ? (
                    <Mic className="h-3 w-3 shrink-0 text-subtle" aria-hidden />
                  ) : (
                    <FileText className="h-3 w-3 shrink-0 text-subtle" aria-hidden />
                  )}
                  <span className="truncate">{c.title}</span>
                  {c.page ? <span className="shrink-0 text-subtle">p.{c.page}</span> : null}
                  {c.start_s !== null && c.start_s !== undefined ? (
                    <span className="shrink-0 text-subtle">{formatTimestamp(c.start_s)}</span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <p className="text-xs text-subtle">
        Answered by tier <Badge className="ml-1">{answer.tier}</Badge>
      </p>
    </div>
  );
}
