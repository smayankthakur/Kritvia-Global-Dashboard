"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Receipt, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Field, FormError, Input, Select, Switch } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatINR } from "@/lib/format";
import { toCode } from "@/lib/slug";
import { useVenture } from "@/lib/venture";

type Unit = Schemas["RateItem-Input"]["unit"];
const UNITS = enumValues<Unit>()("project", "page", "screen", "integration", "hour", "month", "workflow", "assessment", "item");

interface Row {
  key: number;
  code: string;
  name: string;
  description: string;
  unit: Unit;
  rate_inr: string;
  min_units: string;
  active: boolean;
  isNew?: boolean;
}

const CODE_RE = /^[a-z0-9_]{2,40}$/;
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;

function toRows(items: Schemas["RateItem-Output"][]): Row[] {
  return items.map((i, n) => ({
    key: n,
    code: i.code,
    name: i.name,
    description: i.description ?? "",
    unit: i.unit,
    rate_inr: String(Number(i.rate_inr)),
    min_units: String(Number(i.min_units ?? 1)),
    active: i.active ?? true,
  }));
}

function validateRows(rows: Row[]): Record<string, string> {
  const errs: Record<string, string> = {};
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (!CODE_RE.test(r.code)) errs[`${i}.code`] = "2–40 chars: a–z, 0–9, _";
    else if (seen.has(r.code)) errs[`${i}.code`] = "Duplicate code";
    seen.add(r.code);
    if (!r.name.trim()) errs[`${i}.name`] = "Required";
    if (!MONEY_RE.test(r.rate_inr.trim())) errs[`${i}.rate_inr`] = "Amount in ₹, up to 2 decimals";
    const mu = Number(r.min_units);
    if (!Number.isFinite(mu) || mu <= 0) errs[`${i}.min_units`] = "Must be > 0";
  });
  return errs;
}

