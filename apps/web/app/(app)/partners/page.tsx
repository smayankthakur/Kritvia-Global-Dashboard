"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Handshake } from "lucide-react";
import { useState } from "react";
import { rupees } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Page = Schemas["PartnerPage"];

function Apply({ terms }: { terms: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ name: "", firm: "", kind: "ca", city: "", phone: "", upi_id: "", code: "" });
  const [error, setError] = useState<string | null>(null);
  const apply = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/partners/apply", {
          body: {
            name: f.name.trim(), firm: f.firm.trim() || null, kind: f.kind as "ca", city: f.city.trim() || null,
            phone: f.phone.trim() || null, upi_id: f.upi_id.trim() || null, code: f.code.trim() || null,
          },
        }),
      ),
    onSuccess: () => {
      toast.success("Application sent", "Kritvia's team will look at it within two working days.");
      void qc.invalidateQueries({ queryKey: ["partners", "me"] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  return (
    <Card>
      <CardHeader title="Become a Kritvia partner" description={terms} />
      <p className="px-4 text-xs text-subtle">
        By applying you agree to the partner programme terms in section 21 of our{" "}
        <a href="/terms" className="underline">
          Terms of Service
        </a>
        .
      </p>
      <form
        className="grid gap-3 p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name.trim()) apply.mutate();
        }}
      >
        <Field label="Your name" required>
          <Input value={f.name} onChange={(e) => set("name")(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Firm">
          <Input value={f.firm} onChange={(e) => set("firm")(e.target.value)} maxLength={160} placeholder="Mehta & Co" />
        </Field>
        <Field label="You are">
          <Select value={f.kind} onChange={(e) => set("kind")(e.target.value)}>
            <option value="ca">A chartered accountant</option>
            <option value="agency">A digital or marketing agency</option>
            <option value="consultant">A consultant</option>
            <option value="other">Something else</option>
          </Select>
        </Field>
        <Field label="City">
          <Input value={f.city} onChange={(e) => set("city")(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(e) => set("phone")(e.target.value)} inputMode="tel" maxLength={24} />
        </Field>
        <Field label="UPI ID for payouts">
          <Input value={f.upi_id} onChange={(e) => set("upi_id")(e.target.value)} placeholder="name@bank" maxLength={300} />
        </Field>
        <Field label="Code you'd like (optional)" hint="4–12 letters or digits">
          <Input value={f.code} onChange={(e) => set("code")(e.target.value.toUpperCase())} maxLength={12} placeholder="MEHTA10" />
        </Field>
        <div className="sm:col-span-2">
          <FormError message={error} />
          <Button type="submit" variant="primary" loading={apply.isPending}>
            Apply
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function PartnersPage() {
  const q = useQuery({ queryKey: ["partners", "me"], queryFn: () => unwrap(api.GET("/partners/me")) });
  return (
    <div className="space-y-6">
      <PageHeader title="Partner programme" description="For CAs, agencies and consultants who bring businesses to Kritvia." />
      <QueryState query={q} loading={<SkeletonRows rows={4} />}>
        {(d: Page) =>
          !d.partner ? (
            <Apply terms={d.terms} />
          ) : (
            <>
              {d.partner.status === "applied" ? (
                <Notice tone="info" title="Your application is with Kritvia's team">Your code starts working once it&apos;s approved.</Notice>
              ) : d.partner.status !== "active" ? (
                <Notice tone="warning" title={`Your partner account is ${d.partner.status}`}>Write to support@sitelytc.com if this looks wrong.</Notice>
              ) : null}
              <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="flex items-center gap-2 text-lg font-semibold">
                      <Handshake className="h-5 w-5 text-accent" aria-hidden /> {d.partner.firm || d.partner.name}
                    </p>
                    <p className="text-sm text-muted">
                      Code <strong>{d.partner.code}</strong> · payouts to {d.partner.upi_id ?? "no UPI ID yet"}
                    </p>
                  </div>
                  <CopyField className="min-w-64 flex-1" label="Your sign-up link" value={d.partner.link} />
                </div>
                <p className="mt-3 text-xs text-subtle">
                  {d.terms}{" "}
                  <a href="/terms" className="underline">
                    Full terms (section 21)
                  </a>
                </p>
              </Card>
              <Card className="p-4">
                <StatGrid>
                  <Stat label="Businesses" value={String(d.referrals.length)} />
                  <Stat label="Earned" value={rupees(d.earned_paise)} />
                  <Stat label="Paid to you" value={rupees(d.paid_paise)} tone="success" />
                  <Stat label="Due" value={rupees(d.due_paise)} />
                </StatGrid>
              </Card>
              <Card className="overflow-hidden p-0">
                <CardHeader title="Businesses you brought" description="Their name, plan and what you've earned; never their data." />
                <ul className="divide-y divide-border">
                  {d.referrals.map((r) => (
                    <li key={r.name + r.referred_at} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                      <span>
                        <span className="font-medium">{r.name}</span> <Badge>{r.plan}</Badge>
                        <span className="block text-xs text-muted">
                          Joined {formatDate(r.referred_at)} · you earn until {formatDate(r.commission_until)}
                        </span>
                      </span>
                      <span className="tabular-nums">{rupees(r.earned_paise)}</span>
                    </li>
                  ))}
                  {!d.referrals.length ? <li className="px-4 py-3 text-sm text-muted">No businesses yet. Share your link.</li> : null}
                </ul>
              </Card>
              {d.payouts.length ? (
                <Card className="overflow-hidden p-0">
                  <CardHeader title="Payouts" />
                  <ul className="divide-y divide-border">
                    {d.payouts.map((x) => (
                      <li key={x.reference + x.paid_at} className="flex justify-between px-4 py-3 text-sm">
                        <span>
                          {formatDate(x.paid_at)} · ref {x.reference}
                        </span>
                        <span className="tabular-nums">{rupees(x.amount_paise)}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </>
          )
        }
      </QueryState>
    </div>
  );
}
