"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Switch, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

const SCHEDULED = new Set(["kitchen_daily"]);

export function parseSettingsJson(text: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!text.trim()) return { value: {}, error: null };
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { value: null, error: "Settings must be a JSON object, e.g. {\"gst_pct\": 18}" };
    if (JSON.stringify(v).length > 20000) return { value: null, error: "Settings are too large (20 KB max)" };
    return { value: v as Record<string, unknown>, error: null };
  } catch (e) {
    return { value: null, error: `Invalid JSON: ${(e as Error).message}` };
  }
}

function WorkflowRow({ wf, config, ventureId, canAdmin }: { wf: Schemas["WorkflowOut"]; config?: Schemas["WorkflowConfigOut"]; ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [schedule, setSchedule] = useState(config?.schedule ?? (SCHEDULED.has(wf.name) ? "23:30" : ""));
  const [text, setText] = useState(JSON.stringify(config?.settings ?? {}, null, 2));
  useEffect(() => {
    setEnabled(config?.enabled ?? false);
    setSchedule(config?.schedule ?? (SCHEDULED.has(wf.name) ? "23:30" : ""));
    setText(JSON.stringify(config?.settings ?? {}, null, 2));
  }, [config, wf.name]);
  const parsed = parseSettingsJson(text);
  const schedErr = schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule) ? "HH:MM (24-hour, IST)" : null;
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/workflow-configs/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: wf.name } },
          body: { enabled, schedule: schedule || null, settings: parsed.value ?? {} },
        }),
      ),
    onSuccess: () => {
      toast.success(`${wf.title} saved`);
      void qc.invalidateQueries({ queryKey: ["workflow-configs", ventureId] });
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });
  return (
    <li className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{wf.title}</h3>
            <Badge className="font-mono">{wf.name}</Badge>
            {config ? <span className="text-xs text-subtle">updated {formatRelative(config.updated_at)}</span> : <Badge tone="warning">not configured</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">{wf.description}</p>
          <p className="mt-1 text-xs text-subtle">Steps: {wf.steps.map((s) => s.name).join(" → ")}</p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label={`Enable ${wf.title}`} disabled={!canAdmin} />
      </div>
      <div className="grid gap-3 md:grid-cols-[10rem_1fr]">
        <Field label="Daily at (IST)" error={schedErr} hint={SCHEDULED.has(wf.name) ? "Nightly run time" : "Optional"}>
          <Input type="time" value={schedule} disabled={!canAdmin} onChange={(e) => setSchedule(e.target.value)} />
        </Field>
        <Field label="Settings (JSON)" error={parsed.error} hint="Overrides the workflow's defaults, e.g. gst_pct, min_budget_inr, safety_stock_pct">
          <Textarea rows={Math.min(10, Math.max(3, text.split("\n").length))} value={text} disabled={!canAdmin} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" spellCheck={false} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" disabled={!canAdmin || Boolean(parsed.error) || Boolean(schedErr)} loading={save.isPending} onClick={() => save.mutate()} aria-label={`Save ${wf.title}`}>
          Save
        </Button>
      </div>
    </li>
  );
}

export function WorkflowSettings({ ventureId, kind, canAdmin }: { ventureId: string; kind: string; canAdmin: boolean }) {
  const catalogue = useQuery({ queryKey: ["workflows"], queryFn: () => unwrap(api.GET("/workflows")), staleTime: 10 * 60_000 });
  const configs = useQuery({
    queryKey: ["workflow-configs", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: ventureId } } })),
  });
  if (catalogue.isPending || configs.isPending) return <SkeletonRows />;
  if (catalogue.isError) return <ErrorState error={catalogue.error} />;
  if (configs.isError) return <ErrorState error={configs.error} />;
  const list = catalogue.data.filter((w) => w.venture_kinds.includes(kind) || configs.data.some((c) => c.workflow === w.name));
  return (
    <Card>
      {!canAdmin ? (
        <Notice tone="info" className="m-3">
          Only a venture admin or owner can change workflows.
        </Notice>
      ) : null}
      <ul className="divide-y divide-border">
        {list.map((w) => (
          <WorkflowRow key={w.name} wf={w} config={configs.data.find((c) => c.workflow === w.name)} ventureId={ventureId} canAdmin={canAdmin} />
        ))}
      </ul>
    </Card>
  );
}
