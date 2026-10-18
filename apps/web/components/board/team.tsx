"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate, Pencil, Play, Sparkles, Users } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Switch, Textarea } from "@/components/ui/field";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { TimeField } from "@/components/ui/time-field";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { SpendMeter } from "./spend-meter";

type Lead = Schemas["TeamLeadOut"];
type LeadIn = Schemas["TeamLeadIn"];
type Kit = Schemas["TemplateKitOut"];
type Applied = Schemas["TemplateAppliedOut"];

export const teamKey = (ventureId: string) => ["team", ventureId] as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A lead's goal, check-in days and time, and budget. */
function LeadEditor({ ventureId, lead, onClose }: { ventureId: string; lead: Lead; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<LeadIn>({
    goal: lead.goal,
    enabled: lead.set_up ? lead.enabled : true,
    weekdays: lead.weekdays,
    at_time: lead.at_time,
    monthly_tokens: lead.monthly_tokens ?? null,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/team/{role}", {
          params: { path: { venture_id: ventureId, role: lead.role } },
          body: { ...d, goal: (d.goal ?? "").trim() },
        }),
      ),
    onSuccess: (l) => {
      toast.success(`${l.title} lead saved`, l.enabled ? l.when : "Switched off");
      void qc.invalidateQueries({ queryKey: teamKey(ventureId) });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const set = (patch: Partial<LeadIn>) => setD({ ...d, ...patch });
  const days = d.weekdays ?? [];
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${lead.title} lead`}
      description="On its days the lead looks over its area, does a few useful things towards its goal and reports to you. Anything that sends, books or changes something waits for your yes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Goal" hint="One or two lines on what good looks like for this part of the business." required>
          <Textarea rows={3} value={d.goal} onChange={(e) => set({ goal: e.target.value })} maxLength={600} />
        </Field>
        <Switch checked={Boolean(d.enabled)} onChange={() => set({ enabled: !d.enabled })} label="Check in by itself" />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Check-in days">
          {WEEKDAYS.map((w, i) => {
            const on = days.includes(i);
            return (
              <Button
                key={w}
                size="sm"
                variant={on ? "primary" : "secondary"}
                aria-pressed={on}
                onClick={() => set({ weekdays: on ? days.filter((x) => x !== i) : [...days, i].sort() })}
              >
                {w}
              </Button>
            );
          })}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Time">
            <TimeField value={d.at_time ?? "09:30"} onChange={(t) => set({ at_time: t })} />
          </Field>
          <Field label="Monthly budget (tokens)" hint="Covers the lead and its agents. Empty: plan limit only.">
            <Input
              type="number"
              min={0}
              value={d.monthly_tokens ?? ""}
              onChange={(e) => set({ monthly_tokens: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </Field>
        </div>
        <FormError message={error} />
      </div>
    </Dialog>
  );
}

function LeadCard({ ventureId, lead, canAdmin, canCheckIn, onEdit, i }: { ventureId: string; lead: Lead; canAdmin: boolean; canCheckIn: boolean; onEdit: () => void; i: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const reduce = useReducedMotion();
  const checkIn = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/team/{role}/check-in", { params: { path: { venture_id: ventureId, role: lead.role } } })),
    onSuccess: () => {
      toast.success(`${lead.title} lead is checking in`, "Its drafts arrive on the approval board; the report shows here.");
      void qc.invalidateQueries({ queryKey: teamKey(ventureId) });
    },
    onError: (e) => toast.error("Can't check in", errorMessage(e)),
  });
  const paused = lead.monthly_tokens != null && lead.used_tokens >= lead.monthly_tokens;
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: reduce ? 0 : i * 0.05 }}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {lead.title} lead
            {lead.enabled ? <Badge tone="success">on</Badge> : <Badge>{lead.set_up ? "off" : "not set up"}</Badge>}
            {lead.last_error ? <Badge tone="danger">{lead.last_error}</Badge> : null}
          </p>
          <p className="text-xs text-muted">
            {lead.enabled ? lead.when : "Checks in when you ask"}
            {lead.next_run_at ? ` · next ${formatRelative(lead.next_run_at)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {canCheckIn && lead.set_up ? (
            <Button size="sm" variant="ghost" icon={<Play className="h-4 w-4" />} loading={checkIn.isPending} onClick={() => checkIn.mutate()}>
              Check in
            </Button>
          ) : null}
          {canAdmin ? <Button size="icon" variant="ghost" aria-label={`Set up the ${lead.title} lead`} icon={<Pencil className="h-4 w-4" />} onClick={onEdit} /> : null}
        </div>
      </div>
      <p className="text-sm text-muted" translate="no">
        {lead.goal}
      </p>
      <p className="text-xs text-subtle">{lead.agents.length ? `Agents: ${lead.agents.join(", ")}` : "No agents switched on in this role yet"}</p>
      <SpendMeter role={{ monthly_tokens: lead.monthly_tokens ?? null, used_tokens: lead.used_tokens, paused }} compact />
      {lead.latest_report ? (
        <div className="rounded-md bg-surface-2 p-2">
          <p className="text-xs font-medium text-subtle">Latest report{lead.latest_report_at ? ` · ${formatRelative(lead.latest_report_at)}` : ""}</p>
          <p className="mt-1 text-sm whitespace-pre-line" translate="no">
            {lead.latest_report}
          </p>
        </div>
      ) : null}
    </motion.li>
  );
}

/** The agent team: a lead for each role, with a goal, check-ins, a budget and reports. */
export function TeamCard({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const q = useQuery({
    queryKey: teamKey(ventureId),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/team", { params: { path: { venture_id: ventureId } } })),
    refetchInterval: 30_000,
  });
  const [editing, setEditing] = useState<Lead | null>(null);
  const [kits, setKits] = useState(false);
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Users className="h-4 w-4 text-accent" aria-hidden /> Team leads
          </span>
        }
        description="Give each role a goal. Its lead checks in on its days, does what it can (drafts wait for your yes), hands work to the right lead and reports to you on Telegram or WhatsApp."
        actions={
          canAdmin ? (
            <Button size="sm" variant="secondary" icon={<LayoutTemplate className="h-4 w-4" />} onClick={() => setKits(true)}>
              Starter kits
            </Button>
          ) : null
        }
      />
      <QueryState query={q} loading={<SkeletonRows rows={2} className="p-3" />}>
        {(t) => (
          <ul className="grid gap-3 p-4 md:grid-cols-2">
            {t.leads.map((l, i) => (
              <LeadCard key={l.role} ventureId={ventureId} lead={l} canAdmin={t.can_admin} canCheckIn={t.can_check_in} onEdit={() => setEditing(l)} i={i} />
            ))}
          </ul>
        )}
      </QueryState>
      {editing ? <LeadEditor ventureId={ventureId} lead={editing} onClose={() => setEditing(null)} /> : null}
      {kits ? <TemplatesDialog ventureId={ventureId} onClose={() => setKits(false)} /> : null}
    </Card>
  );
}

