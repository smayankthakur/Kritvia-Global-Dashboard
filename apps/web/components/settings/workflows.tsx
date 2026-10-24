"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { TimeField } from "@/components/ui/time-field";
import { UnsavedBar } from "@/components/ui/unsaved-bar";
import { agentFromHash, splitAgents } from "@/lib/agents";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useUnsavedChanges } from "@/lib/unsaved";

/** Agents that run on a daily clock: the time they run, and how the field is labelled. */
const SCHEDULED: Record<string, { at: string; label: string }> = {
  kitchen_daily: { at: "23:30", label: "Runs every night at (IST)" },
  trade_watch: { at: "09:00", label: "Sends the shipment list every morning at (IST)" },
  prospector: { at: "10:30", label: "Finds leads and sends messages every day at (IST)" },
  whatsapp_followup: { at: "11:00", label: "Looks for quiet chats every day at (IST)" },
  collections: { at: "10:00", label: "Drafts reminders every day at (IST)" },
  booking_reminders: { at: "18:00", label: "Drafts tomorrow's booking reminders every day at (IST)" },
  reviews: { at: "19:00", label: "Checks reviews and asks customers every day at (IST)" },
  social: { at: "10:00", label: "Writes the post on your posting days at (IST)" },
  campaign_ideas: { at: "10:30", label: "Looks for a festival or a slow week on its day at (IST)" },
  google_listing: { at: "09:30", label: "Checks your Google listing on its day at (IST)" },
};
const INSTRUCTION_HINTS: Record<string, string> = {
  inbox_assistant: "e.g. Reply in Hinglish. Delivery takes 3–5 days. Never quote prices; say we will share a quote.",
  lead_triage: "e.g. We only take projects above ₹1 lakh. Always mention our 2-week pilot offer.",
  loan_verification: "e.g. Salaried applicants need 3 salary slips; self-employed need 2 years of ITR.",
  kitchen_daily: "e.g. Buy paneer only from Amul distributor. Keep 20% extra on weekends.",
  trade_watch: "The list is written from your shipment files; keep cut-offs, ETD/ETA, LC dates and documents up to date there.",
  prospector: "e.g. Mention we built the site for Annapurna Rasoi. Skip hotels and big chains. Offer a free demo page.",
  whatsapp_followup: "e.g. Keep it light. Mention the weekend slots if they asked about bookings.",
  collections: "e.g. Write in Hinglish. Mention that GST invoices are attached on request. Be extra polite with Kapoor Sweets.",
  booking_reminders: "Reminders are written from the booking itself; add a standing note under the agent's settings.",
  social: "e.g. Mention our free home delivery in Paschim Vihar. Never post on Tuesdays about non-veg.",
  campaign_ideas: "e.g. Write in Hinglish. Always end with our WhatsApp number for orders.",
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
    } else if (o.type === "multi") {
      // Only known choices, in a stable order; an unchanged set is left out like any default.
      const allowed = (o.choices ?? []).map((c) => c.value);
      const picked = allowed.filter((v) => Array.isArray(raw) && raw.includes(v));
      const dflt = Array.isArray(o.default) ? allowed.filter((v) => (o.default as unknown[]).includes(v)) : allowed;
      if (picked.join("\n") !== dflt.join("\n")) settings[o.key] = picked;
    } else if (o.type === "choice") {
      const v = String(raw);
      if ((o.choices ?? []).some((c) => c.value === v) && v !== String(o.default)) settings[o.key] = v;
    } else if (String(raw) !== String(o.default)) settings[o.key] = String(raw).slice(0, 500);
  }
  return { settings, errors };
}

