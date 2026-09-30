"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { LoanOfficerNotice } from "@/components/loans/loan-officer-notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate, titleCase } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type ChecklistIn = Schemas["ChecklistIn"];
type RuleKind = Schemas["ChecklistRule"]["kind"];
type Severity = NonNullable<Schemas["ChecklistRule"]["severity"]>;
const RULE_KINDS = enumValues<RuleKind>()("same_name", "same_field", "pan_format", "coverage_months");
const SEVERITIES = enumValues<Severity>()("low", "medium", "high");
const CODE_RE = /^[a-z0-9_]{2,40}$/;

interface ItemRow {
  doc_type: string;
  label: string;
  min_count: string;
  max_age_days: string;
  required: boolean;
}
interface RuleRow {
  id: string;
  kind: RuleKind;
  severity: Severity;
  params: string;
}
interface Draft {
  loan_type: string;
  isNew: boolean;
  name: string;
  items: ItemRow[];
  rules: RuleRow[];
}

function toDraft(loanType: string, c: ChecklistIn, isNew: boolean): Draft {
  return {
    loan_type: loanType,
    isNew,
    name: c.name,
    items: c.items.map((i) => ({
      doc_type: i.doc_type,
      label: i.label,
      min_count: String(i.min_count ?? 1),
      max_age_days: i.max_age_days ? String(i.max_age_days) : "",
      required: i.required ?? true,
    })),
    rules: (c.rules ?? []).map((r) => ({ id: r.id, kind: r.kind, severity: r.severity ?? "medium", params: JSON.stringify(r.params ?? {}) })),
  };
}

function validate(d: Draft): { errors: Record<string, string>; body: ChecklistIn | null } {
  const errors: Record<string, string> = {};
  if (!CODE_RE.test(d.loan_type)) errors.loan_type = "lower_snake_case, 2–40 chars";
  if (!d.name.trim()) errors.name = "Required";
  if (!d.items.length) errors.items = "Add at least one document";
  const items: ChecklistIn["items"] = [];
  d.items.forEach((it, i) => {
    if (!CODE_RE.test(it.doc_type)) errors[`items.${i}.doc_type`] = "lower_snake_case";
    if (!it.label.trim()) errors[`items.${i}.label`] = "Required";
    const mc = Number(it.min_count);
    if (!Number.isInteger(mc) || mc < 1 || mc > 24) errors[`items.${i}.min_count`] = "1–24";
    const age = it.max_age_days ? Number(it.max_age_days) : null;
    if (age !== null && (!Number.isInteger(age) || age < 1 || age > 3650)) errors[`items.${i}.max_age_days`] = "1–3650 days";
    items.push({ doc_type: it.doc_type, label: it.label.trim(), min_count: mc, max_age_days: age, required: it.required });
  });
  const rules: NonNullable<ChecklistIn["rules"]> = [];
  d.rules.forEach((r, i) => {
    if (!/^[a-z0-9_]{2,60}$/.test(r.id)) errors[`rules.${i}.id`] = "lower_snake_case";
    let params: Record<string, unknown> = {};
    try {
      const p = JSON.parse(r.params || "{}");
      if (typeof p !== "object" || Array.isArray(p) || p === null) throw new Error();
      params = p;
    } catch {
      errors[`rules.${i}.params`] = "Must be a JSON object";
    }
    if (r.kind === "same_field" && !params.field) errors[`rules.${i}.params`] = 'Needs {"field": "dob"}';
    if (r.kind === "coverage_months" && (!params.doc_type || !params.months)) errors[`rules.${i}.params`] = 'Needs {"doc_type": "...", "months": 6}';
    rules.push({ id: r.id, kind: r.kind, severity: r.severity, params });
  });
  return { errors, body: Object.keys(errors).length ? null : { name: d.name.trim(), items, rules } };
}

