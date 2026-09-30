"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { hasRole } from "@/lib/access";
import { EMAIL_RE } from "@/lib/auth-client";
import { formatINR, formatRelative, titleCase } from "@/lib/format";
import { useVenture } from "@/lib/venture";
import { LoanOfficerNotice } from "@/components/loans/loan-officer-notice";

type Channel = NonNullable<Schemas["kritvia_api__routers__truhome__ConsentIn"]["channel"]>;
const CHANNELS = enumValues<Channel>()("paper", "web", "email", "whatsapp", "verbal");
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const LOAN_TYPE_RE = /^[a-z0-9_]{2,40}$/;

function CreateApplicationDialog({ open, onClose, ventureId, loanTypes }: { open: boolean; onClose: () => void; ventureId: string; loanTypes: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const blank = { name: "", email: "", phone: "", pan: "", dob: "", loan_type: loanTypes[0] ?? "home_loan", amount: "", notice_version: "v1", channel: "paper" as Channel, consent: false };
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/loan-applications", {
          params: { path: { venture_id: ventureId } },
          body: {
            loan_type: f.loan_type.trim(),
            amount_inr: f.amount.trim() ? f.amount.trim() : null,
            applicant: {
              name: f.name.trim(),
              email: f.email.trim() || null,
              phone: f.phone.trim() || null,
              pan: f.pan.trim() || null,
              dob: f.dob || null,
            },
            consent: { notice_version: f.notice_version.trim(), channel: f.channel },
          },
        }),
      ),
    onSuccess: (app) => {
      toast.success("Application created", app.reference);
      void qc.invalidateQueries({ queryKey: ["loans", ventureId] });
      setF(blank);
      onClose();
      router.push(`/v/${ventureId}/loans/${app.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        const mapped: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.fieldErrors)) mapped[k.replace(/^applicant\./, "").replace(/^consent\./, "")] = v;
        setErrors(mapped);
      }
    },
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = "Applicant name is required";
    if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) errs.email = "Enter a valid email";
    if (f.pan.trim() && !PAN_RE.test(f.pan.trim())) errs.pan = "PAN format: ABCDE1234F";
    if (f.phone.length > 20) errs.phone = "Too long";
    if (!LOAN_TYPE_RE.test(f.loan_type.trim())) errs.loan_type = "lower_snake_case, e.g. home_loan";
    if (f.amount.trim() && !/^\d{1,12}(\.\d{1,2})?$/.test(f.amount.trim())) errs.amount_inr = "Amount in ₹, up to 2 decimals";
    if (!f.notice_version.trim()) errs.notice_version = "Which privacy notice did the applicant see?";
    if (!f.consent) errs.consent = "Consent is required before any document is processed";
    setErrors(errs);
    if (!Object.keys(errs).length) m.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="New loan application"
      description="Applicant details are encrypted at rest and visible only to loan officers."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="loan-form" loading={m.isPending}>
            Create application
          </Button>
        </>
      }
    >
      <form id="loan-form" onSubmit={submit} noValidate className="space-y-5">
        <FormError message={m.isError && !(m.error instanceof ApiError && Object.keys(m.error.fieldErrors).length) ? errorMessage(m.error) : null} />
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Applicant</legend>
          <Field label="Full name" error={errors.name} required className="sm:col-span-2">
            <Input value={f.name} onChange={set("name")} maxLength={200} autoComplete="off" />
          </Field>
          <Field label="Email" error={errors.email} hint="Follow-ups are sent here after your approval">
            <Input type="email" value={f.email} onChange={set("email")} autoComplete="off" />
          </Field>
          <Field label="Phone" error={errors.phone}>
            <Input type="tel" value={f.phone} onChange={set("phone")} maxLength={20} autoComplete="off" />
          </Field>
          <Field label="PAN" error={errors.pan}>
            <Input value={f.pan} onChange={(e) => setF((x) => ({ ...x, pan: e.target.value.toUpperCase() }))} maxLength={10} className="font-mono uppercase" autoComplete="off" />
          </Field>
          <Field label="Date of birth" error={errors.dob}>
            <Input type="date" value={f.dob} onChange={set("dob")} />
          </Field>
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Loan</legend>
          <Field label="Loan type" error={errors.loan_type} hint="Decides which checklist applies" required>
            <Input list="loan-types" value={f.loan_type} onChange={set("loan_type")} className="font-mono text-[13px]" />
            <datalist id="loan-types">
              {loanTypes.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <Field label="Amount (₹)" error={errors.amount_inr} hint={f.amount && /^\d/.test(f.amount) ? formatINR(f.amount) : undefined}>
            <Input inputMode="decimal" value={f.amount} onChange={(e) => setF((x) => ({ ...x, amount: e.target.value.replace(/[,₹\s]/g, "") }))} />
          </Field>
        </fieldset>
        <fieldset className="space-y-3 rounded-lg border border-border bg-surface-2/50 p-4">
          <legend className="px-1 text-sm font-semibold">Consent (DPDP Act)</legend>
          <p className="text-sm text-muted">
            Under the DPDP Act, Truhome may process the applicant&apos;s documents only with recorded consent for loan processing. The
            verification workflow refuses to run without it, and the applicant can withdraw it any time from Compliance.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Privacy notice version" error={errors.notice_version} required>
              <Input value={f.notice_version} onChange={set("notice_version")} maxLength={40} />
            </Field>
            <Field label="Consent captured via">
              <Select value={f.channel} onChange={set("channel")}>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {titleCase(c)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Checkbox
            label="The applicant has given consent to process their documents for this loan"
            checked={f.consent}
            onChange={(e) => setF((x) => ({ ...x, consent: e.target.checked }))}
          />
          {errors.consent ? (
            <p className="text-xs font-medium text-danger" role="alert">
              {errors.consent}
            </p>
          ) : null}
        </fieldset>
      </form>
    </Dialog>
  );
}

export default function LoansPage() {
  const v = useVenture();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const apps = useQuery({
    queryKey: ["loans", v.id, status],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/loan-applications", { params: { path: { venture_id: v.id }, query: { status: status || undefined } } })),
  });
  const checklists = useQuery({ queryKey: ["checklists", v.id], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/checklists", { params: { path: { venture_id: v.id } } })) });
  const loanTypes = (checklists.data ?? []).map((c) => c.loan_type);

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Loan applications"
        description="Documents are classified and checked against the lending checklist by a local model; follow-ups go out only after a loan officer approves."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)} disabled={!hasRole(v, "loan_officer")}>
            New application
          </Button>
        }
      />
      <LoanOfficerNotice ventureId={v.id} roles={v.roles} />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-3">
          <div className="w-48">
            <label htmlFor="loan-status" className="mb-1 block text-xs font-medium text-subtle">
              Status
            </label>
            <Select id="loan-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {["collecting", "verifying", "needs_info", "complete", "submitted", "closed"].map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <QueryState query={apps} empty={<EmptyState icon={Landmark} title="No applications" description="Create an application to start collecting documents." />}>
          {(data) => (
            <Table label="Loan applications">
              <THead>
                <tr>
                  <Th>Reference</Th>
                  <Th>Applicant</Th>
                  <Th className="hidden md:table-cell">Loan type</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th className="hidden sm:table-cell text-right">Missing</Th>
                  <Th className="hidden lg:table-cell">Updated</Th>
                </tr>
              </THead>
              <TBody>
                {data.map((a) => {
                  const missing = ((a.checklist_result as { missing?: unknown[] })?.missing ?? []).length;
                  return (
                    <Tr key={a.id}>
                      <Td className="whitespace-nowrap">
                        <Link href={`/v/${v.id}/loans/${a.id}`} className="font-mono text-[13px] font-medium hover:text-accent">
                          {a.reference}
                        </Link>
                      </Td>
                      <Td className="max-w-[12rem] truncate">{a.applicant.name}</Td>
                      <Td className="hidden font-mono text-xs text-muted md:table-cell">{a.loan_type}</Td>
                      <Td className="text-right whitespace-nowrap tabular-nums">{formatINR(a.amount_inr, { whole: true })}</Td>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={a.status} />
                          {!a.consent_active ? <Badge tone="danger">no consent</Badge> : null}
                        </div>
                      </Td>
                      <Td className="hidden text-right tabular-nums sm:table-cell">{missing ? <span className="font-medium text-warning">{missing}</span> : "0"}</Td>
                      <Td className="hidden whitespace-nowrap text-muted lg:table-cell">{formatRelative(a.updated_at)}</Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          )}
        </QueryState>
      </Card>
      <CreateApplicationDialog open={open} onClose={() => setOpen(false)} ventureId={v.id} loanTypes={loanTypes} />
    </>
  );
}
