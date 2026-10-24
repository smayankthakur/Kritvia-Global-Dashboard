"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { api, unwrap } from "@/lib/api";
import { plainError } from "@/lib/wording";

type Finding = { agent: string; level: "fix" | "check" | "idea"; kind: string; text: string; path: string };
type Health = {
  summary: { runs: number; runs_started_by_itself: number; sent_by_itself: number; approved_by_a_person: number; expired: number };
  findings: Finding[];
};

const LEVEL: Record<Finding["level"], { label: string; tone: Tone }> = {
  fix: { label: "Fix", tone: "danger" },
  check: { label: "Needs you", tone: "warning" },
  idea: { label: "Could do more", tone: "info" },
};

/** What Kritvia's own check of this business's agents found in the last 7 days. Kritvia also sends this to the
 *  owners every morning when something new needs them. */
export function AutomationHealth({ ventureId }: { ventureId: string }) {
  const q = useQuery({
    queryKey: ["automation-health", ventureId],
    queryFn: () =>
      unwrap(api.GET("/ventures/{venture_id}/automation-health", { params: { path: { venture_id: ventureId }, query: { days: 7 } } })) as Promise<Health>,
    staleTime: 60_000,
  });
  if (q.isLoading || q.isError || !q.data) return null;
  const h = q.data;
  const order = { fix: 0, check: 1, idea: 2 };
  const findings = [...h.findings].sort((a, b) => order[a.level] - order[b.level]);
  const self = h.summary.runs ? Math.round((100 * h.summary.runs_started_by_itself) / h.summary.runs) : 0;
  return (
    <Card className="mb-6">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Activity className="h-4 w-4 text-subtle" aria-hidden /> Automation check, last 7 days
          </span>
        }
        description={
          h.summary.runs
            ? `${h.summary.runs} runs, ${self}% started by themselves; ${h.summary.approved_by_a_person} drafts approved by a person, ${h.summary.sent_by_itself} sent by themselves, ${h.summary.expired} expired.`
            : "No agent ran in the last 7 days."
        }
      />
      <CardBody className="space-y-2">
        {findings.length ? (
          <ul className="space-y-2" aria-label="What the check found">
            {findings.map((f) => (
              <li key={`${f.agent}-${f.kind}`} className="flex flex-wrap items-start gap-2 text-sm">
                <Badge tone={LEVEL[f.level].tone}>{LEVEL[f.level].label}</Badge>
                <span className="min-w-0 flex-1 text-fg">{plainError(f.text)}</span>
                <Link href={f.path} className="text-xs text-accent hover:underline">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-subtle">Nothing is stuck. Every agent that is on can run.</p>
        )}
        <p className="text-xs text-subtle">Kritvia checks this every morning and tells you when something new needs you.</p>
      </CardBody>
    </Card>
  );
}