function Added({ out }: { out: Applied }) {
  const rows: [string, string[]][] = [
    ["Agents switched on", out.agents],
    ["Automations", out.automations],
    ["Skills", out.skills],
    ["Leads with goals", out.leads],
  ];
  const any = rows.some(([, xs]) => xs.length);
  return (
    <div className="space-y-2 text-sm">
      {any ? (
        rows
          .filter(([, xs]) => xs.length)
          .map(([label, xs]) => (
            <p key={label}>
              <span className="font-medium">{label}:</span> {xs.join(", ")}
            </p>
          ))
      ) : (
        <p className="text-muted">Everything in this kit was already set up.</p>
      )}
      {out.notes.map((n) => (
        <p key={n} className="text-muted">
          {n}
        </p>
      ))}
      {out.skipped.length ? (
        <div className="rounded-md bg-surface-2 p-2">
          <p className="text-xs font-medium text-subtle">Left out</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
            {out.skipped.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Industry starter kits: one click adds the right agents, automations, skills and leads' goals. */
export function TemplatesDialog({ ventureId, onClose }: { ventureId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["templates"], queryFn: () => unwrap(api.GET("/templates")), staleTime: 3_600_000 });
  const [done, setDone] = useState<{ kit: Kit; out: Applied } | null>(null);
  const apply = useMutation({
    mutationFn: (k: Kit) => unwrap(api.POST("/ventures/{venture_id}/templates/{key}/apply", { params: { path: { venture_id: ventureId, key: k.key } } })),
    onSuccess: (out, k) => {
      setDone({ kit: k, out });
      for (const key of [teamKey(ventureId), ["skills", ventureId], ["automations", ventureId], ["board", ventureId], ["workflow-configs", ventureId]]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
    onError: (e) => toast.error("Can't add the kit", errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={done ? `${done.kit.name}: added` : "Starter kits"}
      description={
        done
          ? "You can change or switch off anything it added."
          : "Pick the kit closest to your business. It adds what's missing and never changes what you already have."
      }
      footer={
        <Button variant={done ? "primary" : "ghost"} onClick={onClose}>
          {done ? "Done" : "Close"}
        </Button>
      }
    >
      {done ? (
        <Added out={done.out} />
      ) : (
        <QueryState query={list} loading={<SkeletonRows rows={3} />}>
          {(kits) => (
            <ul className="grid gap-2 sm:grid-cols-2">
              {kits.map((k) => (
                <li key={k.key} className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <p className="font-medium">{k.name}</p>
                  <p className="text-xs text-muted">{k.description}</p>
                  <p className="text-xs text-subtle">
                    {[...k.agents, ...k.automations, ...k.skills].length} things · leads: {k.leads.join(", ")}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="mt-auto self-start"
                    icon={<Sparkles className="h-4 w-4" />}
                    loading={apply.isPending && apply.variables?.key === k.key}
                    disabled={apply.isPending}
                    onClick={() => apply.mutate(k)}
                  >
                    Add this kit
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      )}
    </Dialog>
  );
}
