"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { TermsGate } from "@/components/legal/terms-gate";
import { FullPageLoader } from "@/components/shell/gate";
import { Logo } from "@/components/shell/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Checkbox, Field, FormError, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState } from "@/components/ui/states";
import { ApiError, api, errorMessage, unwrap } from "@/lib/api";
import { accessKey, meKey, useAccessQuery, type VentureKind } from "@/lib/access";
import { SLUG_RE, slugify } from "@/lib/slug";


interface CreatedVenture {
  id: string;
  name: string;
  kind: VentureKind;
  template: Template;
}

/** Business templates: the kind decides which screens a business gets; the template decides
 * which agents start switched on and what standing instructions they begin with. */
export interface Template {
  id: string;
  kind: VentureKind;
  title: string;
  example: string;
  gets: string;
  /** Agents switched on at setup (others stay available on the Agents page). */
  workflows: string[];
  /** Starting instructions per agent; the owner edits them later. */
  instructions?: Record<string, string>;
}

export const TEMPLATES: Template[] = [
  {
    id: "agency",
    kind: "software",
    title: "Agency or services",
    example: "Digital agency, consultancy, IT services",
    gets: "Inbox assistant, lead triage with priced proposals, meeting digests",
    workflows: ["inbox_assistant", "lead_triage", "meeting_digest"],
  },
  {
    id: "loans",
    kind: "finance",
    title: "Loans & real estate",
    example: "Loan DSA, mortgage broker, property dealer",
    gets: "Loan document checks and client follow-ups, inbox assistant, meeting digests",
    workflows: ["inbox_assistant", "loan_verification", "meeting_digest"],
  },
  {
    id: "kitchen",
    kind: "kitchen",
    title: "Restaurant or cloud kitchen",
    example: "Cloud kitchen, restaurant, caterer",
    gets: "Nightly stock and purchase plan, inbox assistant for orders and queries",
    workflows: ["inbox_assistant", "kitchen_daily", "meeting_digest"],
    instructions: { inbox_assistant: "Customers ask about orders, menu and delivery. For order problems, ask for the order number and apologise once." },
  },
  {
    id: "retail",
    kind: "general",
    title: "Shop or e-commerce",
    example: "Retail store, D2C brand, wholesaler",
    gets: "Inbox assistant for product, order and payment queries; lead triage for bulk enquiries",
    workflows: ["inbox_assistant", "lead_triage", "meeting_digest"],
    instructions: { inbox_assistant: "Answer product, stock, delivery and return questions from what you know. For an order query, ask for the order number. Never promise a refund; say the team will confirm." },
  },
  {
    id: "clinic",
    kind: "general",
    title: "Clinic, salon or local services",
    example: "Clinic, salon, repair service, tutor",
    gets: "Inbox assistant for appointments and questions, meeting digests",
    workflows: ["inbox_assistant", "meeting_digest"],
    instructions: { inbox_assistant: "Most messages are appointment requests. Offer the next two available slots from the calendar when you know them, otherwise ask for a preferred day and time. Never give medical or legal advice." },
  },
  {
    id: "coaching",
    kind: "general",
    title: "Coaching or education",
    example: "Coaching institute, online course, training company",
    gets: "Lead triage for course enquiries with fees from your rate card, inbox assistant",
    workflows: ["inbox_assistant", "lead_triage", "meeting_digest"],
    instructions: { lead_triage: "Enquiries are usually from students or parents. Mention batch timings and the free demo class." },
  },
  {
    id: "freelancer",
    kind: "general",
    title: "Freelancer or consultant",
    example: "Designer, developer, CA, architect",
    gets: "Lead triage with proposals from your rate card, inbox assistant, meeting digests",
    workflows: ["inbox_assistant", "lead_triage", "meeting_digest"],
  },
  {
    id: "other",
    kind: "general",
    title: "Something else",
    example: "Any business with an inbox",
    gets: "Inbox assistant, memory, voice notes, approvals; switch on more agents later",
    workflows: ["inbox_assistant", "meeting_digest"],
  },
];