function OptionField({ o, value, error, disabled, onChange }: { o: Option; value: unknown; error?: string; disabled: boolean; onChange: (v: unknown) => void }) {
  if (o.type === "boolean") {
    return <Checkbox label={o.label} hint={o.help || undefined} checked={value === undefined ? Boolean(o.default) : Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (o.type === "multi") {
    const current = Array.isArray(value) ? (value as string[]) : Array.isArray(o.default) ? (o.default as string[]) : [];
    return (
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium text-fg">{o.label}</legend>
        {o.help ? <p className="mt-0.5 text-xs text-subtle">{o.help}</p> : null}
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {(o.choices ?? []).map((c) => (
            <Checkbox
              key={c.value}
              label={c.label}
              checked={current.includes(c.value)}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? [...current, c.value] : current.filter((v) => v !== c.value))}
            />
          ))}
        </div>
      </fieldset>
    );
  }
  if (o.type === "choice") {
    return (
      <Field label={o.label} hint={o.help || undefined} error={error} className="max-w-xs">
        <Select value={value === undefined ? String(o.default ?? "") : String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {(o.choices ?? []).map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
    );
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

type Config = Schemas["WorkflowConfigOut"];
type Workflow = Schemas["WorkflowOut"];

/** What an agent's form holds: the time it runs, its instructions, the option fields and the extra JSON. */
export interface AgentDraft {
  schedule: string;
  instructions: string;
  form: Record<string, unknown>;
  text: string;
}

export function draftFromConfig(wf: Pick<Workflow, "name" | "options">, config?: Pick<Config, "schedule" | "instructions" | "settings">): AgentDraft {
  const s = splitSettings((config?.settings as Record<string, unknown>) ?? {}, wf.options);
  return {
    schedule: config?.schedule ?? SCHEDULED[wf.name]?.at ?? "",
    instructions: config?.instructions ?? "",
    form: s.form,
    text: JSON.stringify(s.rest, null, 2),
  };
}

/** JSON with sorted keys, so two settings objects compare equal whatever order their keys came in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** What Save would send, as text: two drafts that would save the same thing have no unsaved difference. */
export function draftKey(wf: Pick<Workflow, "name" | "options">, d: AgentDraft): string {
  const parsed = parseSettingsJson(d.text);
  const opts = optionValues(d.form, wf.options);
  return stable({
    schedule: SCHEDULED[wf.name] ? d.schedule || null : null,
    instructions: d.instructions,
    settings: parsed.value ? { ...parsed.value, ...opts.settings } : { invalidJson: d.text },
    errors: opts.errors,
  });
}

function draftErrors(wf: Workflow, d: AgentDraft) {
  const parsed = parseSettingsJson(d.text);
  const opts = optionValues(d.form, wf.options);
  const schedErr = d.schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.schedule) ? "HH:MM (24-hour, IST)" : null;
  const invalid = Boolean(parsed.error) || Boolean(schedErr) || Object.keys(opts.errors).length > 0 || d.instructions.length > 4000;
  return { parsed, opts, schedErr, invalid };
}

/** The Prospector needs at least one Google Maps search before it can find anyone (round 3, A20). */
export function hasSearches(config?: Pick<Config, "settings">): boolean {
  const s = (config?.settings as Record<string, unknown> | undefined)?.searches;
  return typeof s === "string" && s.split(";").some((x) => x.trim());
}

function putConfigs(list: Config[] | undefined, next: Config): Config[] {
  const rest = (list ?? []).filter((c) => c.workflow !== next.workflow);
  return [...rest, next];
}

function AgentRow({
  wf,
  config,
  ventureId,
  canAdmin,
  defaultOpen,
  onDirty,
}: {
  wf: Workflow;
  config?: Config;
  ventureId: string;
  canAdmin: boolean;
  defaultOpen: boolean;
  onDirty: (name: string, dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const base = useMemo(() => draftFromConfig(wf, config), [wf, config]);
  const [draft, setDraft] = useState<AgentDraft>(base);
  const [seen, setSeen] = useState(base);
  // The saved config changed (saved here, switched on or off, changed on the Chats page): take it, unless the
  // form holds edits not saved yet — those stay until Save or Discard.
  if (seen !== base) {
    if (draftKey(wf, draft) === draftKey(wf, seen)) setDraft(base);
    setSeen(base);
  }
  const dirty = draftKey(wf, draft) !== draftKey(wf, base);
  useEffect(() => onDirty(wf.name, dirty), [dirty, onDirty, wf.name]);
  useEffect(() => () => onDirty(wf.name, false), [onDirty, wf.name]);

  const { parsed, opts, schedErr, invalid } = draftErrors(wf, draft);
  const [open, setOpen] = useState(() => defaultOpen || draftErrors(wf, base).invalid);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const configKey = ["workflow-configs", ventureId];

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/workflow-configs/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: wf.name } },
          // The switch saves on its own; Save keeps whatever it is now. Only agents that run on a clock have a
          // time; the others start when there is something to do.
          body: {
            enabled: config?.enabled ?? false,
            schedule: SCHEDULED[wf.name] ? draft.schedule || null : null,
            settings: { ...(parsed.value ?? {}), ...opts.settings },
            instructions: draft.instructions,
          },
        }),
      ),
    onSuccess: (out) => {
      toast.success(`${wf.title} saved`);
      qc.setQueryData<Config[]>(configKey, (list) => putConfigs(list, out));
      void qc.invalidateQueries({ queryKey: configKey });
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });
  // The on/off switch saves at once and changes nothing else (round 3, A2).
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(
        api.PATCH("/ventures/{venture_id}/workflow-configs/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: wf.name } },
          body: { enabled },
        }),
      ),
    onSuccess: (out) => {
      toast.success(out.enabled ? `${wf.title} is on` : `${wf.title} is off`);
      qc.setQueryData<Config[]>(configKey, (list) => putConfigs(list, out));
      void qc.invalidateQueries({ queryKey: configKey });
    },
    onError: (e) => toast.error("Couldn't switch it", errorMessage(e)),
  });
  const enabled = toggle.isPending ? Boolean(toggle.variables) : (config?.enabled ?? false);
  const panelId = `agent-${wf.name}-settings`;
  const saveNow = () => {
    if (!invalid) save.mutate();
    else setOpen(true);
  };

  return (
    <li id={`agent-${wf.name}`} className="scroll-mt-20 space-y-3 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-semibold">{wf.title}</h3>
            {config ? null : <Badge tone="warning">Not set up</Badge>}
            {config?.updated_at ? <span className="text-xs text-subtle">updated {formatRelative(config.updated_at)}</span> : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-sm text-muted">{wf.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
            icon={<ChevronDown className={open ? "h-3.5 w-3.5 rotate-180 transition-transform" : "h-3.5 w-3.5 transition-transform"} aria-hidden />}
          >
            Configure
          </Button>
          <Switch checked={enabled} onChange={(next) => toggle.mutate(next)} label={`${wf.title} on or off`} disabled={!canAdmin || toggle.isPending} />
        </div>
      </div>
      {dirty && !open ? <UnsavedBar onSave={saveNow} onDiscard={() => setDraft(base)} saving={save.isPending} saveDisabled={!canAdmin} /> : null}
      {open ? (
        <div id={panelId} className="space-y-4 rounded-lg border border-border p-3 sm:p-4">
          <p className="text-xs text-subtle">
            <span className="inline-flex items-center gap-1">
              <Play className="h-3 w-3" aria-hidden /> Runs: {wf.trigger}
            </span>
          </p>
          <Field
            label="Instructions for this agent"
            hint={`${INSTRUCTION_HINTS[wf.name] ?? "Plain language; the agent follows these on every run."} (${draft.instructions.length}/4000)`}
            error={draft.instructions.length > 4000 ? "Too long" : undefined}
          >
            <Textarea
              rows={3}
              value={draft.instructions}
              disabled={!canAdmin}
              maxLength={4000}
              onChange={(e) => set({ instructions: e.target.value })}
              placeholder="Anything the agent should always know or do"
            />
          </Field>
          {wf.options.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {wf.options.map((o) => (
                <OptionField
                  key={o.key}
                  o={o}
                  value={draft.form[o.key]}
                  error={opts.errors[o.key]}
                  disabled={!canAdmin}
                  onChange={(v) => setDraft((d) => ({ ...d, form: { ...d.form, [o.key]: v } }))}
                />
              ))}
            </div>
          ) : null}
          {SCHEDULED[wf.name] ? (
            <Field label={SCHEDULED[wf.name]!.label} error={schedErr} className="max-w-xs">
              <TimeField value={draft.schedule} disabled={!canAdmin} onChange={(t) => set({ schedule: t })} />
            </Field>
          ) : null}
          {wf.name === "whatsapp_followup" ? (
            <p className="text-xs text-subtle">
              Only chats where the customer wrote to you first, or where your team confirmed they agreed to messages, get a follow-up.
              Each follow-up waits for your yes unless you let this agent send on its own on the Trust page; a reply from the customer stops them, and STOP opts them out.
            </p>
          ) : null}
          {wf.name === "prospector" ? (
            <p className="text-xs text-subtle">
              Emails go from your connected Gmail. WhatsApp only lets a business message someone first from its own phone, so first
              WhatsApp messages wait in Leads for you to send with one tap. Every message offers a way to opt out, and a reply stops
              the follow-ups. Calls are yours for now: the lead shows the number and you log the call.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="inline-flex items-center gap-1 text-xs text-subtle hover:text-fg" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              <ChevronDown className={advanced ? "h-3.5 w-3.5 rotate-180 transition-transform" : "h-3.5 w-3.5 transition-transform"} aria-hidden />
              Advanced
            </button>
            {wf.name === "prospector" && config?.enabled ? <RunNow ventureId={ventureId} disabled={!canAdmin} ready={hasSearches(config)} /> : null}
          </div>
          {advanced ? (
            <div className="space-y-3 rounded-lg border border-border bg-surface-2 p-3">
              <Field label="Extra settings (JSON)" error={parsed.error} hint="For settings without a field above, e.g. gmail_query, source_weights.">
                <Textarea
                  rows={Math.min(8, Math.max(2, draft.text.split("\n").length))}
                  value={draft.text}
                  disabled={!canAdmin}
                  onChange={(e) => set({ text: e.target.value })}
                  className="font-mono text-xs"
                  spellCheck={false}
                />
              </Field>
              <p className="text-xs text-subtle">Steps: {wf.steps.map((s) => s.name).join(" → ")}</p>
            </div>
          ) : null}
          {dirty ? <UnsavedBar onSave={saveNow} onDiscard={() => setDraft(base)} saving={save.isPending} saveDisabled={!canAdmin || invalid} sticky /> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Runs the Prospector now instead of waiting for its daily time, then shows the run working. */
function RunNow({ ventureId, disabled, ready }: { ventureId: string; disabled: boolean; ready: boolean }) {
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
    <span className="flex items-center gap-2">
      {!ready ? <span className="text-xs text-subtle">Add a search first</span> : null}
      <Button size="sm" loading={run.isPending} disabled={disabled || !ready} onClick={() => run.mutate()}>
        Find leads now
      </Button>
    </span>
  );
}

function useHashAgent(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setName(agentFromHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return name;
}

export function WorkflowSettings({ ventureId, kind, canAdmin }: { ventureId: string; kind: string; canAdmin: boolean }) {
  const catalogue = useQuery({ queryKey: ["workflows"], queryFn: () => unwrap(api.GET("/workflows")), staleTime: 10 * 60_000 });
  const configs = useQuery({
    queryKey: ["workflow-configs", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: ventureId } } })),
  });
  const hashAgent = useHashAgent();
  const [dirtyAgents, setDirtyAgents] = useState<ReadonlySet<string>>(new Set());
  const onDirty = useCallback((name: string, dirty: boolean) => {
    setDirtyAgents((s) => {
      if (s.has(name) === dirty) return s;
      const n = new Set(s);
      if (dirty) n.add(name);
      else n.delete(name);
      return n;
    });
  }, []);
  useUnsavedChanges(dirtyAgents.size > 0);
  const [showMore, setShowMore] = useState(false);
  const parts = useMemo(() => {
    if (!catalogue.data || !configs.data) return null;
    const ORDER = ["inbox_assistant", "lead_triage", "prospector", "loan_verification", "kitchen_daily", "trade_watch", "meeting_digest"];
    const configured = new Set(configs.data.map((c) => c.workflow));
    const on = new Set(configs.data.filter((c) => c.enabled).map((c) => c.workflow));
    const list = catalogue.data
      .filter((w) => w.venture_kinds.includes(kind) || configured.has(w.name))
      .sort((a, b) => (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99));
    return splitAgents(list, kind, on);
  }, [catalogue.data, configs.data, kind]);
  const hashInMore = Boolean(hashAgent && parts?.more.some((w) => w.name === hashAgent));
  useEffect(() => {
    if (hashInMore) setShowMore(true);
  }, [hashInMore]);
  // A link to one agent (from Automations or the morning check) opens it; scroll once it is on the page.
  useEffect(() => {
    if (!hashAgent || !parts) return;
    const t = setTimeout(() => document.getElementById(`agent-${hashAgent}`)?.scrollIntoView({ block: "start" }), 50);
    return () => clearTimeout(t);
  }, [hashAgent, parts, showMore]);

  if (catalogue.isPending || configs.isPending) return <SkeletonRows />;
  if (catalogue.isError) return <ErrorState error={catalogue.error} />;
  if (configs.isError) return <ErrorState error={configs.error} />;
  if (!parts) return null;
  const row = (w: Workflow) => (
    <AgentRow
      key={w.name}
      wf={w}
      config={configs.data.find((c) => c.workflow === w.name)}
      ventureId={ventureId}
      canAdmin={canAdmin}
      defaultOpen={hashAgent === w.name}
      onDirty={onDirty}
    />
  );
  return (
    <div className="space-y-4">
      <Card>
        {!canAdmin ? (
          <Notice tone="info" className="m-3">
            Only a venture admin or owner can change agents.
          </Notice>
        ) : null}
        <ul className="divide-y divide-border" aria-label="Agents for this business">
          {parts.main.map(row)}
        </ul>
      </Card>
      {parts.more.length ? (
        <Card>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
            aria-expanded={showMore}
            aria-controls="more-agents"
            onClick={() => setShowMore((s) => !s)}
          >
            <span>
              <span className="block text-sm font-semibold">More agents</span>
              <span className="block text-xs text-subtle">Made for other kinds of business. Switch one on if it fits how you work.</span>
            </span>
            <ChevronDown className={showMore ? "h-4 w-4 shrink-0 rotate-180 transition-transform" : "h-4 w-4 shrink-0 transition-transform"} aria-hidden />
          </button>
          {/* Kept on the page while folded away, so edits in one of these agents aren't lost by folding. */}
          <ul id="more-agents" hidden={!showMore} className="divide-y divide-border border-t border-border" aria-label="More agents">
            {parts.more.map(row)}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
