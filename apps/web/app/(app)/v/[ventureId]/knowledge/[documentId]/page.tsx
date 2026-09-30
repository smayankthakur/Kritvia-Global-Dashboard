"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Lock, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog } from "@/components/ui/dialog";
import { KeyValue, Notice, PageHeader } from "@/components/ui/page";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, downloadFile, errorMessage, unwrap } from "@/lib/api";
import { formatBytes, formatDate, formatDateTime, formatTimestamp, titleCase } from "@/lib/format";
import { useVenture } from "@/lib/venture";

function DocumentView() {
  const v = useVenture();
  const { documentId } = useParams<{ documentId: string }>();
  const chunk = useSearchParams().get("chunk");
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const doc = useQuery({
    queryKey: ["documents", v.id, "detail", documentId, chunk],
    queryFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/documents/{document_id}", {
          params: { path: { venture_id: v.id, document_id: documentId }, query: { chunk_id: chunk ?? undefined } },
        }),
      ),
    staleTime: 60_000,
  });
  const facts = useQuery({
    queryKey: ["facts", v.id, "doc", documentId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/facts", { params: { path: { venture_id: v.id }, query: { document_id: documentId, limit: 200 } } })),
  });
  const del = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/documents/{document_id}", { params: { path: { venture_id: v.id, document_id: documentId } } })),
    onSuccess: () => {
      toast.success("Document deleted", "Its chunks, facts and links were removed.");
      void qc.invalidateQueries({ queryKey: ["documents", v.id] });
      router.push(`/v/${v.id}/knowledge`);
    },
    onError: (e) => toast.error("Could not delete", errorMessage(e)),
  });

  useEffect(() => {
    if (!chunk || !doc.data) return;
    const el = document.getElementById(`chunk-${chunk}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.focus({ preventScroll: true });
    }
  }, [chunk, doc.data]);

  if (doc.isPending)
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-96" />
      </div>
    );
  if (doc.isError) return <ErrorState error={doc.error} onRetry={() => void doc.refetch()} />;
  const d = doc.data;
  const meta = (d.meta ?? {}) as Record<string, unknown>;
  const isTranscript = d.kind === "transcript" || d.chunks.some((c) => c.start_s !== null);

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/v/${v.id}/knowledge`} className="hover:text-accent">
            ← Knowledge
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            {d.sensitive ? <Lock className="h-4 w-4 text-danger" aria-label="sensitive" /> : null}
            {d.title}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge>{d.kind}</Badge> <StatusBadge status={d.status} /> added {formatDateTime(d.created_at)}
          </span>
        }
        actions={
          <>
            <Button
              icon={<Download className="h-4 w-4" />}
              loading={downloading}
              onClick={async () => {
                setDownloading(true);
                try {
                  await downloadFile(`/ventures/${v.id}/documents/${d.id}/raw`, (meta.filename as string) ?? d.title);
                } catch (e) {
                  toast.error("Download failed", errorMessage(e));
                } finally {
                  setDownloading(false);
                }
              }}
            >
              Download original
            </Button>
            <Button variant="ghost" className="text-danger hover:text-danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </>
        }
      />
      {d.error ? (
        <Notice tone="danger" title="Processing error" className="mb-4">
          {d.error}
        </Notice>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader title={isTranscript ? "Transcript" : "Content"} description={`${d.chunks.length} chunk(s)${chunk ? " · cited passage highlighted" : ""}`} />
          {d.chunks.length ? (
            <ol className="divide-y divide-border">
              {d.chunks.map((c) => (
                <li
                  key={c.id}
                  id={`chunk-${c.id}`}
                  tabIndex={-1}
                  className={cn("scroll-mt-24 px-4 py-3 focus:outline-none", c.id === chunk && "chunk-highlight border-l-2 border-l-accent bg-accent-soft/30")}
                  aria-current={c.id === chunk ? "true" : undefined}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-subtle">
                    <span className="font-mono">#{c.ord + 1}</span>
                    {c.page ? <span>page {c.page}</span> : null}
                    {c.start_s !== null ? (
                      <span className="font-mono">
                        {formatTimestamp(c.start_s)}
                        {c.end_s !== null ? `–${formatTimestamp(c.end_s)}` : ""}
                      </span>
                    ) : null}
                    {c.speaker ? <Badge tone="info">{c.speaker}</Badge> : null}
                  </div>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{c.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-4 py-6 text-sm text-subtle">No extracted text{d.status !== "ready" ? " yet" : ""}.</p>
          )}
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <div className="p-4">
              <KeyValue
                items={[
                  ["Type", d.mime ?? "—"],
                  ["Size", formatBytes(d.size_bytes)],
                  ["Sensitive", d.sensitive ? <Badge tone="danger">yes — local models only</Badge> : "no"],
                  ["Access", d.access_roles?.length ? d.access_roles.map(titleCase).join(", ") : "Everyone in the venture"],
                  ["PII found", d.pii_tags.length ? <span className="flex flex-wrap gap-1">{d.pii_tags.map((t) => <Badge key={t} tone="warning">{t}</Badge>)}</span> : "none"],
                  ["Delete after", d.delete_after ? formatDate(d.delete_after) : "no retention deadline"],
                  ["Source", d.source_uri ? <a className="break-all text-accent hover:underline" href={d.source_uri} target="_blank" rel="noopener noreferrer">{d.source_uri}</a> : "uploaded"],
                  ...(typeof meta.transcript_document_id === "string"
                    ? ([["Transcript", <Link key="t" className="text-accent hover:underline" href={`/v/${v.id}/knowledge/${meta.transcript_document_id}`}>Open transcript</Link>]] as [string, React.ReactNode][])
                    : []),
                  ...(typeof meta.meeting_document_id === "string"
                    ? ([["Recording", <Link key="m" className="text-accent hover:underline" href={`/v/${v.id}/knowledge/${meta.meeting_document_id}`}>Open recording</Link>]] as [string, React.ReactNode][])
                    : []),
                ]}
              />
            </div>
          </Card>
          <Card>
            <CardHeader title="Decisions & tasks" description="Extracted from this document" />
            {facts.isPending ? (
              <Skeleton className="m-4 h-16" />
            ) : facts.data?.length ? (
              <ul className="divide-y divide-border">
                {facts.data.map((f) => (
                  <li key={f.id} className="px-4 py-2.5 text-sm">
                    <div className="mb-0.5 flex items-center gap-1.5">
                      <Badge tone={f.kind === "decision" ? "accent" : f.kind === "task" ? "info" : "neutral"}>{f.kind}</Badge>
                      {f.status ? <StatusBadge status={f.status} /> : null}
                    </div>
                    <p>{f.statement}</p>
                    <Link href={`/v/${v.id}/knowledge/${documentId}?chunk=${f.chunk_id}`} className="text-xs text-accent hover:underline" scroll={false}>
                      {f.source_start_s !== null ? `at ${formatTimestamp(f.source_start_s)}` : "show source"}
                      {f.owner ? ` · ${f.owner}` : ""}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-subtle">None extracted.</p>
            )}
          </Card>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => del.mutate()}
        loading={del.isPending}
        title="Delete this document?"
        description="The file, its chunks and every fact and relationship derived from it are removed. This is recorded in the audit log."
        confirmLabel="Delete document"
      />
    </>
  );
}

export default function DocumentPage() {
  return (
    <Suspense>
      <DocumentView />
    </Suspense>
  );
}
