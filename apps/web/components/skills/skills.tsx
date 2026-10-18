"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GraduationCap, Pencil, Play, Plus, Trash2, Wand2, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { TimeField } from "@/components/ui/time-field";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type Skill = Schemas["SkillOut"];
type Draft = Schemas["SkillIn"];

export const skillsKey = (ventureId: string) => ["skills", ventureId] as const;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EVENTS: Record<string, string> = {
  invoice_overdue: "An invoice is overdue",
  invoice_paid: "An invoice was paid",
  booking_done: "A booking was done",
  lead_new: "A new lead came in",
  lead_quiet: "A lead has gone quiet",
};
const EXAMPLES = [
  "When an invoice is 7 days overdue, WhatsApp the customer a polite reminder and add a task for Ravi to call them",
  "Every Friday at 6 pm, tell me which leads went quiet this week and draft a follow-up for each",
  "Har booking ke 2 din baad customer se Google review maango",
];

const blank: Draft = { name: "", instructions: "", trigger: "manual", weekdays: [], wait_days: 0, enabled: true };

function draftFrom(x: Partial<Draft> & { name: string; instructions: string }): Draft {
  return {
    ...blank,
    ...x,
    weekdays: x.weekdays ?? [],
    wait_days: x.wait_days ?? 0,
    enabled: x.enabled ?? true,
  };
}

