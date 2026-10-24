"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, CheckCheck, Inbox as InboxIcon, Lock, Mail, Pencil } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ApprovalDetail, type Approval, type Decision } from "@/components/approvals/approval-detail";
import { useCanSendEmail, useNoMailbox } from "@/components/approvals/use-send-channels";
import { inboxKey, useInbox } from "@/components/shell/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog } from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { bulkSkipReason, expiresSoonHours, nextPendingId, splitBulk } from "@/lib/inbox";
import { toggled } from "@/lib/selection";
import { actionLabel } from "@/lib/wording";

function ActionIcon({ action }: { action: string }) {
  const I = action === "gmail.send" ? Mail : action.startsWith("calendar") ? CalendarClock : Pencil;
  return <I className="h-4 w-4" aria-hidden />;
}

/** How long the decision stays on screen before the next draft opens by itself. */
const ADVANCE_MS = 1500;

function decideOne(a: Approval, body: Decision) {
  return unwrap(
    api.POST("/ventures/{venture_id}/approvals/{approval_id}/decision", {
      params: { path: { venture_id: a.venture_id, approval_id: a.id } },
      body,
    }),
  );
}

function InboxView() {
  const inbox = useInbox();
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const selectedId = params.get("id");
  // Decided approvals leave the pending list; keep them visible in the detail pane.
  const [decided, setDecided] = useState<Record<string, Approval>>({});
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);

  const items = useMemo(() => (inbox.data ?? []).filter((a) => !decided[a.id]), [inbox.data, decided]);
  const selected = (selectedId && (items.find((a) => a.id === selectedId) ?? decided[selectedId])) || null;
  const stopAdvance = () => {
    if (advance.current) clearTimeout(advance.current);
    advance.current = null;
  };
  useEffect(() => stopAdvance, []);
  // Opening a draft adds a history entry, so Back returns to the list (round 3, A16).
  const select = (id: string | null) => {
    stopAdvance();
    router.push(id ? `/inbox?id=${id}` : "/inbox", { scroll: false });
  };

  // The customer's own message is only on the single card (round 3, A5).
  const single = useQuery({
    queryKey: ["approval", selected?.venture_id, selected?.id],
    queryFn: () =>
      unwrap(api.GET("/ventures/{venture_id}/approvals/{approval_id}", { params: { path: { venture_id: selected!.venture_id, approval_id: selected!.id } } })),
    enabled: Boolean(selected && selected.status === "pending" && selected.can_decide && !selected.redacted),
    staleTime: 60_000,
    retry: false,
  });
  const shown = selected && single.data?.id === selected.id ? { ...selected, they_wrote: single.data.they_wrote, they_wrote_from: single.data.they_wrote_from } : selected;
  const canSendEmail = useCanSendEmail(selected?.venture_id, selected?.action === "gmail.send");

  const emailVentures = useMemo(() => [...new Set(items.filter((a) => a.action === "gmail.send").map((a) => a.venture_id))].sort(), [items]);
  const noMailbox = useNoMailbox(emailVentures);
  const bulkable = items.filter((a) => !bulkSkipReason(a, noMailbox));
  const bulk = splitBulk(items, checked, noMailbox);
  const allChecked = bulkable.length > 0 && bulkable.every((a) => checked.has(a.id));

  const afterDecision = (id: string, out: Approval) => {
    setDecided((d) => ({ ...d, [id]: out }));
    void qc.invalidateQueries({ queryKey: inboxKey });
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const approveSelected = async () => {
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const a of bulk.approve) {
      try {
        afterDecision(a.id, await decideOne(a, { decision: "approve" }));
        ok++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setConfirmBulk(false);
    setChecked(new Set());
    if (failed) toast.error(`${ok} approved, ${failed} couldn't be`, "Open the ones still waiting to see why.");
    else toast.success(`${ok} approved`, "Each one goes out as drafted.");
  };

  return (
    <>
      <PageHeader
        title="Approval inbox"
        description="Every email, invite and purchase order an agent drafts waits here. Approve, edit or reject — agents earn autonomy from clean approvals."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(18rem,24rem)_1fr]">
        <Card className={cn("overflow-hidden", selected && "hidden lg:block")}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="flex items-center gap-2.5">
              {bulkable.length ? (
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border-strong accent-[var(--accent)]"
                  aria-label="Select every draft that can be approved together"
                  checked={allChecked}
                  onChange={(e) => setChecked(e.target.checked ? new Set(bulkable.map((a) => a.id)) : new Set())}
                />
              ) : null}
              <h2 className="text-sm font-semibold">Pending</h2>
            </span>
            <span className="text-xs text-subtle tabular-nums">{items.length}</span>
          </div>
          {checked.size ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/60 px-4 py-2">
              <span className="text-xs text-muted">{checked.size} selected</span>
              <span className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
                  Clear
                </Button>
                <Button size="sm" variant="primary" icon={<CheckCheck className="h-4 w-4" />} disabled={!bulk.approve.length} onClick={() => setConfirmBulk(true)}>
                  Approve selected
                </Button>
              </span>
            </div>
          ) : null}
          {inbox.isPending ? (
            <SkeletonRows rows={6} />
          ) : inbox.isError ? (
            <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState icon={InboxIcon} title="Nothing waiting on you" description="New drafts from agents appear here for review." />
          ) : (
            <ul className="max-h-[calc(100dvh-14rem)] divide-y divide-border overflow-y-auto" aria-label="Pending approvals">
              {items.map((a) => {
                const why = bulkSkipReason(a, noMailbox);
                const hours = expiresSoonHours(a.expires_at);
                return (
                  <li key={a.id} className={cn("flex items-start gap-1 pl-4 transition-colors hover:bg-surface-2", a.id === selectedId && "bg-accent-soft/60")}>
                    {a.can_decide ? (
                      <input
                        type="checkbox"
                        className="mt-3.5 h-4 w-4 shrink-0 rounded border-border-strong accent-[var(--accent)] disabled:opacity-40"
                        aria-label={`Select ${a.title}`}
                        title={why ?? undefined}
                        disabled={Boolean(why)}
                        checked={checked.has(a.id) && !why}
                        onChange={(e) => setChecked((s) => toggled(s, a.id, e.target.checked))}
                      />
                    ) : (
                      <span className="w-4 shrink-0" aria-hidden />
                    )}
                    <button
                      type="button"
                      onClick={() => select(a.id)}
                      aria-current={a.id === selectedId ? "true" : undefined}
                      className="flex min-w-0 flex-1 gap-3 py-3 pr-4 pl-2 text-left"
                    >
                      <span className="mt-0.5 text-subtle">
                        <ActionIcon action={a.action} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{a.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
                          <span>{actionLabel(a.action)}</span>
                          <span aria-hidden>·</span>
                          <span>{a.venture_name}</span>
                          <span aria-hidden>·</span>
                          <span>{formatRelative(a.created_at)}</span>
                          {hours !== null ? (
                            <span className="font-medium text-danger">{hours < 1 ? "expires within the hour" : `expires in ${hours}h`}</span>
                          ) : null}
                          {a.sensitive ? <Lock className="h-3 w-3 text-danger" aria-label="sensitive" /> : null}
                          {!a.can_decide ? <Badge className="h-4 px-1.5 text-[10px]">view only</Badge> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card className={cn("min-h-[24rem] p-4 sm:p-6", !selected && "hidden lg:block")}>
          {shown ? (
            <>
              <Button variant="ghost" size="sm" className="mb-3 -ml-2 lg:hidden" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => select(null)}>
                All approvals
              </Button>
              <ApprovalDetail
                key={shown.id}
                approval={shown}
                canSendEmail={canSendEmail}
                onDecide={async (body) => {
                  const current = shown;
                  const out = await decideOne(current, body);
                  const next = nextPendingId(items, current.id, new Set(Object.keys(decided)));
                  afterDecision(current.id, { ...current, ...out });
                  // Then the next draft opens by itself (round 3, A6); a click anywhere in the list cancels it.
                  if (next) {
                    toast.success(body.decision === "reject" ? "Rejected" : "Approved", "Opening the next draft.");
                    stopAdvance();
                    advance.current = setTimeout(() => {
                      advance.current = null;
                      router.replace(`/inbox?id=${next}`, { scroll: false });
                    }, ADVANCE_MS);
                  }
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
      <ConfirmDialog
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={() => void approveSelected()}
        loading={bulkBusy}
        danger={false}
        title={`Approve ${bulk.approve.length} draft${bulk.approve.length === 1 ? "" : "s"}?`}
        description="Each one is sent exactly as drafted, the same as pressing Approve on it."
        confirmLabel="Approve them"
      >
        {bulk.skipped.length ? (
          <div className="space-y-1 text-sm text-muted">
            <p>Left for you to open one by one:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {bulk.skipped.map(({ item, reason }) => (
                <li key={item.id}>
                  <span className="text-fg">{item.title}</span> — {reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </ConfirmDialog>
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
