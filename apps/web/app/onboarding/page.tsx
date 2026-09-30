"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { FullPageLoader } from "@/components/shell/gate";
import { Logo } from "@/components/shell/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState } from "@/components/ui/states";
import { ApiError, api, errorMessage, unwrap } from "@/lib/api";
import { accessKey, meKey, useAccessQuery, type VentureKind } from "@/lib/access";
import { KIND_LABEL } from "@/lib/nav";
import { SLUG_RE, slugify } from "@/lib/slug";


interface VentureDraft {
  key: number;
  include: boolean;
  name: string;
  slug: string;
  kind: VentureKind;
  slugTouched?: boolean;
}

interface CreatedVenture {
  id: string;
  name: string;
  kind: VentureKind;
}

const PRESETS: Omit<VentureDraft, "key">[] = [
  { include: true, name: "Sitelytc", slug: "sitelytc", kind: "software" },
  { include: true, name: "Truhome Finance", slug: "truhome-finance", kind: "finance" },
  { include: true, name: "Cloud Kitchen", slug: "cloud-kitchen", kind: "kitchen" },
];

const ROLE_OPTIONS: { role: string; label: string; hint: string }[] = [
  { role: "approver", label: "Approver", hint: "Approve agent drafts (emails, invites)" },
  { role: "loan_officer", label: "Loan officer", hint: "See loan files; approve client follow-ups" },
  { role: "kitchen_manager", label: "Kitchen manager", hint: "Approve purchase orders" },
  { role: "operator", label: "Operator", hint: "Run workflows and edit data" },
];

const DEFAULT_ROLES: Record<VentureKind, string[]> = {
  software: ["approver"],
  finance: ["loan_officer"],
  kitchen: ["kitchen_manager"],
  general: ["approver"],
};

const DEFAULT_SCHEDULES: Record<string, string> = { kitchen_daily: "23:30" };