/** The form for a skill: name, steps, and when it runs. */
function SkillEditor({
  ventureId,
  initial,
  skillId,
  onClose,
}: {
  ventureId: string;
  initial: Draft;
  skillId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...d, name: d.name.trim(), instructions: d.instructions.trim() };
      return skillId
        ? unwrap(api.PUT("/ventures/{venture_id}/skills/{skill_id}", { params: { path: { venture_id: ventureId, skill_id: skillId } }, body }))
        : unwrap(api.POST("/ventures/{venture_id}/skills", { params: { path: { venture_id: ventureId } }, body }));
    },
    onSuccess: (s) => {
      toast.success(skillId ? "Skill saved" : "Skill added", s.when);
      void qc.invalidateQueries({ queryKey: skillsKey(ventureId) });
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  return (
    <Dialog
      open
      onClose={onClose}
      title={skillId ? "Edit skill" : "New skill"}
      description="Kritvia does these steps with its assistant. Anything that sends, books or changes something waits for a yes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save skill
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" required>
          <Input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
        </Field>
        <Field label="Steps" hint="In plain words, one step per line. Kritvia follows them every time." required>
          <Textarea rows={6} value={d.instructions} onChange={(e) => set({ instructions: e.target.value })} maxLength={2000} />
        </Field>
        <Field label="When it runs">
          <Select value={d.trigger} onChange={(e) => set({ trigger: e.target.value as Draft["trigger"] })}>
            <option value="manual">When I run it</option>
            <option value="schedule">On a schedule</option>
            <option value="event">When something happens</option>
          </Select>
        </Field>
        {d.trigger === "schedule" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="How often">
              <Select value={d.freq ?? "daily"} onChange={(e) => set({ freq: e.target.value as Draft["freq"] })}>
                <option value="daily">Every day</option>
                <option value="weekly">Some weekdays</option>
                <option value="monthly">Once a month</option>
              </Select>
            </Field>
            {d.freq === "monthly" ? (
              <Field label="Day of the month">
                <Input type="number" min={1} max={28} value={d.day_of_month ?? 1} onChange={(e) => set({ day_of_month: Number(e.target.value) })} />
              </Field>
            ) : null}
            <Field label="Time">
              <TimeField value={d.at_time ?? "09:00"} onChange={(t) => set({ at_time: t })} />
            </Field>
            {d.freq === "weekly" ? (
              <div className="flex flex-wrap gap-1.5 sm:col-span-3" role="group" aria-label="Weekdays">
                {WEEKDAYS.map((w, i) => {
                  const on = (d.weekdays ?? []).includes(i);
                  return (
                    <Button
                      key={w}
                      size="sm"
                      variant={on ? "primary" : "secondary"}
                      aria-pressed={on}
                      onClick={() => set({ weekdays: on ? (d.weekdays ?? []).filter((x) => x !== i) : [...(d.weekdays ?? []), i].sort() })}
                    >
                      {w}
                    </Button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        {d.trigger === "event" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="When">
              <Select value={d.event ?? "invoice_overdue"} onChange={(e) => set({ event: e.target.value as Draft["event"] })}>
                {Object.entries(EVENTS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="After how many days">
              <Input type="number" min={0} max={60} value={d.wait_days ?? 0} onChange={(e) => set({ wait_days: Number(e.target.value) })} />
            </Field>
            <Field label="Check daily at">
              <TimeField value={d.at_time ?? "09:00"} onChange={(t) => set({ at_time: t })} />
            </Field>
          </div>
        ) : null}
        <FormError message={error} />
      </div>
    </Dialog>
  );
}

/** "Save as a skill" on a request that worked. */
export function SaveAsSkill({ ventureId, runId }: { ventureId: string; runId: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const make = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/skills/from-request", { params: { path: { venture_id: ventureId } }, body: { run_id: runId } })),
    onSuccess: (d) => setDraft(draftFrom({ ...d, source_run_id: runId })),
    onError: (e) => toast.error("Can't make a skill from this", errorMessage(e)),
  });
  return (
    <>
      <Button size="sm" variant="ghost" icon={<GraduationCap className="h-4 w-4" />} loading={make.isPending} onClick={() => make.mutate()}>
        Save as a skill
      </Button>
      {draft ? <SkillEditor ventureId={ventureId} initial={draft} onClose={() => setDraft(null)} /> : null}
    </>
  );
}

/** Skills: jobs Kritvia learns, repeats and gets better at. */
export function SkillsCard({ ventureId, canWrite, canAdmin }: { ventureId: string; canWrite: boolean; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = skillsKey(ventureId);
  const list = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/skills", { params: { path: { venture_id: ventureId } } })) });
  const [words, setWords] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; id?: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const understand = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/skills/understand", { params: { path: { venture_id: ventureId } }, body: { words: words.trim() } })),
    onSuccess: (d) => {
      setError(null);
      setEditing({ draft: draftFrom(d) });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const run = useMutation({
    mutationFn: (s: Skill) => unwrap(api.POST("/ventures/{venture_id}/skills/{skill_id}/run", { params: { path: { venture_id: ventureId, skill_id: s.id } } })),
    onSuccess: () => {
      toast.success("Running", "Its drafts arrive on the approval board; the answer is on the Assistant page.");
      refresh();
    },
    onError: (e) => toast.error("Can't run it", errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (s: Skill) =>
      unwrap(
        api.PUT("/ventures/{venture_id}/skills/{skill_id}", {
          params: { path: { venture_id: ventureId, skill_id: s.id } },
          body: draftFrom({ ...s, enabled: !s.enabled }),
        }),
      ),
    onSuccess: refresh,
    onError: (e) => toast.error("Can't change it", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (s: Skill) => unwrap(api.DELETE("/ventures/{venture_id}/skills/{skill_id}", { params: { path: { venture_id: ventureId, skill_id: s.id } } })),
    onSuccess: () => {
      toast.success("Skill removed");
      refresh();
    },
    onError: (e) => toast.error("Can't remove it", errorMessage(e)),
  });
  const forget = useMutation({
    mutationFn: ({ s, i }: { s: Skill; i: number }) =>
      unwrap(api.DELETE("/ventures/{venture_id}/skills/{skill_id}/lessons/{index}", { params: { path: { venture_id: ventureId, skill_id: s.id, index: i } } })),
    onSuccess: refresh,
    onError: (e) => toast.error("Can't forget it", errorMessage(e)),
  });

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <GraduationCap className="h-4 w-4 text-accent" aria-hidden /> Skills
          </span>
        }
        description="Jobs Kritvia does step by step, on demand, on a schedule or when something happens. When you edit one of a skill's drafts, it learns for next time."
        actions={
          canWrite ? (
            <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ draft: blank })}>
              Write one
            </Button>
          ) : null
        }
      />
      {canWrite ? (
        <form
          className="space-y-2 border-b border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (words.trim().length >= 5) understand.mutate();
          }}
        >
          <div className="flex gap-2">
            <Input value={words} onChange={(e) => setWords(e.target.value)} maxLength={1500} placeholder={EXAMPLES[0]} aria-label="Describe the job in plain words" />
            <Button type="submit" variant="primary" icon={<Wand2 className="h-4 w-4" />} loading={understand.isPending}>
              Make it
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="rounded-full border border-border px-3 py-1 text-left text-xs text-muted hover:bg-surface-2" onClick={() => setWords(x)}>
                {x}
              </button>
            ))}
          </div>
          <FormError message={error} />
        </form>
      ) : null}
      <QueryState query={list} loading={<SkeletonRows rows={2} className="p-3" />}>
        {(rows: Skill[]) =>
          rows.length ? (
            <ul className="divide-y divide-border">
              {rows.map((s) => (
                <li key={s.id} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {s.name}
                        {!s.enabled ? <Badge>off</Badge> : null}
                        {s.last_error ? <Badge tone="danger">{s.last_error}</Badge> : null}
                        {s.lessons_learned ? (
                          <Badge tone="success">
                            learned {s.lessons_learned} {s.lessons_learned === 1 ? "lesson" : "lessons"}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted">
                        {s.when}
                        {s.next_run_at ? ` · next ${formatRelative(s.next_run_at)}` : ""} · ran {s.runs} {s.runs === 1 ? "time" : "times"}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {canWrite ? (
                        <Button size="sm" variant="ghost" icon={<Play className="h-4 w-4" />} loading={run.isPending && run.variables?.id === s.id} onClick={() => run.mutate(s)}>
                          Run now
                        </Button>
                      ) : null}
                      {s.can_edit || canAdmin ? (
                        <>
                          {s.trigger !== "manual" ? <Switch checked={s.enabled} onChange={() => toggle.mutate(s)} label={`Run ${s.name} by itself`} /> : null}
                          <Button size="icon" variant="ghost" aria-label={`Edit ${s.name}`} icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing({ draft: draftFrom(s), id: s.id })} />
                          <Button size="icon" variant="ghost" aria-label={`Remove ${s.name}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => remove.mutate(s)} />
                        </>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-sm whitespace-pre-line text-muted" translate="no">
                    {s.instructions}
                  </p>
                  {s.lessons.length ? (
                    <div className="rounded-md bg-surface-2 p-2">
                      <p className="text-xs font-medium text-subtle">What it has learned</p>
                      <ul className="mt-1 space-y-1">
                        {s.lessons.map((l, i) => (
                          <li key={`${i}-${l}`} className="flex items-start justify-between gap-2 text-sm">
                            <span translate="no">{l}</span>
                            {s.can_edit || canAdmin ? (
                              <Button size="icon" variant="ghost" aria-label={`Forget: ${l}`} icon={<X className="h-3.5 w-3.5" />} onClick={() => forget.mutate({ s, i })} />
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No skills yet" description="Describe a job above, or save a request that worked on the Assistant page as a skill." />
          )
        }
      </QueryState>
      {editing ? <SkillEditor ventureId={ventureId} initial={editing.draft} skillId={editing.id} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