function Editor({ draft, onClose, ventureId }: { draft: Draft; onClose: () => void; ventureId: string }) {
  const [d, setD] = useState(draft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (body: ChecklistIn) =>
      unwrap(api.PUT("/ventures/{venture_id}/checklists/{loan_type}", { params: { path: { venture_id: ventureId, loan_type: d.loan_type } }, body })),
    onSuccess: (c) => {
      toast.success(`Checklist saved (version ${c.version})`, "Earlier versions stay for the audit trail.");
      void qc.invalidateQueries({ queryKey: ["checklists", ventureId] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
    },
  });
  const setItem = (i: number, patch: Partial<ItemRow>) => setD((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const setRule = (i: number, patch: Partial<RuleRow>) => setD((x) => ({ ...x, rules: x.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const submit = () => {
    const { errors: errs, body } = validate(d);
    setErrors(errs);
    if (body) save.mutate(body);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={d.isNew ? "New checklist" : `Edit checklist · ${d.loan_type}`}
      description="Saving creates a new version. Truhome's compliance advisor should confirm the documents and rules."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save new version
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <FormError message={save.isError && !(save.error instanceof ApiError && Object.keys(save.error.fieldErrors).length) ? errorMessage(save.error) : null} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Loan type" error={errors.loan_type} hint="e.g. home_loan_salaried" required>
            <Input value={d.loan_type} disabled={!d.isNew} onChange={(e) => setD({ ...d, loan_type: e.target.value.toLowerCase() })} className="font-mono text-[13px]" />
          </Field>
          <Field label="Checklist name" error={errors.name} required>
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} maxLength={200} />
          </Field>
        </div>
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Required documents</h3>
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setD((x) => ({ ...x, items: [...x.items, { doc_type: "", label: "", min_count: "1", max_age_days: "", required: true }] }))}
            >
              Add document
            </Button>
          </div>
          {errors.items ? <p className="mb-2 text-xs text-danger">{errors.items}</p> : null}
          <div className="space-y-2">
            {d.items.map((it, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 sm:grid-cols-[9rem_1fr_5rem_6rem_5.5rem_2.25rem] sm:items-start">
                <Field label="Doc type" srLabel error={errors[`items.${i}.doc_type`]}>
                  <Input value={it.doc_type} placeholder="bank_statement" onChange={(e) => setItem(i, { doc_type: e.target.value.toLowerCase() })} className="font-mono text-[13px]" />
                </Field>
                <Field label="Label" srLabel error={errors[`items.${i}.label`]}>
                  <Input value={it.label} placeholder="Bank statements (6 months)" onChange={(e) => setItem(i, { label: e.target.value })} />
                </Field>
                <Field label="Min count" srLabel error={errors[`items.${i}.min_count`]}>
                  <Input type="number" min={1} max={24} value={it.min_count} onChange={(e) => setItem(i, { min_count: e.target.value })} title="Minimum count" />
                </Field>
                <Field label="Max age (days)" srLabel error={errors[`items.${i}.max_age_days`]}>
                  <Input type="number" min={1} value={it.max_age_days} placeholder="Max age" onChange={(e) => setItem(i, { max_age_days: e.target.value })} title="Maximum age in days" />
                </Field>
                <label className="flex h-9 items-center gap-2 text-xs text-muted">
                  <Switch checked={it.required} onChange={(r) => setItem(i, { required: r })} label="Required" /> Required
                </label>
                <Button variant="ghost" size="icon" aria-label={`Remove ${it.label || "document"}`} onClick={() => setD((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Consistency rules</h3>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setD((x) => ({ ...x, rules: [...x.rules, { id: "", kind: "same_name", severity: "medium", params: "{}" }] }))}>
              Add rule
            </Button>
          </div>
          <div className="space-y-2">
            {d.rules.map((r, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-md border border-border p-2 sm:grid-cols-[10rem_10rem_7rem_1fr_2.25rem] sm:items-start">
                <Field label="Rule id" srLabel error={errors[`rules.${i}.id`]}>
                  <Input value={r.id} placeholder="name_consistent" onChange={(e) => setRule(i, { id: e.target.value.toLowerCase() })} className="font-mono text-[13px]" />
                </Field>
                <Field label="Kind" srLabel>
                  <Select value={r.kind} onChange={(e) => setRule(i, { kind: e.target.value as RuleKind })}>
                    {RULE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {titleCase(k)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Severity" srLabel>
                  <Select value={r.severity} onChange={(e) => setRule(i, { severity: e.target.value as Severity })}>
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Params (JSON)" srLabel error={errors[`rules.${i}.params`]} className="col-span-2 sm:col-span-1">
                  <Textarea rows={1} value={r.params} onChange={(e) => setRule(i, { params: e.target.value })} className="font-mono text-xs" />
                </Field>
                <Button variant="ghost" size="icon" aria-label="Remove rule" onClick={() => setD((x) => ({ ...x, rules: x.rules.filter((_, j) => j !== i) }))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {!d.rules.length ? <p className="text-sm text-subtle">No rules — only presence and age are checked.</p> : null}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

export default function ChecklistsPage() {
  const v = useVenture();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const q = useQuery({ queryKey: ["checklists", v.id], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/checklists", { params: { path: { venture_id: v.id } } })) });
  const template = useMutation({
    mutationFn: () => unwrap(api.GET("/checklists/template")),
    onSuccess: (t) => setDraft(toDraft("home_loan_salaried", t, true)),
    onError: (e) => toast.error("Could not load template", errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Lending checklists"
        description="What each loan type needs, and the consistency rules the verification agent applies."
        actions={
          <>
            <Button onClick={() => setDraft({ loan_type: "", isNew: true, name: "", items: [], rules: [] })}>Blank checklist</Button>
            <Button variant="primary" loading={template.isPending} onClick={() => template.mutate()}>
              Start from template
            </Button>
          </>
        }
      />
      <LoanOfficerNotice ventureId={v.id} roles={v.roles} />
      <QueryState
        query={q}
        empty={
          <Card>
            <EmptyState
              icon={ClipboardCheck}
              title="No checklists yet"
              description="Without one, verification uses the built-in home-loan (salaried) default. Start from the template to customise it."
            />
          </Card>
        }
      >
        {(data) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {data.map((c) => (
              <Card key={c.id}>
                <CardHeader
                  title={c.name}
                  description={
                    <span className="font-mono">
                      {c.loan_type} · v{c.version} · {formatDate(c.created_at)}
                    </span>
                  }
                  actions={<Button size="sm" onClick={() => setDraft(toDraft(c.loan_type, c, false))}>Edit</Button>}
                />
                <ul className="divide-y divide-border">
                  {c.items.map((i) => (
                    <li key={i.doc_type} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                      <span>{i.label}</span>
                      <span className="flex shrink-0 gap-1">
                        {i.min_count && i.min_count > 1 ? <Badge>×{i.min_count}</Badge> : null}
                        {i.max_age_days ? <Badge>≤ {i.max_age_days} d old</Badge> : null}
                        {i.required === false ? <Badge tone="info">optional</Badge> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {c.rules?.length ? (
                  <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
                    {c.rules.map((r) => (
                      <Badge key={r.id} tone={r.severity === "high" ? "danger" : r.severity === "low" ? "neutral" : "warning"}>
                        {titleCase(r.id)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </QueryState>
      {draft ? <Editor draft={draft} onClose={() => setDraft(null)} ventureId={v.id} /> : null}
    </>
  );
}
