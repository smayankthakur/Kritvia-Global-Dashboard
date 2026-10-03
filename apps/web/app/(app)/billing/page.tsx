"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { formatDate, formatDateTime, formatINR } from "@/lib/format";

interface PlanInfo {
  code: string;
  name: string;
  price_inr: number;
  monthly_tokens: number | null;
  max_ventures: number | null;
  max_members: number | null;
  autonomy: boolean;
}
interface PlanOut {
  plan: PlanInfo;
  tokens: number;
  tokens_left: number | null;
  ventures: number;
  members: number;
  renews_at: string | null;
  available: PlanInfo[];
}

const fmtTokens = (n: number) => (n < 1000 ? String(n) : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

function Meter({ label, used, limit, unit = "" }: { label: string; used: number; limit: number | null; unit?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted">
          {unit === "tokens" ? fmtTokens(used) : used} {limit === null ? "· unlimited" : `of ${unit === "tokens" ? fmtTokens(limit) : limit}`}
        </span>
      </div>
      {limit !== null ? (
        <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
          <div className={`h-full rounded-full ${unit === "tokens" && pct >= 90 ? "bg-danger" : unit === "tokens" && pct >= 70 ? "bg-warning" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function features(p: PlanInfo): string[] {
  return [
    p.monthly_tokens === null ? "Unlimited AI" : `${fmtTokens(p.monthly_tokens)} AI tokens a month`,
    p.max_ventures === null ? "Unlimited businesses" : `${p.max_ventures} business${p.max_ventures > 1 ? "es" : ""}`,
    p.max_members === null ? "Unlimited people" : `${p.max_members} people`,
    p.autonomy ? "Agents can earn the right to act alone" : "Agents always ask before acting",
  ];
}

export default function BillingPage() {
  const { org, isOwner } = useAccess();
  const qc = useQueryClient();
  const toast = useToast();
  const plan = useQuery({
    queryKey: ["plan", org?.id],
    queryFn: async () => (await unwrap(api.GET("/orgs/{org_id}/plan", { params: { path: { org_id: org!.id } } }))) as unknown as PlanOut,
    enabled: Boolean(org),
  });
  const billing = useQuery({
    queryKey: ["billing", org?.id],
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/billing", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org) && isOwner,
  });
  const [profile, setProfile] = useState({ legal_name: "", gstin: "", address: "", state_code: "", email: "" });
  const [err, setErr] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  useEffect(() => {
    const p = billing.data?.profile;
    if (p) setProfile({ legal_name: p.legal_name, gstin: p.gstin ?? "", address: p.address ?? "", state_code: p.state_code ?? "", email: p.email ?? "" });
  }, [billing.data]);

  const saveProfile = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/orgs/{org_id}/billing/profile", {
          params: { path: { org_id: org!.id } },
          body: { legal_name: profile.legal_name.trim(), gstin: profile.gstin.trim().toUpperCase() || null, address: profile.address, state_code: profile.state_code.trim() || null, email: profile.email.trim() || null },
        }),
      ),
    onSuccess: () => {
      setErr(null);
      toast.success("Billing details saved");
      void qc.invalidateQueries({ queryKey: ["billing", org?.id] });
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const subscribe = useMutation({
    mutationFn: (code: "starter" | "pro") => unwrap(api.POST("/orgs/{org_id}/billing/subscribe", { params: { path: { org_id: org!.id } }, body: { plan: code } })),
    onSuccess: (d) => window.location.assign(d.checkout_url),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/orgs/{org_id}/billing/cancel", { params: { path: { org_id: org!.id } } })),
    onSuccess: () => {
      setCancelOpen(false);
      toast.success("Your plan will end at the close of the paid period");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!org) return <EmptyState icon={CreditCard} title="No organisation yet" description="Finish setup first." />;
  if (plan.isPending) return <SkeletonRows />;
  if (plan.isError) return <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />;
  const p = plan.data;

  return (
    <>
      <PageHeader eyebrow={org.name} title="Plan & billing" description="Your plan, this month's usage, and payments. Prices are per month, plus 18% GST." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader title={`${p.plan.name} plan`} description={p.renews_at ? `Renews ${formatDate(p.renews_at)}` : p.plan.code === "free" ? "Free forever" : undefined} />
          <div className="space-y-4 p-4">
            <Meter label="AI this month" used={p.tokens} limit={p.plan.monthly_tokens} unit="tokens" />
            <Meter label="Businesses" used={p.ventures} limit={p.plan.max_ventures} />
            <Meter label="People" used={p.members} limit={p.plan.max_members} />
            {p.tokens_left === 0 ? (
              <Notice tone="warning" title="AI allowance used">
                Kritvia keeps working on your server&apos;s private model; steps that need a hosted model wait until next month or an upgrade.
              </Notice>
            ) : null}
            <p className="text-xs text-subtle">Only hosted models count. Private (local) model use is always free.</p>
          </div>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3">
          {p.available.map((a) => {
            const current = a.code === p.plan.code;
            return (
              <Card key={a.code} className={`flex flex-col p-4 ${current ? "ring-2 ring-accent" : ""}`}>
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">{a.name}</h2>
                  {current ? <Badge tone="accent">Current</Badge> : null}
                </div>
                <p className="mt-2 text-2xl font-semibold">
                  {a.price_inr ? formatINR(a.price_inr, { whole: true }) : "₹0"}
                  <span className="text-sm font-normal text-subtle">/month</span>
                </p>
                <ul className="mt-3 flex-1 space-y-1.5 text-sm text-muted">
                  {features(a).map((f) => (
                    <li key={f} className="flex gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                      {f}
                    </li>
                  ))}
                </ul>
                {a.code !== "free" && !current && p.plan.code !== "internal" ? (
                  <Button
                    variant="primary"
                    className="mt-4"
                    disabled={!isOwner || !billing.data?.configured}
                    loading={subscribe.isPending && subscribe.variables === a.code}
                    onClick={() => subscribe.mutate(a.code as "starter" | "pro")}
                  >
                    Upgrade
                  </Button>
                ) : null}
              </Card>
            );
          })}
        </div>
      </div>

      {isOwner ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Billing details" description="Shown on your GST invoices. Add your GSTIN to claim input tax credit." />
            <form
              className="space-y-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                saveProfile.mutate();
              }}
            >
              <FormError message={err} />
              <Field label="Legal name" required>
                <Input value={profile.legal_name} maxLength={200} onChange={(e) => setProfile({ ...profile, legal_name: e.target.value })} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <Field label="GSTIN" hint="Optional">
                  <Input value={profile.gstin} maxLength={15} placeholder="07ABCDE1234F1Z5" onChange={(e) => setProfile({ ...profile, gstin: e.target.value.toUpperCase() })} />
                </Field>
                <Field label="State code">
                  <Input value={profile.state_code} maxLength={2} inputMode="numeric" placeholder="07" onChange={(e) => setProfile({ ...profile, state_code: e.target.value })} />
                </Field>
              </div>
              <Field label="Billing address">
                <Input value={profile.address} maxLength={500} onChange={(e) => setProfile({ ...profile, address: e.target.value })} />
              </Field>
              <Field label="Invoice email">
                <Input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
              </Field>
              <Button type="submit" variant="primary" loading={saveProfile.isPending} disabled={!profile.legal_name.trim()}>
                Save
              </Button>
            </form>
          </Card>
          <Card>
            <CardHeader
              title="Payments and invoices"
              actions={
                billing.data?.subscription_id && billing.data.subscription_status !== "cancelled" ? (
                  <Button size="sm" onClick={() => setCancelOpen(true)}>
                    Cancel plan
                  </Button>
                ) : undefined
              }
            />
            <div className="p-4">
              {!billing.data?.configured ? <Notice tone="info">Online payments are being set up. Upgrades open here once they are live.</Notice> : null}
              {billing.data?.events.length ? (
                <ul className="divide-y divide-border text-sm">
                  {billing.data.events.map((e, i) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {e.event.replace(/[._]/g, " ")}
                        {e.plan ? <Badge className="ml-2">{e.plan}</Badge> : null}
                      </span>
                      <span className="flex items-center gap-3 text-muted">
                        {e.amount_paise ? formatINR(e.amount_paise / 100) : null}
                        {e.invoice_url ? (
                          <a href={e.invoice_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                            Invoice <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                        <span className="text-xs">{formatDateTime(e.created_at)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-subtle">No payments yet.</p>
              )}
            </div>
          </Card>
        </div>
      ) : (
        <Notice tone="info" className="mt-4">
          Only the organisation&apos;s owner can change the plan or see payments.
        </Notice>
      )}
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => cancel.mutate()}
        loading={cancel.isPending}
        title="Cancel your plan?"
        description="You keep everything until the end of the period you paid for, then move to the Free plan. Your data stays."
        confirmLabel="Cancel plan"
      />
    </>
  );
}
