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
  const [profile, setProfile] = useState({ business_name: "", city: "", about: "", sign_off: "" });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) {
      setKind((KINDS as readonly string[]).includes(q.data.kind) ? (q.data.kind as Kind) : "general");
      setThreshold(String(q.data.trust_threshold));
      setPeopleHints(Boolean(q.data.speech_people_hints));
      setProfile({
        business_name: q.data.business_name ?? "",
        city: q.data.city ?? "",
        about: q.data.about ?? "",
        sign_off: q.data.sign_off ?? "",
      });
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT("/ventures/{venture_id}/settings", { params: { path: { venture_id: ventureId } }, body: { kind, trust_threshold: Number(threshold), speech_people_hints: peopleHints, ...profile } })),
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
            <div className="text-sm font-medium">Share vocabulary and names with hosted speech models</div>
            <p className="mt-0.5 text-xs text-subtle">
              Spelling hints (your vocabulary and names from this venture&apos;s knowledge) make dictation and meeting
              transcripts more accurate. Off: only speech models on your own server get them, and hosted models still benefit
              from the correction applied afterwards. Restricted records (e.g. loan applicants) and names found only in
              sensitive files are never sent.
            </p>
          </div>
          <Switch label="Share vocabulary and names with hosted speech models" checked={peopleHints} disabled={!canAdmin} onChange={setPeopleHints} />
        </div>
        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">Business profile</legend>
          <p className="text-xs text-subtle">
            Who the agents write as in proposals, emails and invites. Leave a field empty to use the default.
          </p>
          <Field label="Business name" hint="As your customers know it. Default: this venture's name.">
            <Input value={profile.business_name} maxLength={120} disabled={!canAdmin} onChange={(e) => setProfile((p) => ({ ...p, business_name: e.target.value }))} />
          </Field>
          <Field label="City" hint="Used for local context, e.g. festival demand for a kitchen. Default: India.">
            <Input value={profile.city} maxLength={80} disabled={!canAdmin} onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value }))} className="w-64" />
          </Field>
          <Field label="What you do" hint="One or two sentences the agents can rely on.">
            <Input value={profile.about} maxLength={600} disabled={!canAdmin} placeholder="Websites and automation for clinics and schools" onChange={(e) => setProfile((p) => ({ ...p, about: e.target.value }))} />
          </Field>
          <Field label="Email sign-off" hint="Default: Team <business name>.">
            <Input value={profile.sign_off} maxLength={120} disabled={!canAdmin} onChange={(e) => setProfile((p) => ({ ...p, sign_off: e.target.value }))} />
          </Field>
        </fieldset>
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
