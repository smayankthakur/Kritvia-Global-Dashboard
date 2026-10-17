"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { CURRENCIES, ROLE_LABEL } from "@/lib/trade";
import { useVenture } from "@/lib/venture";

type P = Schemas["TradeProfileOut"];
type In = Schemas["TradeProfile"];

function Form({ p, ventureId }: { p: P; ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [roles, setRoles] = useState<string[]>(p.roles ?? ["exporter"]);
  const s = (v: string | null | undefined) => v ?? "";
  const [f, setF] = useState({
    legal_name: p.configured ? p.legal_name : p.legal_name,
    address: p.configured ? p.address : "",
    iec: s(p.iec), gstin: s(p.gstin), ad_code: s(p.ad_code), bank_details: s(p.bank_details), lut_arn: s(p.lut_arn),
    lut_valid_until: s(p.lut_valid_until), cha_licence: s(p.cha_licence), email: s(p.email), phone: s(p.phone),
    default_currency: p.default_currency, realisation_months: String(p.realisation_months), prefix_export: p.prefix_export,
    prefix_import: p.prefix_import, prefix_job: p.prefix_job, declaration: s(p.declaration),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const n = (v: string) => v.trim() || null;
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/trade-profile", {
          params: { path: { venture_id: ventureId } },
          body: {
            roles: roles as In["roles"],
            legal_name: f.legal_name.trim(),
            address: f.address.trim(),
            iec: n(f.iec),
            gstin: n(f.gstin),
            ad_code: n(f.ad_code),
            bank_details: n(f.bank_details),
            lut_arn: n(f.lut_arn),
            lut_valid_until: f.lut_valid_until || null,
            cha_licence: n(f.cha_licence),
            email: n(f.email),
            phone: n(f.phone),
            default_currency: f.default_currency,
            realisation_months: Number(f.realisation_months) || 9,
            prefix_export: f.prefix_export.trim().toUpperCase(),
            prefix_import: f.prefix_import.trim().toUpperCase(),
            prefix_job: f.prefix_job.trim().toUpperCase(),
            declaration: n(f.declaration),
          },
        }),
      ),
    onSuccess: (d) => {
      qc.setQueryData(["trade-profile", ventureId], d);
      toast.success("Trade profile saved");
    },
  });
  const ro = !p.can_edit;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-6">
      {ro ? <Notice tone="info">Only the business&apos;s admins can change the trade profile.</Notice> : null}
      <fieldset disabled={ro} className="space-y-6">
        <Card>
          <CardHeader title="What you do" description="Decides which kinds of shipment files you can open." />
          <CardBody className="flex flex-wrap gap-4">
            {Object.entries(ROLE_LABEL).map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={roles.includes(k)}
                  onChange={(e) => setRoles(e.target.checked ? [...roles, k] : roles.filter((r) => r !== k))}
                />
                {l}
              </label>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="On your documents" description="Printed on export invoices and packing lists." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Legal name" required>
              <Input value={f.legal_name} onChange={set("legal_name")} maxLength={160} />
            </Field>
            <Field label="IEC (Importer-Exporter Code)" hint="10 characters, from DGFT">
              <Input value={f.iec} onChange={set("iec")} maxLength={10} autoCapitalize="characters" />
            </Field>
            <Field label="Address" required className="sm:col-span-2">
              <Textarea rows={2} value={f.address} onChange={set("address")} maxLength={400} />
            </Field>
            <Field label="GSTIN">
              <Input value={f.gstin} onChange={set("gstin")} maxLength={15} autoCapitalize="characters" />
            </Field>
            <Field label="AD code" hint="Your bank's Authorised Dealer code, registered at the port">
              <Input value={f.ad_code} onChange={set("ad_code")} maxLength={20} inputMode="numeric" />
            </Field>
            <Field label="Email">
              <Input type="email" value={f.email} onChange={set("email")} maxLength={254} />
            </Field>
            <Field label="Phone">
              <Input value={f.phone} onChange={set("phone")} maxLength={24} />
            </Field>
            <Field label="Bank details" hint="Beneficiary, bank, account, SWIFT, IFSC" className="sm:col-span-2">
              <Textarea rows={3} value={f.bank_details} onChange={set("bank_details")} maxLength={600} />
            </Field>
            <Field label="Declaration" hint="Printed at the foot of the export invoice" className="sm:col-span-2">
              <Textarea rows={2} value={f.declaration} onChange={set("declaration")} maxLength={600} placeholder="We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct." />
            </Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Exports" description="The LUT lets you export without paying IGST. Kritvia reminds you before it runs out." />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label="LUT ARN">
              <Input value={f.lut_arn} onChange={set("lut_arn")} maxLength={30} />
            </Field>
            <Field label="LUT valid until" hint="Usually 31 March">
              <Input type="date" value={f.lut_valid_until} onChange={set("lut_valid_until")} />
            </Field>
            <Field label="Months to realise export proceeds" hint="RBI rule; 9 unless your bank tells you otherwise">
              <Input inputMode="numeric" value={f.realisation_months} onChange={set("realisation_months")} />
            </Field>
            <Field label="Default currency">
              <Select value={f.default_currency} onChange={set("default_currency")}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            {roles.includes("cha") ? (
              <Field label="Customs broker licence no.">
                <Input value={f.cha_licence} onChange={set("cha_licence")} maxLength={40} />
              </Field>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="File numbers" description="Files are numbered PREFIX/26-27/0001, a new series each financial year." />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Field label="Exports">
              <Input value={f.prefix_export} onChange={set("prefix_export")} maxLength={5} />
            </Field>
            <Field label="Imports">
              <Input value={f.prefix_import} onChange={set("prefix_import")} maxLength={5} />
            </Field>
            <Field label="C&F jobs">
              <Input value={f.prefix_job} onChange={set("prefix_job")} maxLength={5} />
            </Field>
          </CardBody>
        </Card>
      </fieldset>
      <FormError message={m.isError ? errorMessage(m.error) : null} />
      {ro ? null : (
        <Button type="submit" variant="primary" loading={m.isPending} disabled={!roles.length || !f.legal_name.trim() || f.address.trim().length < 5}>
          Save trade profile
        </Button>
      )}
    </form>
  );
}

export default function TradeProfilePage() {
  const v = useVenture();
  const q = useQuery({
    queryKey: ["trade-profile", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/trade-profile", { params: { path: { venture_id: v.id } } })),
  });
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Trade profile"
        description={
          <>
            Your export and import details, used on documents and for reminders. Shipment files follow{" "}
            <Link href="/terms" className="text-accent hover:underline">
              Terms 7.12
            </Link>
            : you check what is printed and file with customs, your bank and the GST portal yourself.
          </>
        }
      />
      <QueryState query={q} loading={<SkeletonRows rows={6} />}>
        {(p) => <Form key={String(p.configured)} p={p} ventureId={v.id} />}
      </QueryState>
    </>
  );
}
