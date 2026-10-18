"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Play, Trash2, Workflow } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { TimeField } from "@/components/ui/time-field";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type Custom = Schemas["CustomOut"];
type In = Schemas["CustomIn"];

export const TRIGGERS: Record<In["trigger"], { label: string; days: string }> = {
  invoice_overdue: { label: "An invoice is overdue", days: "Days after the due date" },
  invoice_paid: { label: "An invoice is paid", days: "Days after it's paid" },
  booking_done: { label: "A booking is done", days: "Days after the booking" },
  lead_new: { label: "A new lead comes in", days: "Days after it comes in" },
  lead_quiet: { label: "A lead goes quiet", days: "Days with no change" },
};
const ACTIONS: Record<In["action"], string> = {
  email: "Draft an email to the customer (sent after your yes)",
  notify: "Send me a note (Telegram if linked, else email)",
};
const IDEAS: In[] = [
  { name: "Gentle payment nudge", trigger: "invoice_overdue", wait_days: 3, action: "email", at_time: "10:00", instructions: "Remind them kindly that the invoice is due and offer to split the payment in two if that helps." },
  { name: "Thank-you and review", trigger: "invoice_paid", wait_days: 1, action: "email", at_time: "11:00", instructions: "Thank them for the payment and ask, in one line, for a Google review." },
  { name: "After-visit check-in", trigger: "booking_done", wait_days: 2, action: "email", at_time: "18:00", instructions: "Ask how they're finding it and whether they'd like to book the next visit. Keep it short and warm." },
  { name: "Call today's new leads", trigger: "lead_new", wait_days: 0, action: "notify", at_time: "09:30", instructions: "Tell me who came in, what they want and the one question to ask on the call." },
  { name: "Revive quiet leads", trigger: "lead_quiet", wait_days: 7, action: "email", at_time: "10:30", instructions: "Hinglish mein ek chhota sa follow-up likho, poochho ki koi sawaal hai kya. No pressure." },
];
const EMPTY: In = { name: "", trigger: "invoice_overdue", wait_days: 3, action: "email", at_time: "10:00", instructions: "" };

function Editor({ ventureId, onDone }: { ventureId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<In>(EMPTY);
  const make = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/custom-workflows", { params: { path: { venture_id: ventureId } }, body: { ...d, name: d.name.trim(), instructions: d.instructions.trim() } })),
    onSuccess: (c) => {
      toast.success("Custom workflow saved", `${c.when}. Checked daily at ${c.at_time}.`);
      setD(EMPTY);
      onDone();
      void qc.invalidateQueries({ queryKey: ["custom-workflows", ventureId] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    make.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 border-t border-border p-4">
      <div className="flex flex-wrap gap-2">
        {IDEAS.map((x) => (
          <button key={x.name} type="button" className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:bg-surface-2" onClick={() => setD(x)}>
            {x.name}
          </button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Name" className="sm:col-span-2">
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={80} placeholder="Gentle payment nudge" />
        </Field>
        <Field label="When">
          <Select value={d.trigger} onChange={(e) => setD({ ...d, trigger: e.target.value as In["trigger"] })}>
            {Object.entries(TRIGGERS).map(([k, t]) => (
              <option key={k} value={k}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={TRIGGERS[d.trigger].days}>
          <Input type="number" min={0} max={90} value={d.wait_days} onChange={(e) => setD({ ...d, wait_days: Math.max(0, Math.min(90, Number(e.target.value) || 0)) })} />
        </Field>
      </div>
      <Field label="What should it write?" hint="Plain words, in English, Hindi or Hinglish. Amounts and dates come from the record, never made up.">
        <Textarea rows={3} value={d.instructions} onChange={(e) => setD({ ...d, instructions: e.target.value })} maxLength={2000} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Then" className="sm:col-span-3">
          <Select value={d.action} onChange={(e) => setD({ ...d, action: e.target.value as In["action"] })}>
            {Object.entries(ACTIONS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Check daily at (IST)">
          <TimeField value={d.at_time} onChange={(t) => setD({ ...d, at_time: t })} />
        </Field>
      </div>
      <FormError message={make.isError ? errorMessage(make.error) : null} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={make.isPending} disabled={!d.name.trim() || d.instructions.trim().length < 3}>
          Save workflow
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function CustomWorkflows({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const key = ["custom-workflows", ventureId] as const;
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/custom-workflows", { params: { path: { venture_id: ventureId } } })) });
  const path = (c: Custom) => ({ params: { path: { venture_id: ventureId, custom_id: c.id } } });
  const toggle = useMutation({
    mutationFn: (c: Custom) => unwrap(api.PATCH("/ventures/{venture_id}/custom-workflows/{custom_id}", { ...path(c), body: { enabled: !c.enabled } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (c: Custom) => unwrap(api.DELETE("/ventures/{venture_id}/custom-workflows/{custom_id}", path(c))),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error("Couldn't remove it", errorMessage(e)),
  });
  const run = useMutation({
    mutationFn: (c: Custom) => unwrap(api.POST("/ventures/{venture_id}/custom-workflows/{custom_id}/run", path(c))),
    onSuccess: () => toast.success("Checking now", "Emails wait for your yes in Approvals; notes come to you."),
    onError: (e) => toast.error("Couldn't run it", errorMessage(e)),
  });

  return (
    <Card className="overflow-hidden p-0">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Workflow className="h-4 w-4 text-accent" aria-hidden /> Custom workflows
          </span>
        }
        description="Your own agents: when something happens to an invoice, booking or lead, Kritvia writes what you asked for. Emails to customers always wait for your yes."
        actions={
          q.data?.available && canAdmin && !adding ? (
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              New workflow
            </Button>
          ) : null
        }
      />
      <QueryState query={q} loading={<SkeletonRows rows={2} className="p-3" />}>
        {(d) =>
          !d.available ? (
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm text-muted">
                <Lock className="h-4 w-4" aria-hidden /> Custom workflows are on the Scale and Enterprise plans.
              </p>
              <Link href="/billing" className="text-sm text-accent hover:underline">
                See plans
              </Link>
            </CardBody>
          ) : (
            <>
              {adding ? <Editor ventureId={ventureId} onDone={() => setAdding(false)} /> : null}
              {d.items.length ? (
                <ul className="divide-y divide-border border-t border-border">
                  {d.items.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          {c.name}
                          {!c.enabled ? <Badge>off</Badge> : null}
                          {c.last_error ? <Badge tone="danger">{c.last_error}</Badge> : null}
                        </p>
                        <p className="text-xs text-muted">
                          {c.when} · {c.action === "email" ? "email to the customer" : "note to you"} · daily at {c.at_time}
                          {c.enabled && c.next_run_at ? ` · next ${formatRelative(c.next_run_at)}` : ""}
                        </p>
                        <p className="text-xs text-subtle">&ldquo;{c.instructions}&rdquo;</p>
                      </div>
                      {canAdmin ? (
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" icon={<Play className="h-4 w-4" />} onClick={() => run.mutate(c)}>
                            Run now
                          </Button>
                          <Switch checked={c.enabled} onChange={() => toggle.mutate(c)} label={`Run ${c.name} every day`} />
                          <Button size="icon" variant="ghost" aria-label={`Remove ${c.name}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => remove.mutate(c)} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : !adding ? (
                <EmptyState title="No custom workflows yet" description={canAdmin ? "Choose New workflow and pick an idea to start from." : "The business's admins can add them."} />
              ) : null}
            </>
          )
        }
      </QueryState>
    </Card>
  );
}
