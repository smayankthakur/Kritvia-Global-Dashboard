"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime, fromISTInput, toISTInput, titleCase } from "@/lib/format";

type Severity = Schemas["BreachIn"]["severity"];
type BStatus = NonNullable<Schemas["BreachPatch"]["status"]>;
const SEVERITIES = enumValues<Severity>()("low", "medium", "high", "critical");
const STATUSES = enumValues<BStatus>()("open", "contained", "closed");
type Breach = Schemas["BreachOut"];

function UpdateBreach({ breach, ventureId, onClose }: { breach: Breach | null; ventureId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<BStatus | "">("");
  const [containment, setContainment] = useState("");
  const [board, setBoard] = useState(false);
  const [principals, setPrincipals] = useState(false);
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/ventures/{venture_id}/breaches/{breach_id}", {
          params: { path: { venture_id: ventureId, breach_id: breach!.id } },
          body: { status: status || null, containment: containment.trim() || null, board_notified: board || null, principals_notified: principals || null },
        }),
      ),
    onSuccess: () => {
      toast.success("Breach record updated");
      void qc.invalidateQueries({ queryKey: ["breaches", ventureId] });
      onClose();
    },
  });
  if (!breach) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Update breach"
      description={breach.summary.slice(0, 140)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={m.isError ? errorMessage(m.error) : null} />
        <Field label="Status">
          <Select value={status || breach.status} onChange={(e) => setStatus(e.target.value as BStatus)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Containment steps" hint={breach.containment ? `Current: ${breach.containment.slice(0, 80)}` : undefined}>
          <Textarea rows={3} value={containment} maxLength={5000} onChange={(e) => setContainment(e.target.value)} />
        </Field>
        <Checkbox
          label="Data Protection Board notified"
          hint={breach.board_notified_at ? `Notified ${formatDateTime(breach.board_notified_at)}` : "Records the time of notification"}
          checked={board || Boolean(breach.board_notified_at)}
          disabled={Boolean(breach.board_notified_at)}
          onChange={(e) => setBoard(e.target.checked)}
        />
        <Checkbox
          label="Affected data principals notified"
          hint={breach.principals_notified_at ? `Notified ${formatDateTime(breach.principals_notified_at)}` : undefined}
          checked={principals || Boolean(breach.principals_notified_at)}
          disabled={Boolean(breach.principals_notified_at)}
          onChange={(e) => setPrincipals(e.target.checked)}
        />
      </div>
    </Dialog>
  );
}

export function Breaches({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["breaches", ventureId], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/breaches", { params: { path: { venture_id: ventureId } } })) });
  const [f, setF] = useState({ detected_at: toISTInput(new Date()), summary: "", severity: "medium" as Severity, affected: "", data_classes: "", containment: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Breach | null>(null);

  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/breaches", {
          params: { path: { venture_id: ventureId } },
          body: {
            detected_at: fromISTInput(f.detected_at),
            summary: f.summary.trim(),
            severity: f.severity,
            affected_principals: f.affected.trim() ? Number(f.affected) : null,
            data_classes: f.data_classes.split(",").map((s) => s.trim()).filter(Boolean),
            containment: f.containment.trim() || null,
          },
        }),
      ),
    onSuccess: () => {
      toast.success("Breach recorded");
      setF({ ...f, summary: "", affected: "", data_classes: "", containment: "" });
      void qc.invalidateQueries({ queryKey: ["breaches", ventureId] });
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.detected_at) errs.detected_at = "When was it detected?";
    if (f.summary.trim().length < 3) errs.summary = "Describe what happened";
    if (f.affected.trim() && !(Number.isInteger(Number(f.affected)) && Number(f.affected) >= 0)) errs.affected_principals = "Whole number";
    setErrors(errs);
    if (!Object.keys(errs).length) add.mutate();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader title="Breach register" description="Personal-data breaches and their handling, including notifications" />
        <QueryState query={q} empty={<EmptyState icon={ShieldAlert} title="No breaches recorded" description="Record any suspected personal-data breach here as soon as it is detected." />}>
          {(data) => (
            <ul className="divide-y divide-border">
              {data.map((b) => (
                <li key={b.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={b.severity} />
                      <StatusBadge status={b.status} />
                      <span className="text-xs text-subtle">detected {formatDateTime(b.detected_at)}</span>
                    </div>
                    <p className="mt-1 text-sm">{b.summary}</p>
                    <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-subtle">
                      {b.affected_principals !== null ? <span>{b.affected_principals} affected</span> : null}
                      {b.data_classes.map((d) => (
                        <Badge key={d}>{d}</Badge>
                      ))}
                      <Badge tone={b.board_notified_at ? "success" : "warning"}>Board {b.board_notified_at ? "notified" : "not notified"}</Badge>
                      <Badge tone={b.principals_notified_at ? "success" : "warning"}>Principals {b.principals_notified_at ? "notified" : "not notified"}</Badge>
                    </p>
                    {b.containment ? <p className="mt-1 text-xs text-muted">Containment: {b.containment}</p> : null}
                  </div>
                  {canAdmin ? (
                    <Button size="sm" onClick={() => setEditing(b)}>
                      Update
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Record a breach" />
        {!canAdmin ? (
          <Notice tone="info" className="m-3">
            Only a venture admin or owner can record breaches.
          </Notice>
        ) : (
          <form onSubmit={submit} noValidate className="space-y-3 p-4">
            <FormError message={add.isError && !Object.keys(errors).length ? errorMessage(add.error) : null} />
            <Field label="Detected at (IST)" error={errors.detected_at} required>
              <Input type="datetime-local" value={f.detected_at} onChange={(e) => setF({ ...f, detected_at: e.target.value })} />
            </Field>
            <Field label="What happened" error={errors.summary} required>
              <Textarea rows={3} value={f.summary} maxLength={5000} onChange={(e) => setF({ ...f, summary: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Severity">
                <Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as Severity })}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {titleCase(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="People affected" error={errors.affected_principals}>
                <Input inputMode="numeric" value={f.affected} onChange={(e) => setF({ ...f, affected: e.target.value })} />
              </Field>
            </div>
            <Field label="Data involved" hint="Comma-separated, e.g. email, pan, bank_statement">
              <Input value={f.data_classes} onChange={(e) => setF({ ...f, data_classes: e.target.value })} />
            </Field>
            <Field label="Containment so far">
              <Textarea rows={2} value={f.containment} maxLength={5000} onChange={(e) => setF({ ...f, containment: e.target.value })} />
            </Field>
            <Button type="submit" variant="primary" loading={add.isPending} className="w-full">
              Record breach
            </Button>
          </form>
        )}
      </Card>
      <UpdateBreach breach={editing} ventureId={ventureId} onClose={() => setEditing(null)} />
    </div>
  );
}
