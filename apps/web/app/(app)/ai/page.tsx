"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, ExternalLink, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Switch } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { formatRelative } from "@/lib/format";

type Setup = Schemas["AiSetupOut"];
type Provider = Schemas["ProviderOut"];
type Key = Schemas["KeyOut"];
type ProviderKey = "openai" | "anthropic" | "gemini" | "groq" | "openrouter" | "mistral" | "cerebras";

/** Free models by default; the owner may add their own paid keys, which agents then use first. */
export default function AiModelsPage() {
  const { org } = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["ai-setup", org?.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/ai", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org),
  });
  const [confirmTraining, setConfirmTraining] = useState(false);
  const training = useMutation({
    mutationFn: (allow: boolean) =>
      unwrap(api.PUT("/orgs/{org_id}/ai/settings", { params: { path: { org_id: org!.id } }, body: { allow_training_models: allow } })),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setConfirmTraining(false);
      toast.success(d.allow_training_models ? "More free models switched on" : "Back to models that do not train");
    },
    onError: (e) => toast.error("Could not save", errorMessage(e)),
  });

  if (!org || q.isPending) return <SkeletonRows rows={8} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const saved = new Map(s.keys.map((k) => [k.provider, k]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI models"
        description="Kritvia runs on free models out of the box. Add your own API key to use a paid model you prefer: agents try it first, and its usage is billed to you by the provider, not counted in your plan."
      />
      {!s.can_edit ? <Notice tone="info">Only an owner of this organisation can change AI models.</Notice> : null}

      <Card>
        <CardHeader title="Free models included" description="Tried in this order when you have no key of your own. Sensitive records never leave Kritvia's own server." />
        <ul className="divide-y divide-border">
          {s.free_models.map((m) => (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{m.label}</p>
                <p className="text-xs text-subtle">
                  {m.may_train ? "Free tier: the provider may learn from what it receives. Off unless you switch it on below." : "Does not train on your data."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {m.may_train ? (
                  <Badge tone={s.allow_training_models ? "warning" : "neutral"}>{s.allow_training_models ? "On" : "Off"}</Badge>
                ) : (
                  <Badge tone="success">
                    <ShieldCheck className="mr-1 h-3 w-3" aria-hidden /> No training
                  </Badge>
                )}
                {!m.available ? <Badge tone="neutral">Not set up on this server</Badge> : null}
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-start justify-between gap-4 border-t border-border px-4 py-3">
          <div>
            <p className="text-sm font-medium">Also use free models that may learn from your content</p>
            <p className="mt-0.5 max-w-xl text-xs text-subtle">
              More free capacity (Gemini free tier, OpenRouter free models, Mistral free tier). Never used for sensitive records, and
              never for a business with Google connected, because Google&apos;s rules forbid it.
              {s.ventures_with_google > 0 ? ` ${s.ventures_with_google} of your businesses ${s.ventures_with_google === 1 ? "has" : "have"} Google connected, so ${s.ventures_with_google === 1 ? "it stays" : "they stay"} on models that do not train.` : ""}
            </p>
          </div>
          <Switch
            label="Also use free models that may learn from your content"
            checked={s.allow_training_models}
            disabled={!s.can_edit || training.isPending}
            onChange={(v) => (v ? setConfirmTraining(true) : training.mutate(false))}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Your own API keys"
          description="Paste a key from the provider's site and name the model. We test it with one short request before saving, store it encrypted, and never show it again."
        />
        <div className="grid gap-3 p-4 md:grid-cols-2">
          {s.providers.map((p) => (
            <ProviderCard key={p.key} orgId={org.id} provider={p} saved={saved.get(p.key)} canEdit={s.can_edit} onSaved={(d) => qc.setQueryData(key, d)} />
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmTraining}
        onClose={() => setConfirmTraining(false)}
        onConfirm={() => training.mutate(true)}
        title="Use free models that may learn from your content?"
        description="Google, OpenRouter's free providers and Mistral may use what they receive to improve their models. Your customers' privacy notices will say so."
        confirmLabel="Switch on"
        danger={false}
        loading={training.isPending}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Only for ordinary messages and drafts. Identity, bank and loan records always stay on Kritvia&apos;s own server.</li>
          <li>Never for a business that has Google connected.</li>
          <li>You can switch it off at any time.</li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}

function ProviderCard({
  orgId,
  provider: p,
  saved,
  canEdit,
  onSaved,
}: {
  orgId: string;
  provider: Provider;
  saved?: Key;
  canEdit: boolean;
  onSaved: (d: Setup) => void;
}) {
  const toast = useToast();
  const [model, setModel] = useState(saved?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const path = { params: { path: { org_id: orgId, provider: p.key as ProviderKey } } };
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT("/orgs/{org_id}/ai/keys/{provider}", { ...path, body: { model: model.trim(), api_key: apiKey.trim() || null } })),
    onSuccess: (d) => {
      setErr(null);
      setApiKey("");
      onSaved(d);
      toast.success(`${p.label} key saved`, "Agents now try it first.");
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/orgs/{org_id}/ai/keys/{provider}", path)),
    onSuccess: (d) => {
      setModel("");
      onSaved(d);
      toast.success(`${p.label} key removed`);
    },
    onError: (e) => toast.error("Could not remove", errorMessage(e)),
  });
  const needsKey = !saved && apiKey.trim().length < 8;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <KeyRound className="h-3.5 w-3.5 text-subtle" aria-hidden /> {p.label}
        </p>
        {saved ? (
          saved.last_error ? (
            <Badge tone="danger">
              <CircleAlert className="mr-1 h-3 w-3" aria-hidden /> {saved.last_error}
            </Badge>
          ) : (
            <Badge tone="success">
              <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden /> Key {saved.hint}
              {saved.last_ok_at ? ` · checked ${formatRelative(saved.last_ok_at)}` : ""}
            </Badge>
          )
        ) : null}
      </div>
      <FormError message={err} />
      <div className="space-y-2">
        <Field label="Model">
          <Input value={model} disabled={!canEdit} placeholder={`e.g. ${p.example_model}`} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <Field label={saved ? "Replace key (optional)" : "API key"}>
          <Input type="password" autoComplete="off" value={apiKey} disabled={!canEdit} placeholder={saved ? "Leave empty to keep the saved key" : "Paste the key"} onChange={(e) => setApiKey(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={!canEdit || !model.trim() || needsKey} loading={save.isPending} onClick={() => save.mutate()}>
          {saved ? "Save" : "Test and save"}
        </Button>
        {saved ? (
          <Button size="sm" variant="ghost" disabled={!canEdit} loading={remove.isPending} onClick={() => remove.mutate()} icon={<Trash2 className="h-3.5 w-3.5" />}>
            Remove
          </Button>
        ) : null}
        <a href={p.keys_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline">
          Get a key <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}
