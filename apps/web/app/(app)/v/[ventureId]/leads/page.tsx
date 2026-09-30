"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { KeyValue, Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { EMAIL_RE } from "@/lib/auth-client";
import { displayValue } from "@/lib/diff";
import { formatDateTime, formatINR, formatRelative, titleCase } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Lead = Schemas["LeadOut"];
type LeadStatus = NonNullable<Schemas["LeadPatch"]["status"]>;
const LEAD_STATUSES = enumValues<LeadStatus>()("new", "qualified", "proposal", "won", "lost", "archived");
type Source = NonNullable<Schemas["InquiryIn"]["source"]>;
const SOURCES = enumValues<Source>()("manual", "referral", "email", "webhook");

function ScoreBar({ score }: { score: number | null }) {
  if (score === null || score === undefined) return <span className="text-subtle">—</span>;
  const tone = score >= 70 ? "bg-danger" : score >= 40 ? "bg-warning" : "bg-info";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className={`h-full ${tone}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-sm font-medium tabular-nums">{score}</span>
    </div>
  );
}

function NewInquiryDialog({ open, onClose, ventureId }: { open: boolean; onClose: () => void; ventureId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const empty = { from_name: "", from_email: "", company: "", subject: "", body: "", source: "manual" as Source };
  const [f, setF] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [started, setStarted] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/leads/inquiry", {
          params: { path: { venture_id: ventureId } },
          body: {
            from_name: f.from_name.trim() || null,
            from_email: f.from_email.trim() || null,
            company: f.company.trim() || null,
            subject: f.subject.trim() || null,
            body: f.body.trim(),
            source: f.source,
          },
        }),
      ),
    onSuccess: (out) => {
      setStarted(out.run_id);
      toast.success("Inquiry received", "Lead triage is running.");
      void qc.invalidateQueries({ queryKey: ["runs", ventureId] });
      void qc.invalidateQueries({ queryKey: ["leads", ventureId] });
    },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
    },
  });
  const close = () => {
    setF(empty);
    setErrors({});
    setStarted(null);
    m.reset();
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (f.body.trim().length < 3) errs.body = "Paste the inquiry text (at least 3 characters)";
    if (f.from_email.trim() && !EMAIL_RE.test(f.from_email.trim())) errs.from_email = "Enter a valid email";
    setErrors(errs);
    if (!Object.keys(errs).length) m.mutate();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New inquiry"
      description="Paste an inquiry from WhatsApp, a call or a referral. The triage agent scores it, prices it from the rate card and drafts a proposal for your approval."
      size="lg"
      footer={
        started ? (
          <>
            <Button onClick={close}>Close</Button>
            <ButtonLink href={`/v/${ventureId}/runs/${started}`} variant="primary" icon={<ArrowRight className="h-4 w-4" />}>
              View run
            </ButtonLink>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="inquiry-form" loading={m.isPending}>
              Start triage
            </Button>
          </>
        )
      }
    >
      {started ? (
        <Notice tone="success" title="Triage started">
          The run is working in the background. Drafts will land in your inbox.{" "}
          <Link className="font-medium underline" href={`/v/${ventureId}/runs/${started}`}>
            Follow the run
          </Link>
        </Notice>
      ) : (
        <form id="inquiry-form" onSubmit={submit} noValidate className="space-y-4">
          <FormError message={m.isError && !Object.keys(errors).length ? errorMessage(m.error) : null} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={errors.from_name}>
              <Input value={f.from_name} onChange={set("from_name")} maxLength={200} />
            </Field>
            <Field label="Email" error={errors.from_email}>
              <Input type="email" value={f.from_email} onChange={set("from_email")} />
            </Field>
            <Field label="Company" error={errors.company}>
              <Input value={f.company} onChange={set("company")} maxLength={200} />
            </Field>
            <Field label="Source">
              <Select value={f.source} onChange={set("source")}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {titleCase(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Subject" error={errors.subject}>
            <Input value={f.subject} onChange={set("subject")} maxLength={300} />
          </Field>
          <Field label="Inquiry" error={errors.body} required>
            <Textarea
              rows={7}
              value={f.body}
              onChange={set("body")}
              maxLength={20000}
              placeholder="Hi, we need a Next.js website with 8 pages and a WhatsApp chatbot. Budget around ₹3 lakh, launch in 6 weeks."
            />
          </Field>
        </form>
      )}
    </Dialog>
  );
}

function LeadDrawer({ lead, ventureId, onClose }: { lead: Lead | null; ventureId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<string>("");
  const patch = useMutation({
    mutationFn: (s: LeadStatus) =>
      unwrap(api.PATCH("/ventures/{venture_id}/leads/{lead_id}", { params: { path: { venture_id: ventureId, lead_id: lead!.id } }, body: { status: s } })),
    onSuccess: () => {
      toast.success("Lead updated");
      void qc.invalidateQueries({ queryKey: ["leads", ventureId] });
    },
    onError: (e) => toast.error("Could not update lead", errorMessage(e)),
  });
  const reasons = (lead?.score_reasons ?? []) as { factor?: string; points?: number; detail?: string }[];
  const details = (lead?.details ?? {}) as Record<string, unknown>;
  return (
    <Sheet open={Boolean(lead)} onClose={onClose} title={lead?.name ?? "Lead"} description={lead?.company ?? lead?.email ?? undefined} size="lg">
      {lead ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={lead.status} />
            {lead.priority ? <StatusBadge status={lead.priority} /> : null}
            <Badge>{lead.source}</Badge>
            {lead.inquiry_count && lead.inquiry_count > 1 ? <Badge tone="info">{lead.inquiry_count} inquiries</Badge> : null}
          </div>
          <KeyValue
            items={[
              ["Email", lead.email ?? "—"],
              ["Phone", lead.phone ?? "—"],
              ["Budget", formatINR(lead.budget_inr)],
              ["Timeline", lead.timeline ?? "—"],
              ["First seen", formatDateTime(lead.created_at)],
              ["Last inquiry", formatDateTime(lead.last_inquiry_at)],
            ]}
          />
          <section>
            <h3 className="mb-2 text-sm font-semibold">
              Score <span className="text-subtle">{lead.score ?? "—"}/100</span>
            </h3>
            {reasons.length ? (
              <ul className="space-y-2">
                {reasons.map((r, i) => (
                  <li key={i} className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted">{titleCase(r.factor)}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                      <div className="h-full bg-accent" style={{ width: `${Math.min(100, ((r.points ?? 0) / 35) * 100)}%` }} />
                    </div>
                    <span className="w-10 text-right font-medium tabular-nums">+{r.points ?? 0}</span>
                    <span className="hidden w-36 truncate text-xs text-subtle sm:block" title={r.detail}>
                      {r.detail}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-subtle">Not scored yet.</p>
            )}
          </section>
          {Object.keys(details).length ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Extracted details</h3>
              <div className="space-y-3 text-sm">
                {typeof details.summary === "string" ? <p className="text-muted">{details.summary}</p> : null}
                {Array.isArray(details.requirements) && details.requirements.length ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {(details.requirements as unknown[]).map((r, i) => (
                      <li key={i}>{displayValue(r)}</li>
                    ))}
                  </ul>
                ) : null}
                <KeyValue
                  items={Object.entries(details)
                    .filter(([k]) => k !== "summary" && k !== "requirements")
                    .map(([k, val]) => [titleCase(k), <span key={k} className="whitespace-pre-wrap">{displayValue(val) || "—"}</span>])}
                />
              </div>
            </section>
          ) : null}
          {lead.notes ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Notes</h3>
              <p className="text-sm whitespace-pre-wrap text-muted">{lead.notes}</p>
            </section>
          ) : null}
          <section className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
            <Field label="Status" className="w-44">
              <Select value={status || lead.status} onChange={(e) => setStatus(e.target.value)}>
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Button loading={patch.isPending} disabled={!status || status === lead.status} onClick={() => patch.mutate(status as LeadStatus)}>
              Update status
            </Button>
            <div className="ml-auto flex gap-2">
              <ButtonLink href={`/v/${ventureId}/proposals?lead=${lead.id}`} size="md">
                Proposals
              </ButtonLink>
              {lead.last_run_id ? (
                <ButtonLink href={`/v/${ventureId}/runs/${lead.last_run_id}`} size="md">
                  Last run
                </ButtonLink>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}

function LeadsView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const leads = useQuery({
    queryKey: ["leads", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/leads", { params: { path: { venture_id: v.id }, query: { limit: 200 } } })),
  });
  const selectedId = params.get("lead");
  const selected = leads.data?.find((l) => l.id === selectedId) ?? null;
  const select = (id: string | null) => router.replace(id ? `/v/${v.id}/leads?lead=${id}` : `/v/${v.id}/leads`, { scroll: false });

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Leads"
        description="Inbound inquiries, scored and priced by the triage agent."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
            New inquiry
          </Button>
        }
      />
      <Card>
        <QueryState
          query={leads}
          loading={<SkeletonRows rows={6} />}
          empty={
            <EmptyState
              icon={Users}
              title="No leads yet"
              description="Paste your first inquiry, connect Gmail or add the lead-form webhook in Settings."
              action={<Button onClick={() => setOpen(true)}>New inquiry</Button>}
            />
          }
        >
          {(data) => (
            <Table label="Leads">
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th className="hidden md:table-cell">Email</Th>
                  <Th>Score</Th>
                  <Th>Priority</Th>
                  <Th className="hidden sm:table-cell">Status</Th>
                  <Th className="hidden lg:table-cell text-right">Inquiries</Th>
                  <Th className="hidden lg:table-cell text-right">Budget</Th>
                  <Th className="hidden xl:table-cell">Last inquiry</Th>
                </tr>
              </THead>
              <TBody>
                {data.map((l) => (
                  <Tr key={l.id} interactive onClick={() => select(l.id)}>
                    <Td className="max-w-[14rem]">
                      <button
                        type="button"
                        className="block max-w-full truncate text-left font-medium hover:text-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          select(l.id);
                        }}
                      >
                        {l.name}
                      </button>
                      <span className="block truncate text-xs text-subtle">{l.company ?? "—"}</span>
                    </Td>
                    <Td className="hidden max-w-[14rem] truncate text-muted md:table-cell">{l.email ?? "—"}</Td>
                    <Td>
                      <ScoreBar score={l.score} />
                    </Td>
                    <Td>{l.priority ? <StatusBadge status={l.priority} /> : <span className="text-subtle">—</span>}</Td>
                    <Td className="hidden sm:table-cell">
                      <StatusBadge status={l.status} />
                    </Td>
                    <Td className="hidden text-right tabular-nums lg:table-cell">{l.inquiry_count ?? 1}</Td>
                    <Td className="hidden text-right whitespace-nowrap tabular-nums lg:table-cell">{formatINR(l.budget_inr, { whole: true })}</Td>
                    <Td className="hidden whitespace-nowrap text-muted xl:table-cell">{formatRelative(l.last_inquiry_at ?? l.created_at)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </QueryState>
      </Card>
      {selectedId && leads.isSuccess && !selected ? <ErrorState error={new ApiError(404, "lead not found")} /> : null}
      <LeadDrawer lead={selected} ventureId={v.id} onClose={() => select(null)} />
      <NewInquiryDialog open={open} onClose={() => setOpen(false)} ventureId={v.id} />
    </>
  );
}

export default function LeadsPage() {
  return (
    <Suspense>
      <LeadsView />
    </Suspense>
  );
}