function Steps({ step }: { step: number }) {
  const labels = ["Organisation", "Ventures", "Roles & workflows"];
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs" aria-label="Setup progress">
      {labels.map((l, i) => (
        <li key={l} className="flex items-center gap-2" aria-current={i === step ? "step" : undefined}>
          <span
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
              i < step ? "bg-success text-white" : i === step ? "bg-accent text-accent-fg" : "bg-surface-3 text-subtle",
            )}
          >
            {i < step ? <Check className="h-3 w-3" /> : i + 1}
          </span>
          <span className={cn(i === step ? "font-medium text-fg" : "text-subtle")}>{l}</span>
          {i < labels.length - 1 ? <span className="mx-1 hidden h-px w-6 bg-border sm:inline-block" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}

export default function OnboardingPage() {
  const access = useAccessQuery();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: meKey, queryFn: () => unwrap(api.GET("/auth/me")) });
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedVenture[]>([]);

  // Resume: an org without ventures continues at step 2.
  useEffect(() => {
    if (!access.data || orgId) return;
    const owned = access.data.orgs.find((o) => o.is_owner);
    if (owned && !access.data.ventures.some((v) => v.org_id === owned.id)) {
      setOrgId(owned.id);
      setStep(1);
    }
  }, [access.data, orgId]);

  if (access.isPending) return <FullPageLoader label="Preparing setup" />;
  if (access.isError) return <ErrorState error={access.error} onRetry={() => void access.refetch()} />;

  const alreadySetUp = !orgId && access.data.ventures.length > 0 && step === 0;

  return (
    <main id="main" className="min-h-dvh px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <Logo className="mb-8" />
        {alreadySetUp ? (
          <Card className="p-6">
            <h1 className="text-lg font-semibold">You&apos;re already set up</h1>
            <p className="mt-1 text-sm text-muted">Your organisation and ventures exist. Add more ventures from the dashboard later.</p>
            <Button variant="primary" className="mt-4" onClick={() => window.location.assign("/")}>
              Go to dashboard
            </Button>
          </Card>
        ) : (
          <>
            <Steps step={step} />
            {step === 0 ? (
              <OrgStep
                onDone={(id) => {
                  setOrgId(id);
                  setStep(1);
                }}
              />
            ) : null}
            {step === 1 && orgId ? (
              <VenturesStep
                orgId={orgId}
                onDone={(vs) => {
                  setCreated(vs);
                  setStep(2);
                  void qc.invalidateQueries({ queryKey: accessKey });
                }}
              />
            ) : null}
            {step === 2 && orgId ? (
              <SetupStep
                orgId={orgId}
                email={me.data?.email ?? ""}
                ventures={created}
                onDone={async () => {
                  await qc.invalidateQueries({ queryKey: accessKey });
                  window.location.assign("/");
                }}
              />
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

function OrgStep({ onDone }: { onDone: (id: string) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Enter your organisation's name";
    if (!SLUG_RE.test(slug)) errs.slug = "2–63 characters: lowercase letters, digits and hyphens";
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const out = await unwrap(api.POST("/orgs", { body: { name: name.trim(), slug } }));
      onDone(out.id);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409) setErrors({ slug: "This slug is taken — choose another" });
      else if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(errorMessage(err));
    }
  };

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight">Create your organisation</h1>
      <p className="mt-1 text-sm text-muted">
        The organisation holds your ventures. Each venture is a hard data boundary — people only see the ventures they are
        granted.
      </p>
      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        <FormError message={formError} />
        <Field label="Organisation name" error={errors.name} required>
          <Input
            value={name}
            autoFocus
            maxLength={120}
            placeholder="Thakur Group"
            onChange={(e) => {
              setName(e.target.value);
              if (!touched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label="Slug" error={errors.slug} hint="Used in URLs and exports." required>
          <Input
            value={slug}
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy}>
            Continue
          </Button>
        </div>
      </form>
    </Card>
  );
}

function VenturesStep({ orgId, onDone }: { orgId: string; onDone: (v: CreatedVenture[]) => void }) {
  const [rows, setRows] = useState<VentureDraft[]>(() => PRESETS.map((p, i) => ({ ...p, key: i })));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<number, string>>({});

  const update = (key: number, patch: Partial<VentureDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const chosen = rows.filter((r) => r.include);
    const errs: Record<string, string> = {};
    if (!chosen.length) setFormError("Choose at least one venture");
    const slugs = new Set<string>();
    for (const r of chosen) {
      if (!r.name.trim()) errs[`${r.key}.name`] = "Required";
      if (!SLUG_RE.test(r.slug)) errs[`${r.key}.slug`] = "Lowercase letters, digits, hyphens";
      else if (slugs.has(r.slug)) errs[`${r.key}.slug`] = "Duplicate slug";
      slugs.add(r.slug);
    }
    setErrors(errs);
    if (Object.keys(errs).length || !chosen.length) return;
    setFormError(null);
    setBusy(true);
    const out: CreatedVenture[] = [];
    const ids = { ...done };
    try {
      for (const r of chosen) {
        let id = ids[r.key];
        if (!id) {
          id = (await unwrap(api.POST("/orgs/{org_id}/ventures", { params: { path: { org_id: orgId } }, body: { name: r.name.trim(), slug: r.slug } }))).id;
          ids[r.key] = id;
          setDone({ ...ids });
        }
        await unwrap(api.PUT("/ventures/{venture_id}/settings", { params: { path: { venture_id: id } }, body: { kind: r.kind } }));
        out.push({ id, name: r.name.trim(), kind: r.kind });
      }
      onDone(out);
    } catch (err) {
      setBusy(false);
      setFormError(err instanceof ApiError && err.status === 409 ? "A venture with one of these slugs already exists." : errorMessage(err));
    }
  };

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight">Add your ventures</h1>
      <p className="mt-1 text-sm text-muted">
        The kind decides which agents and screens a venture gets. You can rename or add ventures later.
      </p>
      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        <FormError message={formError} />
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.key} className={cn("rounded-lg border p-3", r.include ? "border-border" : "border-dashed border-border opacity-70")}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <Checkbox
                  label={r.name || "New venture"}
                  checked={r.include}
                  onChange={(e) => update(r.key, { include: e.target.checked })}
                  disabled={Boolean(done[r.key])}
                />
                <div className="flex items-center gap-2">
                  {done[r.key] ? <Badge tone="success">Created</Badge> : null}
                  {r.key >= PRESETS.length && !done[r.key] ? (
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Remove venture" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
              {r.include ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Name" error={errors[`${r.key}.name`]}>
                    <Input
                      value={r.name}
                      disabled={Boolean(done[r.key])}
                      onChange={(e) => update(r.key, { name: e.target.value, ...(r.slugTouched ? {} : { slug: slugify(e.target.value) }) })}
                    />
                  </Field>
                  <Field label="Slug" error={errors[`${r.key}.slug`]}>
                    <Input value={r.slug} disabled={Boolean(done[r.key])} onChange={(e) => update(r.key, { slug: e.target.value.toLowerCase(), slugTouched: true })} />
                  </Field>
                  <Field label="Kind">
                    <Select value={r.kind} onChange={(e) => update(r.key, { kind: e.target.value as VentureKind })}>
                      {(Object.keys(KIND_LABEL) as VentureKind[]).map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setRows((rs) => [...rs, { key: Date.now(), include: true, name: "", slug: "", kind: "general" }])}
          >
            Add another
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Create ventures
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SetupStep({
  orgId,
  email,
  ventures,
  onDone,
}: {
  orgId: string;
  email: string;
  ventures: CreatedVenture[];
  onDone: () => void | Promise<void>;
}) {
  const catalogue = useQuery({ queryKey: ["workflows"], queryFn: () => unwrap(api.GET("/workflows")) });
  const [roles, setRoles] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(ventures.map((v) => [v.id, DEFAULT_ROLES[v.kind]])),
  );
  const [flows, setFlows] = useState<Record<string, Record<string, { on: boolean; schedule: string }>>>({});
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const available = useMemo(() => {
    const out: Record<string, { name: string; title: string; description: string }[]> = {};
    for (const v of ventures) {
      out[v.id] = (catalogue.data ?? []).filter((w) => w.venture_kinds.includes(v.kind));
    }
    return out;
  }, [catalogue.data, ventures]);

  const flowState = (vid: string, wf: string) => flows[vid]?.[wf] ?? { on: true, schedule: DEFAULT_SCHEDULES[wf] ?? "" };
  const setFlow = (vid: string, wf: string, patch: Partial<{ on: boolean; schedule: string }>) =>
    setFlows((f) => ({ ...f, [vid]: { ...(f[vid] ?? {}), [wf]: { ...flowState(vid, wf), ...patch } } }));

  const finish = async () => {
    setBusy(true);
    const errs: string[] = [];
    for (const v of ventures) {
      for (const role of roles[v.id] ?? []) {
        try {
          await unwrap(api.POST("/orgs/{org_id}/members", { params: { path: { org_id: orgId } }, body: { user_email: email, role, venture_id: v.id } }));
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) errs.push(`${v.name}: role ${role} — ${errorMessage(e)}`);
        }
      }
      for (const w of available[v.id] ?? []) {
        const st = flowState(v.id, w.name);
        if (st.schedule && !/^([01]\d|2[0-3]):[0-5]\d$/.test(st.schedule)) {
          errs.push(`${v.name}: ${w.title} schedule must be HH:MM`);
          continue;
        }
        try {
          await unwrap(
            api.PUT("/ventures/{venture_id}/workflow-configs/{workflow}", {
              params: { path: { venture_id: v.id, workflow: w.name } },
              body: { enabled: st.on, schedule: st.schedule || null, settings: {} },
            }),
          );
        } catch (e) {
          errs.push(`${v.name}: ${w.title} — ${errorMessage(e)}`);
        }
      }
    }
    setProblems(errs);
    setBusy(false);
    if (!errs.length) await onDone();
  };

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight">Your roles and workflows</h1>
      <p className="mt-1 text-sm text-muted">
        As owner you can see everything, but some approvals need a specific role — for example loan follow-ups are
        sensitive and only a loan officer may approve them.
      </p>
      <div className="mt-6 space-y-4">
        {problems.length ? (
          <Notice tone="danger" title="Some steps failed">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {ventures.map((v) => (
          <fieldset key={v.id} className="rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-semibold">
              {v.name} <span className="font-normal text-subtle">· {KIND_LABEL[v.kind]}</span>
            </legend>
            <p className="mb-2 text-xs font-medium text-subtle">Add me as</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLE_OPTIONS.map((r) => (
                <Checkbox
                  key={r.role}
                  label={r.label}
                  hint={r.hint}
                  checked={(roles[v.id] ?? []).includes(r.role)}
                  onChange={(e) =>
                    setRoles((rs) => ({
                      ...rs,
                      [v.id]: e.target.checked ? [...(rs[v.id] ?? []), r.role] : (rs[v.id] ?? []).filter((x) => x !== r.role),
                    }))
                  }
                />
              ))}
            </div>
            <p className="mt-4 mb-2 text-xs font-medium text-subtle">Enable workflows</p>
            {catalogue.isPending ? <p className="text-sm text-subtle">Loading workflows…</p> : null}
            <div className="space-y-2">
              {(available[v.id] ?? []).map((w) => {
                const st = flowState(v.id, w.name);
                return (
                  <div key={w.name} className="flex flex-wrap items-start justify-between gap-3">
                    <Checkbox label={w.title} hint={w.description} checked={st.on} onChange={(e) => setFlow(v.id, w.name, { on: e.target.checked })} className="min-w-0 flex-1" />
                    {w.name in DEFAULT_SCHEDULES ? (
                      <Field label="Daily at (IST)" className="w-32">
                        <Input type="time" value={st.schedule} onChange={(e) => setFlow(v.id, w.name, { schedule: e.target.value })} />
                      </Field>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} onClick={finish} disabled={!email}>
            Finish setup
          </Button>
        </div>
      </div>
    </Card>
  );
}