export default function RateCardPage() {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["rate-card", v.id], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/rate-card", { params: { path: { venture_id: v.id } } })) });
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (q.data && !dirty) setRows(toRows(q.data));
  }, [q.data, dirty]);

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/rate-card", {
          params: { path: { venture_id: v.id } },
          body: {
            items: rows.map((r) => ({
              code: r.code,
              name: r.name.trim(),
              description: r.description.trim(),
              unit: r.unit,
              rate_inr: r.rate_inr.trim(),
              min_units: r.min_units.trim(),
              active: r.active,
            })),
          },
        }),
      ),
    onSuccess: (items) => {
      qc.setQueryData(["rate-card", v.id], items);
      setDirty(false);
      setRows(toRows(items));
      toast.success("Rate card saved", `${items.filter((i) => i.active !== false).length} active item(s).`);
    },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        const mapped: Record<string, string> = {};
        for (const [k, msg] of Object.entries(e.fieldErrors)) mapped[k.replace(/^items\./, "")] = msg;
        setErrors(mapped);
      }
    },
  });

  const update = (key: number, patch: Partial<Row>) => {
    setDirty(true);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const add = () => {
    setDirty(true);
    setRows((rs) => [...rs, { key: Date.now(), code: "", name: "", description: "", unit: "project", rate_inr: "", min_units: "1", active: true, isNew: true }]);
  };
  const submit = () => {
    const errs = validateRows(rows);
    setErrors(errs);
    if (Object.keys(errs).length) {
      toast.error("Fix the highlighted fields");
      return;
    }
    save.mutate();
  };

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Rate card"
        description="Proposals are priced only from these rates (never by the model). Removing an item deactivates it; history is kept."
        actions={
          <>
            <Button icon={<Plus className="h-4 w-4" />} onClick={add}>
              Add item
            </Button>
            <Button variant="primary" icon={<Save className="h-4 w-4" />} onClick={submit} loading={save.isPending} disabled={!dirty}>
              Save rate card
            </Button>
          </>
        }
      />
      {save.isError && !(save.error instanceof ApiError && Object.keys(save.error.fieldErrors).length) ? (
        <FormError message={errorMessage(save.error)} />
      ) : null}
      {dirty ? (
        <Notice tone="info" className="mb-4">
          You have unsaved changes.
        </Notice>
      ) : null}
      <Card>
        {q.isPending ? (
          <SkeletonRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No rates yet"
            description="Add the services you sell — e.g. Next.js page, AI workflow, VAPT assessment — with a rate per unit."
            action={<Button onClick={add}>Add first item</Button>}
          />
        ) : (
          <div>
            <div className="hidden grid-cols-[10rem_1fr_9.5rem_9rem_6rem_4.5rem_2.5rem] gap-3 border-b border-border bg-surface-2/60 px-4 py-2 text-xs font-medium tracking-wide text-subtle uppercase lg:grid">
              <span>Code</span>
              <span>Name & description</span>
              <span>Unit</span>
              <span>Rate (₹)</span>
              <span>Min units</span>
              <span>Active</span>
              <span className="sr-only">Remove</span>
            </div>
            <ul className="divide-y divide-border">
              {rows.map((r, i) => (
                <li
                  key={r.key}
                  className={cn(
                    "grid grid-cols-2 gap-3 px-4 py-3 lg:grid-cols-[10rem_1fr_9.5rem_9rem_6rem_4.5rem_2.5rem] lg:items-start",
                    !r.active && "opacity-60",
                  )}
                >
                  <Field label="Code" srLabel error={errors[`${i}.code`]} className="col-span-2 lg:col-span-1">
                    <Input
                      value={r.code}
                      placeholder="nextjs_page"
                      disabled={!r.isNew}
                      className="font-mono text-[13px]"
                      onChange={(e) => update(r.key, { code: e.target.value.toLowerCase() })}
                    />
                  </Field>
                  <div className="col-span-2 space-y-2 lg:col-span-1">
                    <Field label="Name" srLabel error={errors[`${i}.name`]}>
                      <Input
                        value={r.name}
                        placeholder="Next.js page"
                        onChange={(e) => update(r.key, { name: e.target.value })}
                        onBlur={() => r.isNew && !r.code && r.name && update(r.key, { code: toCode(r.name) })}
                      />
                    </Field>
                    <Field label="Description" srLabel>
                      <Input value={r.description} placeholder="Description (optional)" onChange={(e) => update(r.key, { description: e.target.value })} className="text-[13px]" />
                    </Field>
                  </div>
                  <Field label="Unit" srLabel>
                    <Select value={r.unit} onChange={(e) => update(r.key, { unit: e.target.value as Unit })}>
                      {UNITS.map((u) => (
                        <option key={u} value={u}>
                          per {u}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Rate (₹)" srLabel error={errors[`${i}.rate_inr`]} hint={r.rate_inr && MONEY_RE.test(r.rate_inr) ? formatINR(r.rate_inr) : undefined}>
                    <Input inputMode="decimal" value={r.rate_inr} placeholder="25000" onChange={(e) => update(r.key, { rate_inr: e.target.value.replace(/[,₹\s]/g, "") })} className="tabular-nums" />
                  </Field>
                  <Field label="Min units" srLabel error={errors[`${i}.min_units`]}>
                    <Input inputMode="decimal" value={r.min_units} onChange={(e) => update(r.key, { min_units: e.target.value })} className="tabular-nums" />
                  </Field>
                  <div className="flex items-center gap-2 pt-2">
                    <Switch checked={r.active} onChange={(a) => update(r.key, { active: a })} label={`${r.name || "Item"} active`} />
                    <span className="text-xs text-subtle lg:hidden">{r.active ? "Active" : "Inactive"}</span>
                  </div>
                  <div className="flex justify-end pt-0.5">
                    {r.isNew ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove item"
                        onClick={() => {
                          setDirty(true);
                          setRows((rs) => rs.filter((x) => x.key !== r.key));
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : !r.active ? (
                      <Badge>off</Badge>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </>
  );
}
