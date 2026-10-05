"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, Field, Input, Switch, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

/** Agents that run on a daily clock: the time they run, and how the field is labelled. */
const SCHEDULED: Record<string, { at: string; label: string }> = {
  kitchen_daily: { at: "23:30", label: "Runs every night at (IST)" },
  prospector: { at: "10:30", label: "Finds leads and sends messages every day at (IST)" },
};
const INSTRUCTION_HINTS: Record<string, string> = {
  inbox_assistant: "e.g. Reply in Hinglish. Delivery takes 3–5 days. Never quote prices; say we will share a quote.",
  lead_triage: "e.g. We only take projects above ₹1 lakh. Always mention our 2-week pilot offer.",
  loan_verification: "e.g. Salaried applicants need 3 salary slips; self-employed need 2 years of ITR.",
  kitchen_daily: "e.g. Buy paneer only from Amul distributor. Keep 20% extra on weekends.",
  prospector: "e.g. Mention we built the site for Annapurna Rasoi. Skip hotels and big chains. Offer a free demo page.",
};

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

type Option = Schemas["OptionOut"];

/** Settings the option form owns; everything else stays in "advanced" JSON untouched. */
export function splitSettings(settings: Record<string, unknown>, options: Option[]) {
  const keys = new Set(options.map((o) => o.key));
  const form: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) (keys.has(k) ? form : rest)[k] = v;
  return { form, rest };
}

/** Form values → settings: unchanged defaults are dropped so the JSON stays small; numbers are validated. */
export function optionValues(form: Record<string, unknown>, options: Option[]): { settings: Record<string, unknown>; errors: Record<string, string> } {
  const settings: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const o of options) {
    const raw = form[o.key];
    if (raw === undefined || raw === "" || raw === null) continue;
    if (o.type === "number") {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) errors[o.key] = "Enter a number";
      else if (o.min != null && n < o.min) errors[o.key] = `At least ${o.min}`;
      else if (o.max != null && n > o.max) errors[o.key] = `At most ${o.max}`;
      else if (n !== o.default) settings[o.key] = n;
    } else if (o.type === "boolean") {
      if (Boolean(raw) !== Boolean(o.default)) settings[o.key] = Boolean(raw);
    } else if (String(raw) !== String(o.default)) settings[o.key] = String(raw).slice(0, 500);
  }
  return { settings, errors };
}

