"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ExternalLink } from "lucide-react";
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
import { PricingTable } from "@/components/public/pricing-table";
import { rupees, type Period, type PlanCard } from "@/lib/pricing";
import { trialNote, type Trial } from "@/lib/trial";

interface PlanInfo extends PlanCard {
  max_ventures: number | null;
  max_members: number | null;
  storage_bytes: number | null;
  autonomy: boolean;
}
interface PlanOut {
  plan: PlanInfo;
  tokens: number;
  tokens_left: number | null;
  ventures: number;
  members: number;
  storage_bytes: number;
  renews_at: string | null;
  trial: Trial | null;
  read_only: boolean;
  available: PlanInfo[];
  token_packs: { code: string; tokens: number; price_inr: number }[];
}
type SelfServe = "starter" | "growth" | "scale";
const SELF_SERVE = ["starter", "growth", "scale"];

const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n % 1024 ** 3 ? 1 : 0)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const fmtTokens = (n: number) => (n < 1000 ? String(n) : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

function Meter({ label, used, limit, unit = "" }: { label: string; used: number; limit: number | null; unit?: "" | "tokens" | "bytes" }) {
  const fmt = (n: number) => (unit === "tokens" ? fmtTokens(n) : unit === "bytes" ? fmtBytes(n) : String(n));
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted">
          {fmt(used)} {limit === null ? "· unlimited" : `of ${fmt(limit)}`}
        </span>
      </div>
      {limit !== null ? (
        <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
          <div className={`h-full rounded-full transition-[width] duration-500 ease-out ${unit && pct >= 90 ? "bg-danger" : unit && pct >= 70 ? "bg-warning" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
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
    mutationFn: (v: { plan: SelfServe; period: Period }) => unwrap(api.POST("/orgs/{org_id}/billing/subscribe", { params: { path: { org_id: org!.id } }, body: v })),
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
      <PageHeader eyebrow={org.name} title="Plan & billing" description="Your plan, this month's usage, and payments. Prices include 18% GST; pay monthly, or yearly and get two months free." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title={p.plan.code === "free" || p.plan.code === "expired" ? p.plan.name : `${p.plan.name} plan`} description={p.renews_at ? `Renews ${formatDate(p.renews_at)}` : p.plan.code === "free" ? trialNote(p.trial) : p.plan.code === "expired" ? "Read-only until you choose a plan" : undefined} />
          <div className="space-y-4 p-4">
            <Meter label="AI this month" used={p.tokens} limit={p.plan.monthly_tokens} unit="tokens" />
            <Meter label="Businesses" used={p.ventures} limit={p.plan.max_ventures} />
            <Meter label="People" used={p.members} limit={p.plan.max_members} />
            <Meter label="Business memory" used={p.storage_bytes} limit={p.plan.storage_bytes} unit="bytes" />
            {p.tokens_left === 0 ? (
              <Notice tone="warning" title="AI allowance used">
                Kritvia keeps working on your server&apos;s private model; steps that need a hosted model wait until next month, an extra usage pack or an upgrade.
              </Notice>
            ) : null}
            <p className="text-xs text-subtle">Only hosted models count. Private (local) model use is always free.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Extra AI usage" description="For a busy month. A pack adds hosted-AI tokens for the month you buy it." />
          <ul className="divide-y divide-border">
            {p.token_packs.map((t) => (
              <li key={t.code} className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">+{fmtTokens(t.tokens)} tokens</p>
                  <p className="text-xs text-subtle">{rupees(t.price_inr)} incl. GST</p>
                </div>
                <Button size="sm" disabled title="Usage packs go on sale when online payments are live">
                  Available soon
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <section aria-labelledby="plans" className="mt-8">
        <h2 id="plans" className="mb-4 text-lg font-semibold">
          Plans
        </h2>
        <PricingTable
          plans={p.available.filter((a) => a.code !== "enterprise")}
          current={p.plan.code}
          action={(a, period) => {
            if (a.code === p.plan.code) return <Button className="w-full" disabled>Your plan</Button>;
            if (p.plan.code === "internal") return <Button className="w-full" disabled>Included</Button>;
            if (!SELF_SERVE.includes(a.code)) return null;
            const live = Boolean(billing.data?.configured);
            return (
              <Button
                variant={a.featured ? "primary" : "secondary"}
                className="w-full"
                disabled={!isOwner || !live}
                title={live ? undefined : "Upgrades open when online payments are live"}
                loading={subscribe.isPending && subscribe.variables?.plan === a.code}
                onClick={() => subscribe.mutate({ plan: a.code as SelfServe, period })}
              >
                {live ? `Choose ${a.name}` : "Available soon"}
              </Button>
            );
          }}
        />
      </section>

      {isOwner ? (
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
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
        description="You keep everything until the end of the period you paid for, then the organisation becomes read-only until you choose a plan again. Your data stays."
        confirmLabel="Cancel plan"
      />
    </>
  );
}
