"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Play, Repeat, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { CustomWorkflows } from "@/components/automations/custom-workflows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Switch } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { AGENT_SUGGESTIONS, GROUPS, SUGGESTIONS, describeSchedule, type Suggestion, type SuggestionGroup } from "@/lib/automation-suggestions";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Draft = Schemas["UnderstandOut"];
type Auto = Schemas["AutomationOut"];

const EXAMPLES = [
  "Every Monday at 9 send me last week's sales",
  "Har din shaam 7 baje aaj ki payments batao on Telegram",
  "On the 1st of every month email last month's overdue invoices to ca@example.com",
];
const PERIODS: Record<string, string> = {
  today: "Today", yesterday: "Yesterday", last_7_days: "Last 7 days", last_week: "Last week (Mon–Sun)",
  this_month: "This month so far", last_month: "Last month", last_30_days: "Last 30 days",
  tomorrow: "Tomorrow", next_7_days: "Next 7 days",
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CHANNELS: Record<string, string> = { email: "Email to me", telegram: "My Telegram", slack: "The business's Slack", app: "Only in Kritvia" };

function Results({ ventureId, a, onClose }: { ventureId: string; a: Auto; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["automation-results", a.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/automations/{automation_id}/results", { params: { path: { venture_id: ventureId, automation_id: a.id } } })),
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={a.name} description={a.when}>
      <QueryState query={q} loading={<SkeletonRows rows={3} />}>
        {(rows: Schemas["ResultOut"][]) =>
          rows.length ? (
            <ul className="space-y-4">
              {rows.map((r) => (
                <li key={r.id} className="rounded-lg border border-border p-3">
                  <p className="mb-2 text-xs text-subtle">
                    {formatDateTime(r.created_at)} · {r.delivered ?? "kept here"}
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{r.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing yet" description="Results appear here after each run." />
          )
        }
      </QueryState>
    </Dialog>
  );
}

/** Ready-made automations: one tap fills the form below the request box. */
function Suggestions({ taken, onPick }: { taken: Set<string>; onPick: (s: Suggestion) => void }) {
  const groups = Object.keys(GROUPS) as SuggestionGroup[];
  const left = SUGGESTIONS.filter((x) => !taken.has(x.title.toLowerCase()));
  if (!left.length) return null;
  return (
    <Card>
      <CardHeader title="Suggestions" description="Ready to use: tap Add, check the time and where it goes, then save." />
      <div className="space-y-5 p-4 pt-0">
        {groups.map((g) => {
          const items = left.filter((x) => x.group === g);
          if (!items.length) return null;
          return (
            <section key={g}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">{GROUPS[g]}</h3>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((x) => (
                  <li key={x.id} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{x.title}</p>
                      <p className="text-xs text-muted">{x.why}</p>
                      <p className="mt-1 text-xs text-subtle">{describeSchedule(x.draft)}</p>
                    </div>
                    <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => onPick(x)} aria-label={`Add ${x.title}`}>
                      Add
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

/** Agents that already work on their own, with whether each is on for this business. */
function AgentIdeas({ ventureId, kind }: { ventureId: string; kind: string }) {
  const configs = useQuery({
    queryKey: ["workflow-configs", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: ventureId } } })),
  });
  const on = new Set((configs.data ?? []).filter((c) => c.enabled).map((c) => c.workflow));
  const items = AGENT_SUGGESTIONS.filter((a) => !a.kinds || a.kinds.includes(kind) || on.has(a.workflow));
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Bot className="h-4 w-4 text-accent" aria-hidden /> Agents that run by themselves</span>}
        description="These need no schedule from you: switch one on and it works every day, drafting for your yes."
      />
      <ul className="grid gap-2 p-4 pt-0 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((a) => (
          <li key={a.workflow} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                {a.title}
                {on.has(a.workflow) ? <Badge tone="success">on</Badge> : null}
              </p>
              <p className="text-xs text-muted">{a.what}</p>
            </div>
            <Link href={a.href(ventureId)} className="shrink-0 text-sm text-accent hover:underline">
              {on.has(a.workflow) ? "Settings" : "Set up"}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function AutomationsPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["automations", v.id] as const;
  const canWrite = v.access === "write";
  const list = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/automations", { params: { path: { venture_id: v.id } } })) });
  const [said, setSaid] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Auto | null>(null);
  const [also, setAlso] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const links = useQuery({
    queryKey: ["approver-links", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/approver-links", { params: { path: { venture_id: v.id } } })),
    enabled: canWrite,
  });
  const myTelegram = (links.data?.links ?? []).some((l) => l.mine && l.channel === "telegram");
  const pick = (x: Suggestion) => {
    // Telegram only when this person has linked their chat; otherwise email, so nothing goes unread.
    const channel = x.draft.channel === "telegram" && !myTelegram ? "email" : x.draft.channel;
    setDraft({ ...x.draft, channel, recipients: [], when: describeSchedule(x.draft) });
    setAlso("");
    setError(null);
    setTimeout(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  };
  const recipients = also.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const badEmail = recipients.find((x) => !EMAIL.test(x));

  const understand = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/automations/understand", { params: { path: { venture_id: v.id } }, body: { text: said.trim() } })),
    onSuccess: (d) => {
      setDraft(d);
      setAlso((d.recipients ?? []).join(", "));
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: (d: Draft) =>
      unwrap(
        api.POST("/ventures/{venture_id}/automations", {
          params: { path: { venture_id: v.id } },
          body: { name: d.name, task: d.task, period: d.period, freq: d.freq, weekdays: d.weekdays, day_of_month: d.day_of_month, at_time: d.at_time, channel: d.channel, recipients, said: d.said },
        }),
      ),
    onSuccess: (a) => {
      toast.success("Automation saved", `${a.when}. First run ${a.next_run_at ? formatRelative(a.next_run_at) : "soon"}.`);
      setDraft(null);
      setSaid("");
      setAlso("");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (a: Auto) => unwrap(api.PATCH("/ventures/{venture_id}/automations/{automation_id}", { params: { path: { venture_id: v.id, automation_id: a.id } }, body: { enabled: !a.enabled } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (a: Auto) => unwrap(api.DELETE("/ventures/{venture_id}/automations/{automation_id}", { params: { path: { venture_id: v.id, automation_id: a.id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error("Couldn't remove it", errorMessage(e)),
  });
  const runNow = useMutation({
    mutationFn: (a: Auto) => unwrap(api.POST("/ventures/{venture_id}/automations/{automation_id}/run", { params: { path: { venture_id: v.id, automation_id: a.id } } })),
    onSuccess: () => toast.success("Running", "The result will be here and wherever it's delivered in a few seconds."),
    onError: (e) => toast.error("Couldn't run it", errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={v.venture_name} title="Automations" description="Say what you want regularly, in plain words. Kritvia sets the schedule and does it." />
      {canWrite ? (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" aria-hidden /> New automation</span>} description="English, Hindi or Hinglish." />
          <form
            className="space-y-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (said.trim().length >= 3) understand.mutate();
            }}
          >
            <div className="flex gap-2">
              <Input value={said} onChange={(e) => setSaid(e.target.value)} maxLength={500} placeholder={EXAMPLES[0]} aria-label="What should Kritvia do regularly?" />
              <Button type="submit" variant="primary" loading={understand.isPending}>
                Set it up
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((x) => (
                <button key={x} type="button" className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:bg-surface-2" onClick={() => setSaid(x)}>
                  {x}
                </button>
              ))}
            </div>
            <FormError message={error} />
          </form>
          {draft ? (
            <div ref={panel} className="space-y-3 border-t border-border p-4">
              <p className="text-sm">
                <strong>{draft.when}</strong>: {draft.task} ({PERIODS[draft.period]?.toLowerCase()}).
              </p>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Name">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={80} />
                </Field>
                <Field label="Covers">
                  <Select value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value as Draft["period"] })}>
                    {Object.entries(PERIODS).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Time (IST)">
                  <Input type="time" value={draft.at_time} onChange={(e) => setDraft({ ...draft, at_time: e.target.value })} />
                </Field>
                <Field label="Send to">
                  <Select value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value as Draft["channel"] })}>
                    {Object.entries(CHANNELS).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Also email it to (optional)" hint="Your accountant or partner. Each email to someone else waits for your yes." error={badEmail ? `Not an email address: ${badEmail}` : undefined}>
                <Input value={also} onChange={(e) => setAlso(e.target.value)} placeholder="ca@example.com" maxLength={600} />
              </Field>
              <div className="flex gap-2">
                <Button variant="primary" loading={save.isPending} disabled={Boolean(badEmail) || recipients.length > 10} onClick={() => save.mutate(draft)}>
                  Save automation
                </Button>
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}
      <Card className="overflow-hidden p-0">
        <QueryState query={list} loading={<SkeletonRows rows={3} className="p-3" />}>
          {(rows: Auto[]) =>
            rows.length ? (
              <ul className="divide-y divide-border">
                {rows.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        <Repeat className="h-4 w-4 text-subtle" aria-hidden /> {a.name}
                        {!a.enabled ? <Badge>off</Badge> : null}
                        {a.last_error ? <Badge tone="danger">{a.last_error}</Badge> : null}
                      </p>
                      <p className="text-xs text-muted">
                        {a.when} · {PERIODS[a.period]} · {CHANNELS[a.channel]}
                        {a.next_run_at ? ` · next ${formatRelative(a.next_run_at)}` : ""} · by {a.owner}
                      </p>
                      <p className="text-xs text-subtle">&ldquo;{a.said}&rdquo;</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setViewing(a)}>
                        Results
                      </Button>
                      {a.mine || v.can_admin || v.is_owner ? (
                        <>
                          <Button size="sm" variant="ghost" icon={<Play className="h-4 w-4" />} onClick={() => runNow.mutate(a)}>
                            Run now
                          </Button>
                          <Switch checked={a.enabled} onChange={() => toggle.mutate(a)} label={`Run ${a.name} on its schedule`} />
                          <Button size="icon" variant="ghost" aria-label={`Remove ${a.name}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => remove.mutate(a)} />
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No automations yet" description="Pick one from the suggestions below, or write your own above." />
            )
          }
        </QueryState>
      </Card>
      {canWrite ? <Suggestions taken={new Set((list.data ?? []).map((a) => a.name.toLowerCase()))} onPick={pick} /> : null}
      <CustomWorkflows ventureId={v.id} canAdmin={Boolean(v.can_admin || v.is_owner)} />
      <AgentIdeas ventureId={v.id} kind={v.kind} />
      {viewing ? <Results ventureId={v.id} a={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
