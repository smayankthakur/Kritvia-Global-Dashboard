"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select, Switch } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { accessKey } from "@/lib/access";
import { KIND_LABEL } from "@/lib/nav";

type Kind = NonNullable<Schemas["VentureSettingsIn"]["kind"]>;
const KINDS = enumValues<Kind>()("software", "finance", "kitchen", "general");

export function GeneralSettings({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["settings", ventureId], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/settings", { params: { path: { venture_id: ventureId } } })) });
  const [kind, setKind] = useState<Kind>("general");
  const [threshold, setThreshold] = useState("30");
  const [peopleHints, setPeopleHints] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) {
      setKind((KINDS as readonly string[]).includes(q.data.kind) ? (q.data.kind as Kind) : "general");
      setThreshold(String(q.data.trust_threshold));
      setPeopleHints(Boolean(q.data.speech_people_hints));
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT("/ventures/{venture_id}/settings", { params: { path: { venture_id: ventureId } }, body: { kind, trust_threshold: Number(threshold), speech_people_hints: peopleHints } })),
    onSuccess: (d) => {
      qc.setQueryData(["settings", ventureId], d);
      void qc.invalidateQueries({ queryKey: accessKey });
      void qc.invalidateQueries({ queryKey: ["trust", ventureId] });
      toast.success("Venture settings saved");
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  if (q.isPending) return <SkeletonRows />;
  if (q.isError) return <ErrorState error={q.error} />;
  const t = Number(threshold);
  const invalid = !Number.isInteger(t) || t < 5 || t > 1000;
  return (
    <Card>
      <CardHeader title="Venture" description="The kind decides which agents and screens this venture gets." />
      <div className="max-w-xl space-y-4 p-4">
        {!canAdmin ? <Notice tone="info">Only a venture admin or owner can change these settings.</Notice> : null}
        <FormError message={err} />
        <Field label="Kind">
          <Select value={kind} disabled={!canAdmin} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Autonomy threshold"
          hint="Consecutive approvals without edits an agent needs before it may be allowed to act without asking (5–1000)."
          error={invalid ? "Between 5 and 1000" : null}
        >
          <Input inputMode="numeric" value={threshold} disabled={!canAdmin} onChange={(e) => setThreshold(e.target.value)} className="w-32" />
        </Field>
        <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
          <div>
            <div className="text-sm font-medium">Send people&apos;s names to hosted speech models</div>
            <p className="mt-0.5 text-xs text-subtle">
              Names of people from this venture&apos;s knowledge help dictation and meeting transcripts spell them right. Off: only
              local speech models get them. Restricted records (e.g. loan applicants) are never used either way.
            </p>
          </div>
          <Switch label="Send people's names to hosted speech models" checked={peopleHints} disabled={!canAdmin} onChange={setPeopleHints} />
        </div>
        <Field label="Time zone">
          <Input value={q.data.timezone} disabled readOnly className="w-48" />
        </Field>
        <Button variant="primary" disabled={!canAdmin || invalid} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </Card>
  );
}
