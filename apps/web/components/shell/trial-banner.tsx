"use client";

import { useQuery } from "@tanstack/react-query";
import { Clock, Lock } from "lucide-react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { useAccess } from "@/lib/access";
import { api, unwrap } from "@/lib/api";
import { trialNeedsAttention, trialNote, type Trial } from "@/lib/trial";

/**
 * Tells people where their free trial stands: in the last 5 days a gentle reminder, and once it
 * has ended a clear "read-only" notice with the way out. Shares the billing page's plan query.
 */
export function TrialBanner() {
  const { org } = useAccess();
  const plan = useQuery({
    queryKey: ["plan", org?.id],
    queryFn: async () => (await unwrap(api.GET("/orgs/{org_id}/plan", { params: { path: { org_id: org!.id } } }))) as unknown as { trial: Trial | null; read_only: boolean },
    enabled: Boolean(org),
    staleTime: 5 * 60_000,
  });
  const t = plan.data?.trial;
  if (!plan.data || !trialNeedsAttention(t)) return null;
  const ended = plan.data.read_only;
  return (
    <div
      role={ended ? "alert" : "status"}
      className={cn(
        "mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-sm",
        ended ? "border-warning/40 bg-warning-soft text-warning-fg" : "border-info/30 bg-info-soft text-info-fg",
      )}
    >
      {ended ? <Lock className="h-4 w-4 shrink-0" aria-hidden /> : <Clock className="h-4 w-4 shrink-0" aria-hidden />}
      <p className="min-w-0 flex-1">
        {ended ? <strong className="font-semibold">Read-only. </strong> : null}
        {trialNote(t)}
        {ended ? " You can still view, export and delete your data." : null}
      </p>
      <Link href="/billing" className="rounded-md bg-[linear-gradient(180deg,var(--accent),var(--accent-2))] px-3 py-1.5 text-[13px] font-medium text-accent-fg shadow-card hover:brightness-110">
        Choose a plan
      </Link>
    </div>
  );
}
