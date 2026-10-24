"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Hand, Plane, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { TermsGate } from "@/components/legal/terms-gate";
import { FullPageLoader } from "@/components/shell/gate";
import { Logo } from "@/components/shell/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { ChoiceCards } from "@/components/ui/choice-cards";
import { Checkbox, Field, FormError, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState } from "@/components/ui/states";
import { TimeField } from "@/components/ui/time-field";
import { ApiError, api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { accessKey, meKey, useAccessQuery, type VentureKind } from "@/lib/access";
import { autopilotProblem, choiceProblem, type AutopilotChoice } from "@/lib/autopilot";
import { agentAllowed } from "@/lib/pricing";
import {
  byCreation,
  createdOrder,
  DEFAULT_ROLES,
  offeredAgents,
  rememberCreated,
  rolesFor,
  templateFor,
  TEMPLATES,
  type Template,
} from "@/lib/onboarding";
import { takeCoupon } from "@/lib/coupon";
import { takeReferral } from "@/lib/referral";
import { SLUG_RE, slugify } from "@/lib/slug";


interface CreatedVenture {
  id: string;
  name: string;
  kind: VentureKind;
  template: Template;
}

interface BusinessDraft {
  key: number;
  name: string;
  template: Template | null;
}

const DEFAULT_SCHEDULES: Record<string, string> = { kitchen_daily: "23:30", trade_watch: "09:00" };

function Steps({ step }: { step: number }) {
  const labels = ["Your business", "Roles & agents"];
  return (
    <div className="mb-6">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs" aria-label="Setup progress">
      {labels.map((l, i) => (
        <li key={l} className="flex items-center gap-2" aria-current={i === step ? "step" : undefined}>
          <span
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-300",
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
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${((step + 1) / labels.length) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Businesses whose setup never finished. "Finish setup" saves a config for every agent a business can use,
 * so a business with no agent configs at all was created and then left (a reload, a closed tab, another
 * device) before step 2 ran. Those resume at step 2 instead of being called "already set up".
 */
async function unfinishedVentures(ventures: { venture_id: string; venture_name: string; kind?: string | null }[]): Promise<CreatedVenture[]> {
  const out: CreatedVenture[] = [];
  // Oldest first, so a reload keeps the order and the sample run lands in the first business (A22).
  for (const v of byCreation(ventures, createdOrder()).slice(0, 10)) {
    const configs = await unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: v.venture_id } } }));
    if (configs.length) continue;
    const settings = await unwrap(api.GET("/ventures/{venture_id}/settings", { params: { path: { venture_id: v.venture_id } } })).catch(() => null);
    const template = templateFor(settings?.industry, settings?.kind ?? v.kind);
    out.push({ id: v.venture_id, name: v.venture_name, kind: template.kind, template });
  }
  return out;
}

export default function OnboardingPage() {
  const access = useAccessQuery();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: meKey, queryFn: () => unwrap(api.GET("/auth/me")) });
  const [step, setStep] = useState<0 | 1>(0);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedVenture[]>([]);

  const owned = access.data?.orgs.find((o) => o.is_owner);
  const ownedVentures = owned ? (access.data?.ventures ?? []).filter((v) => v.org_id === owned.id && v.is_owner) : [];
  // Only checked on arrival (step 0, nothing chosen yet), for the organisation this person owns.
  const unfinished = useQuery({
    queryKey: ["onboarding", "unfinished", owned?.id, ownedVentures.map((v) => v.venture_id).join(",")],
    queryFn: () => unfinishedVentures(ownedVentures),
    enabled: Boolean(owned) && ownedVentures.length > 0 && step === 0 && !orgId,
    staleTime: Infinity,
    retry: 1,
  });

  // Resume: an org created earlier without businesses is reused; businesses left before step 2 go to step 2.
  useEffect(() => {
    if (!access.data || orgId || !owned) return;
    if (!ownedVentures.length) {
      setOrgId(owned.id);
      return;
    }
    if (unfinished.data?.length) {
      setOrgId(owned.id);
      setCreated(unfinished.data);
      setStep(1);
    }
  }, [access.data, orgId, owned, ownedVentures.length, unfinished.data]);

  if (access.isPending) return <FullPageLoader label="Preparing setup" />;
  if (access.isError) return <ErrorState error={access.error} onRetry={() => void access.refetch()} />;
  if (!orgId && step === 0 && unfinished.fetchStatus === "fetching") return <FullPageLoader label="Preparing setup" />;

  // A failed check falls back to the old answer: the businesses exist, so send them to the dashboard.
  const alreadySetUp = !orgId && access.data.ventures.length > 0 && step === 0 && !unfinished.data?.length;

  return (
    <main id="main" className="relative isolate min-h-dvh px-4 py-10">
      <div className="kv-grid-bg pointer-events-none absolute inset-x-0 top-0 -z-10 h-96" aria-hidden />
      <TermsGate />
      <div className="mx-auto w-full max-w-2xl animate-fade-up">
        <Logo className="mb-8" />
        {alreadySetUp ? (
          <Card className="p-6">
            <h1 className="text-lg font-semibold">You&apos;re already set up</h1>
            <p className="mt-1 text-sm text-muted">Your organisation and businesses exist. Add, rename or remove businesses under Businesses in the menu.</p>
            <Button variant="primary" className="mt-4" onClick={() => window.location.assign("/")}>
              Go to dashboard
            </Button>
          </Card>
        ) : (
          <>
            <Steps step={step} />
            <div key={step} className="animate-fade-up">
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
                emailState={{ pending: me.isPending, error: me.isError ? me.error : null, retry: () => void me.refetch() }}
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
            </div>
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
        // Came through a partner's link: link the organisation to them (best effort; Plan & billing can add it later).
        const ref = takeReferral();
        if (ref) await api.POST("/orgs/{org_id}/partner-code", { params: { path: { org_id: org } }, body: { code: ref } }).catch(() => undefined);
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
        await unwrap(
          api.PUT("/ventures/{venture_id}/settings", {
            params: { path: { venture_id: id } },
            body: { kind, industry: template.id as Schemas["VentureSettingsIn"]["industry"], business_name: r.name.trim() },
          }),
        );
        out.push({ id, name: r.name.trim(), kind, template });
      }
      // Came with a coupon (e.g. /register?coupon=FIRST50): apply it once the businesses exist, so a coupon for
      // one industry can check it (best effort; Plan & billing can add it later).
      rememberCreated([...createdOrder().filter((x) => !out.some((o) => o.id === x)), ...out.map((o) => o.id)]);
      const coupon = takeCoupon();
      if (coupon) await api.POST("/orgs/{org_id}/coupon", { params: { path: { org_id: org } }, body: { code: coupon } }).catch(() => undefined);
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
            <ChoiceCards
              label={many ? `Kind of business ${i + 1}` : "Kind of business"}
              options={TEMPLATES}
              value={r.template?.id}
              onChange={(t) => update(r.key, { template: t })}
              className="grid gap-2 sm:grid-cols-2"
              cardClassName={(checked) =>
                cn(
                  "rounded-lg border p-3 text-left transition-[border-color,background-color,box-shadow] duration-150",
                  checked ? "border-accent bg-accent/5 ring-1 ring-accent" : "border-border hover:border-border-strong hover:bg-surface-2 hover:shadow-card",
                )
              }
              render={(t, checked) => (
                <>
                  <span className="flex items-center justify-between text-sm font-medium">
                    {t.title}
                    {checked ? <Check className="h-4 w-4 text-accent" aria-hidden /> : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-subtle">{t.example}</span>
                  <span className="mt-2 block text-xs text-muted">{t.gets}</span>
                </>
              )}
            />
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
  emailState,
  ventures,
  onDone,
}: {
  orgId: string;
  email: string;
  /** Your sign-in email (from /auth/me) adds you to each business's roles; finishing waits for it. */
  emailState: { pending: boolean; error: unknown; retry: () => void };
  ventures: CreatedVenture[];
  onDone: (firstVentureId?: string) => void | Promise<void>;
}) {
  const catalogue = useQuery({ queryKey: ["workflows"], queryFn: () => unwrap(api.GET("/workflows")) });
  const planQ = useQuery({
    queryKey: ["plan", orgId],
    queryFn: async () => (await unwrap(api.GET("/orgs/{org_id}/plan", { params: { path: { org_id: orgId } } }))) as unknown as { plan: { code?: string; name: string; agents: string } },
  });
  const allowed = (wf: string, kind: string) => agentAllowed(planQ.data?.plan.agents, wf, kind);
  const [roles, setRoles] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(ventures.map((v) => [v.id, DEFAULT_ROLES[v.kind]])),
  );
  const [flows, setFlows] = useState<Record<string, Record<string, { on: boolean; schedule: string }>>>({});
  const [autopilot, setAutopilot] = useState<AutopilotChoice>(null);
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  // Each business is offered the agents that fit its template: a salon never sees kitchen, loan or shipment agents (A3).
  const offered = useMemo(() => {
    const out: Record<string, { main: Workflow[]; more: Workflow[] }> = {};
    for (const v of ventures) out[v.id] = offeredAgents(v.template, catalogue.data ?? []);
    return out;
  }, [catalogue.data, ventures]);

  const flowState = (vid: string, wf: string) => {
    const v = ventures.find((x) => x.id === vid);
    const fallback = { on: (v?.template.workflows ?? []).includes(wf) && allowed(wf, v?.kind ?? "general"), schedule: DEFAULT_SCHEDULES[wf] ?? "" };
    const st = flows[vid]?.[wf] ?? fallback;
    return allowed(wf, v?.kind ?? "general") ? st : { ...st, on: false };
  };
  const setFlow = (vid: string, wf: string, patch: Partial<{ on: boolean; schedule: string }>) =>
    setFlows((f) => ({ ...f, [vid]: { ...(f[vid] ?? {}), [wf]: { ...flowState(vid, wf), ...patch } } }));

  const finish = async () => {
    const pick = choiceProblem(autopilot);
    setChoiceError(pick);
    if (pick) {
      document.getElementById("autopilot-choice")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
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
      const o = offered[v.id];
      for (const w of [...(o?.main ?? []), ...(o?.more ?? [])]) {
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
      try {
        await unwrap(api.PUT("/ventures/{venture_id}/autopilot", { params: { path: { venture_id: v.id } }, body: { on: autopilot === "auto" } }));
      } catch (e) {
        errs.push(`${v.name}: autopilot — ${autopilotProblem(e)}`);
      }
    }
    setProblems(errs);
    setBusy(false);
    // The sample run starts in the first business made in this setup (A22).
    if (!errs.length) await onDone(ventures[0]?.id);
  };

  const agentRow = (v: CreatedVenture, w: Workflow) => {
    const st = flowState(v.id, w.name);
    const ok = allowed(w.name, v.kind);
    return (
      <div key={w.name} className="flex flex-wrap items-start justify-between gap-3">
        <Checkbox
          label={w.title}
          hint={ok ? w.description : `Not on the ${planQ.data?.plan.name ?? "current"} plan — included from ${v.kind === "finance" || v.kind === "kitchen" || v.kind === "trade" ? "Starter" : "Growth"}. Upgrade any time in Plan & billing.`}
          checked={st.on}
          disabled={!ok}
          onChange={(e) => setFlow(v.id, w.name, { on: e.target.checked })}
          className="min-w-0 flex-1"
        />
        {w.name in DEFAULT_SCHEDULES ? (
          <Field label="Daily at (IST)" className="w-44">
            <TimeField value={st.schedule} onChange={(t) => setFlow(v.id, w.name, { schedule: t })} />
          </Field>
        ) : null}
      </div>
    );
  };

  const trial = planQ.data?.plan.code === "free" || planQ.data?.plan.agents === "core";

  return (
    <Card className="p-6">
      <h1 className="text-lg font-semibold tracking-tight">Your roles and agents</h1>
      <p className="mt-1 text-sm text-muted">
        As owner you can see everything. Kritvia has switched on the agents that fit your kind of business; change them now or later on the Agents page.
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
              {rolesFor(v.kind).map((r) => (
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
            <div className="space-y-2">{(offered[v.id]?.main ?? []).map((w) => agentRow(v, w))}</div>
            {offered[v.id]?.more.length ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-accent">More agents you can switch on</summary>
                <div className="mt-2 space-y-2">{offered[v.id]!.more.map((w) => agentRow(v, w))}</div>
              </details>
            ) : null}
          </fieldset>
        ))}
        <fieldset id="autopilot-choice" className="space-y-2">
          <legend className="text-sm font-semibold">How should your agents work?</legend>
          <p className="text-xs text-subtle">Pick one. You can change it any time in Settings, or reply PAUSE from your linked Telegram or WhatsApp.</p>
          <ChoiceCards
            label="How should your agents work?"
            options={AUTOPILOT_OPTIONS}
            value={autopilot}
            onChange={(o) => {
              setAutopilot(o.id);
              setChoiceError(null);
            }}
            className="grid gap-2 sm:grid-cols-2"
            cardClassName={(checked) =>
              cn(
                "rounded-lg border p-3 text-left transition-[border-color,background-color,box-shadow] duration-150",
                checked ? "border-accent bg-accent/5 ring-1 ring-accent" : "border-border hover:border-border-strong hover:bg-surface-2 hover:shadow-card",
              )
            }
            render={(o, checked) => (
              <>
                <span className="flex items-center justify-between gap-2 text-sm font-medium">
                  <span className="flex items-center gap-2">
                    {o.id === "auto" ? <Plane className="h-4 w-4 text-accent" aria-hidden /> : <Hand className="h-4 w-4 text-subtle" aria-hidden />}
                    {o.title}
                  </span>
                  {checked ? <Check className="h-4 w-4 text-accent" aria-hidden /> : null}
                </span>
                {o.badge ? <Badge tone="accent" className="mt-1">{o.badge}</Badge> : null}
                <span className="mt-2 block text-xs text-muted">{o.text}</span>
              </>
            )}
          />
          {autopilot === "auto" && trial ? (
            <p className="text-xs text-subtle">On the free trial only inbox replies go out by themselves. Reminders, reviews and follow-ups join on Starter and up.</p>
          ) : null}
          {choiceError ? <p className="text-xs text-danger" role="alert">{choiceError}</p> : null}
        </fieldset>
        {!email && emailState.error ? (
          <Notice tone="danger" title="We couldn't load your account">
            <p>{errorMessage(emailState.error)} Your choices above are kept.</p>
            <Button size="sm" className="mt-2" onClick={emailState.retry}>
              Try again
            </Button>
          </Notice>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {!email && emailState.pending ? (
            <span role="status" className="text-xs text-subtle">
              Loading your account…
            </span>
          ) : null}
          <Button variant="primary" loading={busy || (!email && emailState.pending)} onClick={finish} disabled={!email}>
            Finish setup
          </Button>
        </div>
      </div>
    </Card>
  );
}

type Workflow = Schemas["WorkflowOut"];

const AUTOPILOT_OPTIONS: { id: "auto" | "approve"; title: string; badge?: string; text: string }[] = [
  {
    id: "auto",
    title: "Autopilot",
    badge: "Recommended",
    text: "Agents reply, remind and follow up by themselves. Money, complaints and orders still come to you.",
  },
  {
    id: "approve",
    title: "I'll approve everything",
    text: "Every reply and reminder waits for your yes before it goes out.",
  },
];
