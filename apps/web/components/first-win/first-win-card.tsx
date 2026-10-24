"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, PartyPopper, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";

const HIDE = (v: string) => `kv-first-win-hidden:${v}`;

function hidden(ventureId: string): boolean {
  try {
    return window.localStorage.getItem(HIDE(ventureId)) === "1";
  } catch {
    return false;
  }
}

/** "Your first win in 10 minutes": a short checklist on the dashboard until the business is set up. */
export function FirstWinCard({ ventureId, ventureName, canWrite }: { ventureId: string; ventureName: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [hide, setHide] = useState(true);
  useEffect(() => setHide(hidden(ventureId)), [ventureId]);
  const key = ["first-win", ventureId] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/first-win", { params: { path: { venture_id: ventureId } } })),
    refetchInterval: (query) => (query.state.data && query.state.data.won_at ? false : 15_000),
  });
  const practice = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/first-win/practice", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (out) => {
      toast.success("A practice customer just wrote in", `The draft reply will be in your Inbox in a few seconds. It's addressed to ${out.reply_to}.`);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Couldn't send the practice message", errorMessage(e)),
  });

  if (hide || !q.data) return null;
  const d = q.data;
  const required = d.steps.filter((s) => !s.optional);
  if (required.every((s) => s.done)) return null;
  const next = d.steps.find((s) => !s.done);
  const dismiss = () => {
    try {
      window.localStorage.setItem(HIDE(ventureId), "1");
    } catch {
      /* private mode: hidden for this visit only */
    }
    setHide(true);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {d.won_at ? <PartyPopper className="h-4 w-4 text-success" aria-hidden /> : <Sparkles className="h-4 w-4 text-accent" aria-hidden />}
            {d.won_at ? `First win: ${d.minutes_to_win} minutes from sign-up` : `Your first win in 10 minutes · ${ventureName}`}
          </span>
        }
        description={
          d.won_at
            ? "Kritvia drafted and you approved. A few more steps and it runs on its own."
            : "Six short steps to your first approved reply. Until you switch on autopilot, nothing goes out without your yes."
        }
        actions={
          <Button variant="ghost" size="sm" aria-label="Hide this checklist" icon={<X className="h-4 w-4" />} onClick={dismiss}>
            Hide
          </Button>
        }
      />
      <div className="px-4 pb-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.done} aria-label={`${d.done} of ${d.total} steps done`}>
          <div className="h-full bg-success transition-[width]" style={{ width: `${(d.done / d.total) * 100}%` }} />
        </div>
      </div>
      <ol className="divide-y divide-border">
        {d.steps.map((s) => (
          <li key={s.id} className={cn("flex items-start gap-3 px-4 py-3", s.id === next?.id && "bg-accent-soft/40")}>
            {s.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-subtle" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium", s.done && "text-muted line-through decoration-1")}>
                {s.title}
                {s.optional ? <span className="ml-1 text-xs font-normal text-subtle">(optional)</span> : null}
                <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
              </p>
              {!s.done ? <p className="text-xs text-muted">{s.detail}</p> : null}
            </div>
            {!s.done ? (
              s.id === "draft" && canWrite ? (
                <Button size="sm" variant={s.id === next?.id ? "primary" : "secondary"} loading={practice.isPending} onClick={() => practice.mutate()}>
                  Send a practice message
                </Button>
              ) : (
                <ButtonLink size="sm" variant={s.id === next?.id ? "primary" : "secondary"} href={s.href}>
                  {s.id === "yes" ? "Open Inbox" : "Do it"}
                </ButtonLink>
              )
            ) : null}
          </li>
        ))}
      </ol>
      {d.steps.find((s) => s.id === "draft")?.done && !d.won_at ? (
        <p className="px-4 pb-3 text-xs text-muted">
          Your draft is waiting in the{" "}
          <Link href="/inbox" className="font-medium underline underline-offset-2">
            Inbox
          </Link>
          .
        </p>
      ) : null}
    </Card>
  );
}
