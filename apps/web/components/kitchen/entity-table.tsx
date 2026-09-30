"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Paths } from "@/lib/api";
import { formatINR } from "@/lib/format";
import { ImportResult } from "./csv-import";

export type RefEntity = Paths["/ventures/{venture_id}/kitchen/ref/{entity}"]["get"]["parameters"]["path"]["entity"];

export interface Column {
  key: string;
  label: string;
  type?: "text" | "number" | "money" | "email" | "bool" | "select";
  options?: readonly string[];
  required?: boolean;
  pattern?: RegExp;
  hint?: string;
  hideBelow?: "sm" | "md" | "lg";
  mono?: boolean;
}

type Row = Record<string, unknown>;

const HIDE: Record<string, string> = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" };

function toForm(cols: Column[], row: Row | null): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const c of cols) {
    const v = row?.[c.key];
    out[c.key] = c.type === "bool" ? (v === undefined || v === null ? true : Boolean(v)) : v === undefined || v === null ? "" : String(v);
  }
  return out;
}

export function refKey(ventureId: string, entity: string) {
  return ["kitchen", ventureId, "ref", entity] as const;
}

export function useRefData(ventureId: string, entity: RefEntity) {
  return useQuery({
    queryKey: refKey(ventureId, entity),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/kitchen/ref/{entity}", { params: { path: { venture_id: ventureId, entity } } })),
  });
}

/** Table of reference data with inline add/edit, saved with PUT /kitchen/ref/{entity}. */
export function EntityTable({ ventureId, entity, columns, noun }: { ventureId: string; entity: RefEntity; columns: Column[]; noun: string }) {
  const q = useRefData(ventureId, entity);
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null); // code or "__new"
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ upserted: number; errors: string[] } | null>(null);

  const save = useMutation({
    mutationFn: (item: Row) =>
      unwrap(api.PUT("/ventures/{venture_id}/kitchen/ref/{entity}", { params: { path: { venture_id: ventureId, entity } }, body: { items: [item] } })),
    onSuccess: (out) => {
      if (out.errors.length) {
        setResult(out);
        return;
      }
      toast.success(`${noun} saved`);
      setEditing(null);
      setResult(null);
      void qc.invalidateQueries({ queryKey: ["kitchen", ventureId] });
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });

  const start = (row: Row | null) => {
    setForm(toForm(columns, row));
    setErrors({});
    setResult(null);
    setEditing(row ? String(row.code) : "__new");
  };

  const submit = () => {
    const errs: Record<string, string> = {};
    const item: Row = {};
    for (const c of columns) {
      const v = form[c.key];
      if (c.type === "bool") {
        item[c.key] = Boolean(v);
        continue;
      }
      const s = String(v ?? "").trim();
      if (!s) {
        if (c.required) errs[c.key] = "Required";
        continue;
      }
      if (c.pattern && !c.pattern.test(s)) errs[c.key] = c.hint ?? "Invalid";
      if ((c.type === "number" || c.type === "money") && !Number.isFinite(Number(s))) errs[c.key] = "Number";
      item[c.key] = c.type === "number" ? Number(s) : s;
    }
    setErrors(errs);
    if (!Object.keys(errs).length) save.mutate(item);
  };

  const editor = (key: string) => (
    <Tr key={key} className="bg-accent-soft/30">
      {columns.map((c) => (
        <Td key={c.key}>
          <label className="sr-only" htmlFor={`${key}-${c.key}`}>
            {c.label}
          </label>
          {c.type === "bool" ? (
            <input
              id={`${key}-${c.key}`}
              type="checkbox"
              checked={Boolean(form[c.key])}
              onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.checked }))}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          ) : c.type === "select" ? (
            <Select id={`${key}-${c.key}`} value={String(form[c.key] ?? "")} onChange={(e) => setForm((f) => ({ ...f, [c.key]: e.target.value }))} className="h-8 min-w-24">
              <option value="">—</option>
              {c.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id={`${key}-${c.key}`}
              value={String(form[c.key] ?? "")}
              disabled={c.key === "code" && key !== "__new"}
              inputMode={c.type === "number" || c.type === "money" ? "decimal" : undefined}
              type={c.type === "email" ? "email" : "text"}
              aria-invalid={Boolean(errors[c.key]) || undefined}
              title={errors[c.key]}
              onChange={(e) => setForm((f) => ({ ...f, [c.key]: c.key === "code" ? e.target.value.toLowerCase() : e.target.value }))}
              className={`h-8 min-w-24 ${c.mono ? "font-mono text-[13px]" : ""}`}
            />
          )}
          {errors[c.key] ? <p className="mt-0.5 text-[11px] text-danger">{errors[c.key]}</p> : null}
        </Td>
      ))}
      <Td className="text-right whitespace-nowrap">
        <div className="flex justify-end gap-1">
          <Button size="sm" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </div>
      </Td>
    </Tr>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <p className="text-xs text-subtle">{q.data ? `${q.data.length} ${noun.toLowerCase()}(s)` : " "}</p>
        <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => start(null)} disabled={editing !== null}>
          Add {noun.toLowerCase()}
        </Button>
      </div>
      {result ? (
        <div className="p-3">
          <ImportResult result={result} />
        </div>
      ) : null}
      <QueryState
        query={q}
        isEmpty={(d) => d.length === 0 && editing === null}
        empty={<EmptyState title={`No ${noun.toLowerCase()}s yet`} description="Add them one by one or import a CSV below." />}
      >
        {(data) => (
          <Table label={`${noun}s`}>
            <THead>
              <tr>
                {columns.map((c) => (
                  <Th key={c.key} className={editing ? undefined : c.hideBelow ? HIDE[c.hideBelow] : undefined}>
                    {c.label}
                  </Th>
                ))}
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {editing === "__new" ? editor("__new") : null}
              {data.map((row) =>
                editing === String(row.code) ? (
                  editor(String(row.code))
                ) : (
                  <Tr key={String(row.code)}>
                    {columns.map((c) => {
                      const v = row[c.key];
                      return (
                        <Td key={c.key} className={`${editing ? "" : c.hideBelow ? HIDE[c.hideBelow] : ""} ${c.mono ? "font-mono text-[13px]" : ""}`}>
                          {c.type === "bool" ? (
                            v === false ? <Badge>no</Badge> : <Badge tone="success">yes</Badge>
                          ) : c.type === "money" ? (
                            formatINR(v as string | number | null)
                          ) : v === null || v === undefined || v === "" ? (
                            <span className="text-subtle">—</span>
                          ) : (
                            String(v)
                          )}
                        </Td>
                      );
                    })}
                    <Td className="text-right">
                      <Button size="sm" variant="ghost" aria-label={`Edit ${String(row.name ?? row.code)}`} icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => start(row)} disabled={editing !== null}>
                        <span className="hidden sm:inline">Edit</span>
                      </Button>
                    </Td>
                  </Tr>
                ),
              )}
            </TBody>
          </Table>
        )}
      </QueryState>
    </div>
  );
}
