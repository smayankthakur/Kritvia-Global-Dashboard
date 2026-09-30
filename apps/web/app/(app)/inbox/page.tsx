"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, Inbox as InboxIcon, Lock, Mail, Pencil } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ApprovalDetail, type Approval } from "@/components/approvals/approval-detail";
import { inboxKey, useInbox } from "@/components/shell/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/format";

function ActionIcon({ action }: { action: string }) {
  const I = action === "gmail.send" ? Mail : action.startsWith("calendar") ? CalendarClock : Pencil;
  return <I className="h-4 w-4" aria-hidden />;
}

function InboxView() {
  const inbox = useInbox();
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get("id");
  // Decided approvals leave the pending list; keep them visible in the detail pane.
  const [decided, setDecided] = useState<Record<string, Approval>>({});

  const items = inbox.data ?? [];
  const selected = (selectedId && (items.find((a) => a.id === selectedId) ?? decided[selectedId])) || null;
  const select = (id: string | null) => router.replace(id ? `/inbox?id=${id}` : "/inbox", { scroll: false });

  return (
    <>
      <PageHeader
        title="Approval inbox"
        description="Every email, invite and purchase order an agent drafts waits here. Approve, edit or reject — agents earn autonomy from clean approvals."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(18rem,24rem)_1fr]">
        <Card className={cn("overflow-hidden", selected && "hidden lg:block")}>
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">Pending</h2>
            <span className="text-xs text-subtle tabular-nums">{items.length}</span>
          </div>
          {inbox.isPending ? (
            <SkeletonRows rows={6} />
          ) : inbox.isError ? (
            <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={InboxIcon} title="Nothing waiting on you" description="New drafts from agents appear here for review." />
          ) : (
            <ul className="max-h-[calc(100dvh-14rem)] divide-y divide-border overflow-y-auto" aria-label="Pending approvals">
              {items.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => select(a.id)}
                    aria-current={a.id === selectedId ? "true" : undefined}
                    className={cn(
                      "flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2",
                      a.id === selectedId && "bg-accent-soft/60",
                    )}
                  >
                    <span className="mt-0.5 text-subtle">
                      <ActionIcon action={a.action} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
                        <span>{a.venture_name}</span>
                        <span aria-hidden>·</span>
                        <span>{formatRelative(a.created_at)}</span>
                        {a.sensitive ? <Lock className="h-3 w-3 text-danger" aria-label="sensitive" /> : null}
                        {!a.can_decide ? <Badge className="h-4 px-1.5 text-[10px]">view only</Badge> : null}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className={cn("min-h-[24rem] p-4 sm:p-6", !selected && "hidden lg:block")}>
          {selected ? (
            <>
              <Button variant="ghost" size="sm" className="mb-3 -ml-2 lg:hidden" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => select(null)}>
                All approvals
              </Button>
              <ApprovalDetail
                key={selected.id}
                approval={selected}
                onDecide={async (body) => {
                  const out = await unwrap(
                    api.POST("/ventures/{venture_id}/approvals/{approval_id}/decision", {
                      params: { path: { venture_id: selected.venture_id, approval_id: selected.id } },
                      body,
                    }),
                  );
                  setDecided((d) => ({ ...d, [out.id]: { ...selected, ...out } }));
                  void qc.invalidateQueries({ queryKey: inboxKey });
                  void qc.invalidateQueries({ queryKey: ["dashboard"] });
                  return out;
                }}
                onConflict={() => void qc.invalidateQueries({ queryKey: inboxKey })}
              />
            </>
          ) : (
            <EmptyState icon={InboxIcon} title="Select a draft" description="Pick an item on the left to review what the agent wants to send." />
          )}
        </Card>
      </div>
    </>
  );
}

export default function InboxPage() {
  return (
    <Suspense>
      <InboxView />
    </Suspense>
  );
}
