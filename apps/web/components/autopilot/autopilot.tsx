"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Hand, Plane } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { FormError, Switch } from "@/components/ui/field";
import { Stat, StatGrid } from "@/components/ui/stat";
import { SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, unwrap } from "@/lib/api";
import { autopilotKey, autopilotProblem, jobSentence, jobShort, splitJobs, todayNumbers, type Autopilot } from "@/lib/autopilot";

export function useAutopilot(ventureId: string) {
  return useQuery({
    queryKey: autopilotKey(ventureId),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/autopilot", { params: { path: { venture_id: ventureId } } })),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useSwitchAutopilot(ventureId: string, onDone?: (on: boolean) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (on: boolean) => unwrap(api.PUT("/ventures/{venture_id}/autopilot", { params: { path: { venture_id: ventureId } }, body: { on } })),
    onSuccess: (d) => {
      qc.setQueryData(autopilotKey(ventureId), d);
      if (d.on) toast.success("Autopilot is on", "Your agents do the routine work now. Money, complaints and orders still come to you.");
      else toast.success("Autopilot is paused", "Every draft waits for your yes again.");
      onDone?.(d.on);
    },
  });
}

/** What autopilot does by itself on this plan, what needs a bigger plan, and what always asks. */
export function AutopilotCoverage({ data, className }: { data: Autopilot; className?: string }) {
  const { now, later } = splitJobs(data.jobs);
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
      <div>
        <p className="mb-1.5 text-xs font-semibold text-subtle">Does by itself</p>
        <ul className="space-y-1.5 text-sm">
          {now.map((j) => (
            <li key={j.agent} className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
              <span>{jobSentence(j)}</span>
            </li>
          ))}
          {later.map((j) => (
            <li key={j.agent} className="flex items-start gap-2 text-subtle">
              <Check className="mt-0.5 h-4 w-4 shrink-0 opacity-40" aria-hidden />
              <span>
                <span>{jobSentence(j)}</span>{" "}
                <Badge className="ml-1 align-middle">on Starter and up</Badge>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-semibold text-subtle">Still asks you</p>
        <ul className="space-y-1.5 text-sm">
          {data.still_asks.map((s) => (
            <li key={s} className="flex items-start gap-2">
              <Hand className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** "Turn on autopilot?": what it will do by itself and what still asks, before the switch flips. */
export function TurnOnDialog({
  open,
  onClose,
  data,
  onConfirm,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  data: Autopilot | undefined;
  onConfirm: () => void;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Turn on autopilot?"
      description="Your agents do the routine work by themselves. Anything about money, complaints or orders still comes to you first."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" loading={loading} onClick={onConfirm} disabled={!data}>
            Turn on autopilot
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {data ? <AutopilotCoverage data={data} /> : <SkeletonRows rows={3} />}
        <p className="text-xs text-subtle">
          Every evening at 8 pm you get a summary of what the agents did. Reply PAUSE or RESUME from your linked Telegram or WhatsApp to switch autopilot off or on at any time.
        </p>
        <FormError message={error ?? null} />
      </div>
    </Dialog>
  );
}

/** Dashboard panel for one business: a one-tap "Turn on" when off; today's numbers and a pause switch when on. */
export function AutopilotPanel({ ventureId, canAdmin, className }: { ventureId: string; canAdmin: boolean; className?: string }) {
  const q = useAutopilot(ventureId);
  const [asking, setAsking] = useState(false);
  const sw = useSwitchAutopilot(ventureId, () => setAsking(false));
  const problem = sw.isError ? autopilotProblem(sw.error) : null;
  if (!q.data) return null;
  const d = q.data;

  if (!d.on) {
    return (
      <div className={cn("rounded-xl border border-accent/25 bg-accent/5 p-4", className)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
              <Plane className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Let Kritvia run the routine work</p>
              <p className="mt-0.5 text-sm text-muted">
                With autopilot on, agents reply, remind and follow up by themselves. Money, complaints and orders still come to you.
              </p>
            </div>
          </div>
          {canAdmin ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                sw.reset();
                setAsking(true);
              }}
            >
              Turn on autopilot
            </Button>
          ) : (
            <p className="text-xs text-subtle">An owner or admin can turn it on.</p>
          )}
        </div>
        <TurnOnDialog open={asking} onClose={() => setAsking(false)} data={d} onConfirm={() => sw.mutate(true)} loading={sw.isPending} error={problem} />
      </div>
    );
  }

  const n = todayNumbers(d);
  return (
    <div className={cn("rounded-xl border border-success/30 bg-success-soft/40 p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Plane className="h-4 w-4 text-success" aria-hidden />
          <span>Autopilot on</span>
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-subtle">Pause</span>
          <Switch label="Autopilot on" checked disabled={!canAdmin || sw.isPending} onChange={() => sw.mutate(false)} />
        </div>
      </div>
      <StatGrid className="mt-3 grid-cols-3">
        <Stat label="Done by itself today" value={n.done} tone={n.done ? "success" : undefined} />
        <Stat label="Waiting for you" value={n.waiting} tone={n.waiting ? "warning" : undefined} />
        <Stat label="Sent to you today" value={n.sent} />
      </StatGrid>
      {n.byAgent.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Done by itself today">
          {n.byAgent.map(([agent, count]) => (
            <li key={agent}>
              <Badge>
                {jobShort(agent)} · {count}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-accent">What autopilot covers</summary>
        <AutopilotCoverage data={d} className="mt-3" />
      </details>
      <FormError message={problem} />
    </div>
  );
}

/** Settings → General: the same switch, with what it covers. */
export function AutopilotSettings({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const q = useAutopilot(ventureId);
  const [asking, setAsking] = useState(false);
  const sw = useSwitchAutopilot(ventureId, () => setAsking(false));
  const problem = sw.isError ? autopilotProblem(sw.error) : null;
  return (
    <Card>
      <CardHeader
        title="Autopilot"
        description="Agents reply, remind and follow up by themselves. Money, complaints and orders still come to you."
        actions={q.data ? q.data.on ? <Badge tone="success" dot>On</Badge> : <Badge>Off</Badge> : undefined}
      />
      <div className="space-y-4 p-4">
        {q.isPending ? (
          <SkeletonRows rows={2} />
        ) : q.data ? (
          <>
            <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <div className="text-sm font-medium">Let agents do routine work by themselves</div>
                <p className="mt-0.5 text-xs text-subtle">
                  Off: every draft waits for your yes. You can also reply PAUSE or RESUME from your linked Telegram or WhatsApp.
                </p>
              </div>
              <Switch
                label="Let agents do routine work by themselves"
                checked={q.data.on}
                disabled={!canAdmin || sw.isPending}
                onChange={(on) => {
                  sw.reset();
                  if (on) setAsking(true);
                  else sw.mutate(false);
                }}
              />
            </div>
            <AutopilotCoverage data={q.data} />
            {!canAdmin ? <p className="text-xs text-subtle">Only an owner or admin of this business can switch autopilot.</p> : null}
            <FormError message={asking ? null : problem} />
            <TurnOnDialog open={asking} onClose={() => setAsking(false)} data={q.data} onConfirm={() => sw.mutate(true)} loading={sw.isPending} error={problem} />
          </>
        ) : (
          <p className="text-sm text-subtle">Autopilot settings couldn&apos;t be loaded. They&apos;ll show here when the connection is back.</p>
        )}
      </div>
    </Card>
  );
}