function OptionField({ o, value, error, disabled, onChange }: { o: Option; value: unknown; error?: string; disabled: boolean; onChange: (v: unknown) => void }) {
  if (o.type === "boolean") {
    return <Checkbox label={o.label} hint={o.help || undefined} checked={value === undefined ? Boolean(o.default) : Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  }
  // Long text (a list of searches, a one-line pitch) gets the full row.
  const wide = o.type === "text" && (String(o.default ?? "").length > 30 || (o.help ?? "").length > 70);
  return (
    <Field label={o.label} hint={o.help || undefined} error={error} className={wide ? "sm:col-span-2" : "max-w-xs"}>
      <Input
        type={o.type === "number" ? "number" : "text"}
        value={value === undefined ? String(o.default ?? "") : String(value)}
        min={o.min ?? undefined}
        max={o.max ?? undefined}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

function AgentRow({ wf, config, ventureId, canAdmin }: { wf: Schemas["WorkflowOut"]; config?: Schemas["WorkflowConfigOut"]; ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const initial = splitSettings((config?.settings as Record<string, unknown>) ?? {}, wf.options);
  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [schedule, setSchedule] = useState(config?.schedule ?? SCHEDULED[wf.name]?.at ?? "");
  const [instructions, setInstructions] = useState(config?.instructions ?? "");
  const [form, setForm] = useState<Record<string, unknown>>(initial.form);
  const [advanced, setAdvanced] = useState(false);
  const [text, setText] = useState(JSON.stringify(initial.rest, null, 2));
  useEffect(() => {
    const s = splitSettings((config?.settings as Record<string, unknown>) ?? {}, wf.options);
    setEnabled(config?.enabled ?? false);
    setSchedule(config?.schedule ?? SCHEDULED[wf.name]?.at ?? "");
    setInstructions(config?.instructions ?? "");
    setForm(s.form);
    setText(JSON.stringify(s.rest, null, 2));
  }, [config, wf.name, wf.options]);
  const parsed = parseSettingsJson(text);
  const opts = optionValues(form, wf.options);
  const schedErr = schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule) ? "HH:MM (24-hour, IST)" : null;
  const invalid = Boolean(parsed.error) || Boolean(schedErr) || Object.keys(opts.errors).length > 0 || instructions.length > 4000;
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/workflow-configs/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: wf.name } },
          body: { enabled, schedule: schedule || null, settings: { ...(parsed.value ?? {}), ...opts.settings }, instructions },
        }),
      ),
    onSuccess: () => {
      toast.success(`${wf.title} saved`);
      void qc.invalidateQueries({ queryKey: ["workflow-configs", ventureId] });
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });
  return (
    <li className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{wf.title}</h3>
            {config ? (
              <Badge tone={config.enabled ? "success" : "neutral"}>{config.enabled ? "On" : "Off"}</Badge>
            ) : (
              <Badge tone="warning">Not set up</Badge>
            )}
            {config ? <span className="text-xs text-subtle">updated {formatRelative(config.updated_at)}</span> : null}
          </div>
          <p className="mt-1 text-sm text-muted">{wf.description}</p>
          <p className="mt-1 text-xs text-subtle">
            <span className="inline-flex items-center gap-1">
              <Play className="h-3 w-3" aria-hidden /> Runs: {wf.trigger}
            </span>
          </p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label={`Enable ${wf.title}`} disabled={!canAdmin} />
      </div>
      <Field
        label="Instructions for this agent"
        hint={`${INSTRUCTION_HINTS[wf.name] ?? "Plain language; the agent follows these on every run."} (${instructions.length}/4000)`}
        error={instructions.length > 4000 ? "Too long" : undefined}
      >
        <Textarea rows={3} value={instructions} disabled={!canAdmin} maxLength={4000} onChange={(e) => setInstructions(e.target.value)} placeholder="Anything the agent should always know or do" />
      </Field>
      {wf.options.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {wf.options.map((o) => (
            <OptionField key={o.key} o={o} value={form[o.key]} error={opts.errors[o.key]} disabled={!canAdmin} onChange={(v) => setForm((f) => ({ ...f, [o.key]: v }))} />
          ))}
        </div>
      ) : null}
      {SCHEDULED[wf.name] ? (
        <Field label={SCHEDULED[wf.name]!.label} error={schedErr} className="max-w-xs">
          <Input type="time" value={schedule} disabled={!canAdmin} onChange={(e) => setSchedule(e.target.value)} />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="inline-flex items-center gap-1 text-xs text-subtle hover:text-fg" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          <ChevronDown className={advanced ? "h-3.5 w-3.5 rotate-180 transition-transform" : "h-3.5 w-3.5 transition-transform"} aria-hidden />
          Advanced
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {wf.name === "prospector" && config?.enabled ? <RunNow ventureId={ventureId} disabled={!canAdmin} /> : null}
          <Button variant="primary" size="sm" disabled={!canAdmin || invalid} loading={save.isPending} onClick={() => save.mutate()} aria-label={`Save ${wf.title}`}>
            Save
          </Button>
        </div>
      </div>
      {wf.name === "prospector" ? (
        <p className="text-xs text-subtle">
          Emails go from your connected Gmail. WhatsApp only lets a business message someone first from its own phone, so first
          WhatsApp messages wait in Leads for you to send with one tap. Every message offers a way to opt out, and a reply stops
          the follow-ups. Calls are yours for now: the lead shows the number and you log the call.
        </p>
      ) : null}
      {advanced ? (
        <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-3">
          {!SCHEDULED[wf.name] ? (
            <Field label="Also run daily at (IST)" error={schedErr} hint="Optional" className="max-w-[10rem]">
              <Input type="time" value={schedule} disabled={!canAdmin} onChange={(e) => setSchedule(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Extra settings (JSON)" error={parsed.error} hint="For settings without a field above, e.g. gmail_query, source_weights.">
            <Textarea rows={Math.min(8, Math.max(2, text.split("\n").length))} value={text} disabled={!canAdmin} onChange={(e) => setText(e.target.value)} className="font-mono text-xs" spellCheck={false} />
          </Field>
          <p className="text-xs text-subtle">Steps: {wf.steps.map((s) => s.name).join(" → ")}</p>
        </div>
      ) : null}
    </li>
  );
}

/** Runs the Prospector now instead of waiting for its daily time, then shows the run working. */
function RunNow({ ventureId, disabled }: { ventureId: string; disabled: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const run = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/runs", { params: { path: { venture_id: ventureId } }, body: { workflow: "prospector", input: {}, title: "Find leads now" } })),
    onSuccess: (r) => {
      toast.success("Prospector started", "New prospects and their messages appear in Leads as it works.");
      router.push(`/v/${ventureId}/runs/${r.id}`);
    },
    onError: (e) => toast.error("Could not start", errorMessage(e)),
  });
  return (
    <Button size="sm" loading={run.isPending} disabled={disabled} onClick={() => run.mutate()}>
      Find leads now
    </Button>
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
  const ORDER = ["inbox_assistant", "lead_triage", "prospector", "loan_verification", "kitchen_daily", "meeting_digest"];
  const list = catalogue.data
    .filter((w) => w.venture_kinds.includes(kind) || configs.data.some((c) => c.workflow === w.name))
    .sort((a, b) => (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99));
  return (
    <Card>
      {!canAdmin ? (
        <Notice tone="info" className="m-3">
          Only a venture admin or owner can change agents.
        </Notice>
      ) : null}
      <ul className="divide-y divide-border">
        {list.map((w) => (
          <AgentRow key={w.name} wf={w} config={configs.data.find((c) => c.workflow === w.name)} ventureId={ventureId} canAdmin={canAdmin} />
        ))}
      </ul>
    </Card>
  );
}
