"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { titleCase } from "@/lib/format";

type DataClass = Schemas["RetentionIn"]["data_class"];
const CLASSES = enumValues<DataClass>()("upload", "email", "drive", "transcript", "meeting", "note", "proposal", "loan_document", "report");

export function Retention({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["retention", ventureId], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/retention", { params: { path: { venture_id: ventureId } } })) });
  const [rows, setRows] = useState<Record<string, { days: string; note: string }>>({});
  const [bad, setBad] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    const next: Record<string, { days: string; note: string }> = {};
    for (const c of CLASSES) {
      const p = q.data.find((r) => r.data_class === c);
      next[c] = { days: p ? String(p.retain_days) : "", note: p?.note ?? "" };
    }
    setRows(next);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (c: DataClass) =>
      unwrap(
        api.PUT("/ventures/{venture_id}/retention", {
          params: { path: { venture_id: ventureId } },
          body: { data_class: c, retain_days: Number(rows[c]!.days), note: rows[c]!.note.trim() || null },
        }),
      ),
    onSuccess: (data, c) => {
      qc.setQueryData(["retention", ventureId], data);
      toast.success(`Retention for ${titleCase(c)} saved`);
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });

  const saveRow = (c: DataClass) => {
    const n = Number(rows[c]?.days);
    if (!Number.isInteger(n) || n < 1 || n > 36500) {
      setBad(c);
      return;
    }
    setBad(null);
    save.mutate(c);
  };

  return (
    <Card>
      <CardHeader title="Retention policies" description="How long each kind of data is kept. Applies to data ingested from now on; existing items keep their deadline." />
      {!canAdmin ? (
        <Notice tone="info" className="m-3">
          Only a venture admin or owner can change retention.
        </Notice>
      ) : null}
      {q.isPending ? (
        <SkeletonRows />
      ) : q.isError ? (
        <ErrorState error={q.error} />
      ) : (
        <Table label="Retention">
          <THead>
            <tr>
              <Th>Data class</Th>
              <Th className="w-36">Keep for (days)</Th>
              <Th className="hidden md:table-cell">Note</Th>
              <Th>
                <span className="sr-only">Save</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {CLASSES.map((c) => {
              const r = rows[c] ?? { days: "", note: "" };
              const current = q.data.find((x) => x.data_class === c);
              const changed = String(current?.retain_days ?? "") !== r.days || (current?.note ?? "") !== r.note;
              return (
                <Tr key={c}>
                  <Td>
                    <span className="font-medium">{titleCase(c)}</span>
                    {!current ? <span className="block text-xs text-subtle">no policy — kept until deleted</span> : null}
                  </Td>
                  <Td>
                    <label htmlFor={`ret-${c}`} className="sr-only">
                      Days to keep {c}
                    </label>
                    <Input
                      id={`ret-${c}`}
                      inputMode="numeric"
                      value={r.days}
                      disabled={!canAdmin}
                      aria-invalid={bad === c || undefined}
                      placeholder="e.g. 365"
                      onChange={(e) => setRows((x) => ({ ...x, [c]: { ...r, days: e.target.value } }))}
                      className="h-8"
                    />
                    {bad === c ? <p className="mt-0.5 text-[11px] text-danger">1–36500</p> : null}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <label htmlFor={`note-${c}`} className="sr-only">
                      Note for {c}
                    </label>
                    <Input id={`note-${c}`} value={r.note} disabled={!canAdmin} maxLength={500} onChange={(e) => setRows((x) => ({ ...x, [c]: { ...r, note: e.target.value } }))} className="h-8" />
                  </Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      icon={<Save className="h-3.5 w-3.5" />}
                      disabled={!canAdmin || !changed || !r.days}
                      loading={save.isPending && save.variables === c}
                      onClick={() => saveRow(c)}
                    >
                      Save
                    </Button>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