interface BusinessDraft {
  key: number;
  name: string;
  template: Template | null;
}

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
  const labels = ["Your business", "Roles & agents"];
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
  const [step, setStep] = useState<0 | 1>(0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedVenture[]>([]);

  // Resume: an org created earlier without businesses is reused.
  useEffect(() => {
    if (!access.data || orgId) return;
    const owned = access.data.orgs.find((o) => o.is_owner);
    if (owned && !access.data.ventures.some((v) => v.org_id === owned.id)) setOrgId(owned.id);
  }, [access.data, orgId]);

  if (access.isPending) return <FullPageLoader label="Preparing setup" />;
  if (access.isError) return <ErrorState error={access.error} onRetry={() => void access.refetch()} />;

  const alreadySetUp = !orgId && access.data.ventures.length > 0 && step === 0;

  return (
    <main id="main" className="min-h-dvh px-4 py-10">
      <TermsGate />
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
              <BusinessStep
                orgId={orgId}
                onOrg={setOrgId}
                onDone={(vs) => {
                  setCreated(vs);
                  setStep(1);
                  void qc.invalidateQueries({ queryKey: accessKey });
                }}
              />
            ) : null}
            {step === 1 && orgId ? (
              <SetupStep
                orgId={orgId}
                email={me.data?.email ?? ""}
                ventures={created}
                onDone={async (firstVentureId) => {
                  await qc.invalidateQueries({ queryKey: accessKey });
                  // First useful result in minutes: start a sample enquiry and land on the run.
                  if (firstVentureId) {
                    try {
                      const r = await unwrap(api.POST("/ventures/{venture_id}/sample-run", { params: { path: { venture_id: firstVentureId } } }));
                      window.location.assign(`/v/${firstVentureId}/runs/${r.run_id}?welcome=1`);
                      return;
                    } catch {
                      /* fall through to the dashboard */
                    }
                  }
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

function BusinessStep({
  orgId,
  onOrg,
  onDone,
}: {
  orgId: string | null;
  onOrg: (id: string) => void;
  onDone: (v: CreatedVenture[]) => void;
}) {
  const [rows, setRows] = useState<BusinessDraft[]>([{ key: 0, name: "", template: null }]);
  const [group, setGroup] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<number, string>>({});
  const update = (key: number, patch: Partial<BusinessDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const many = rows.length > 1;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const slugs = new Set<string>();
    for (const r of rows) {
      if (!r.name.trim()) errs[`${r.key}.name`] = "Enter the business name";
      else if (!SLUG_RE.test(slugify(r.name))) errs[`${r.key}.name`] = "Use letters or digits in the name";
      else if (slugs.has(slugify(r.name))) errs[`${r.key}.name`] = "Two businesses have the same name";
      slugs.add(slugify(r.name));
      if (!r.template) errs[`${r.key}.kind`] = "Choose what kind of business this is";
    }
    if (many && !group.trim()) errs.group = "Name the group that owns these businesses";
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      let org = orgId;
      if (!org) {
        const orgName = (many ? group : rows[0]!.name).trim();
        org = await createOrg(orgName);
        onOrg(org);
      }
      const ids = { ...done };
      const out: CreatedVenture[] = [];
      for (const r of rows) {
        const template = r.template as Template;
        const kind = template.kind;
        let id = ids[r.key];
        if (!id) {
          id = (
            await unwrap(
              api.POST("/orgs/{org_id}/ventures", {
                params: { path: { org_id: org } },
                body: { name: r.name.trim(), slug: slugify(r.name) },
              }),
            )
          ).id;
          ids[r.key] = id;
          setDone({ ...ids });
        }
        await unwrap(api.PUT("/ventures/{venture_id}/settings", { params: { path: { venture_id: id } }, body: { kind, business_name: r.name.trim() } }));
        out.push({ id, name: r.name.trim(), kind, template });
      }
      onDone(out);
    } catch (err) {
      setBusy(false);
      setFormError(
        err instanceof ApiError && err.status === 409
          ? "One of these names is already in use in your account. Change it slightly."
          : errorMessage(err),
      );
    }
  };

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight">Tell us about your business</h1>
      <p className="mt-1 text-sm text-muted">
        Kritvia sets up the right agents for your kind of business. Each business is kept completely separate, so you can
        add more later.
      </p>
      <form onSubmit={submit} noValidate className="mt-6 space-y-6">
        <FormError message={formError} />
        {rows.map((r, i) => (
          <fieldset key={r.key} className={cn("space-y-4", many && "rounded-lg border border-border p-4")}>
            {many ? (
              <div className="flex items-center justify-between">
                <legend className="text-sm font-semibold">Business {i + 1}</legend>
                {done[r.key] ? (
                  <Badge tone="success">Created</Badge>
                ) : i > 0 ? (
                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Remove business" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Field label="Business name" error={errors[`${r.key}.name`]} required>
              <Input
                value={r.name}
                autoFocus={i === 0}
                maxLength={120}
                disabled={Boolean(done[r.key])}
                placeholder="Sharma Digital"
                onChange={(e) => update(r.key, { name: e.target.value })}
              />
            </Field>
            <div role="radiogroup" aria-label="Kind of business" className="grid gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={r.template?.id === t.id}
                  onClick={() => update(r.key, { template: t })}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    r.template?.id === t.id ? "border-accent bg-accent/5 ring-1 ring-accent" : "border-border hover:bg-surface-2",
                  )}
                >
                  <span className="flex items-center justify-between text-sm font-medium">
                    {t.title}
                    {r.template?.id === t.id ? <Check className="h-4 w-4 text-accent" /> : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-subtle">{t.example}</span>
                  <span className="mt-2 block text-xs text-muted">{t.gets}</span>
                </button>
              ))}
            </div>
            {errors[`${r.key}.kind`] ? <p className="text-xs text-danger">{errors[`${r.key}.kind`]}</p> : null}
          </fieldset>
        ))}
        {many && !orgId ? (
          <Field label="Group name" error={errors.group} hint="The company or family group that owns these businesses." required>
            <Input value={group} maxLength={120} placeholder="Sharma Group" onChange={(e) => setGroup(e.target.value)} />
          </Field>
        ) : null}
        <div className="flex flex-wrap justify-between gap-2">
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRows((rs) => [...rs, { key: Date.now(), name: "", template: null }])}>
            I run another business
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Continue
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Creates the organisation, adding a short suffix if the name's slug is taken. */
async function createOrg(name: string): Promise<string> {
  const base = slugify(name).slice(0, 55) || "org";
  for (let i = 0; i < 4; i++) {
    const slug = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      return (await unwrap(api.POST("/orgs", { body: { name, slug } }))).id;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
  }
  throw new Error("Couldn't find a free name for your organisation. Try a slightly different name.");
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
  onDone: (firstVentureId?: string) => void | Promise<void>;
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

  const flowState = (vid: string, wf: string) =>
    flows[vid]?.[wf] ?? { on: (ventures.find((v) => v.id === vid)?.template.workflows ?? []).includes(wf), schedule: DEFAULT_SCHEDULES[wf] ?? "" };
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
              body: { enabled: st.on, schedule: st.schedule || null, settings: {}, instructions: v.template.instructions?.[w.name] ?? "" },
            }),
          );
        } catch (e) {
          errs.push(`${v.name}: ${w.title} — ${errorMessage(e)}`);
        }
      }
    }
    setProblems(errs);
    setBusy(false);
    if (!errs.length) await onDone(ventures[0]?.id);
  };

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight">Your roles and agents</h1>
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
              {v.name} <span className="font-normal text-subtle">· {v.template.title}</span>
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
            <p className="mt-4 mb-2 text-xs font-medium text-subtle">Agents to switch on</p>
            {catalogue.isPending ? <p className="text-sm text-subtle">Loading agents…</p> : null}
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
