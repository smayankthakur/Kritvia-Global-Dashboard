"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FilePlus2, Pencil, Plus, Trash2, UserPlus, Users } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Dialog, Sheet } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { KeyValue, Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { EMAIL_RE } from "@/lib/auth-client";
import { displayValue } from "@/lib/diff";
import { formatDateTime, formatINR, formatRelative, titleCase } from "@/lib/format";
import { useVenture } from "@/lib/venture";
import { ProspectPanel, leadName, outreachState } from "@/components/leads/prospect-panel";
import { LeadFormDialog, NewProposalDialog, phoneProblem } from "@/components/leads/lead-forms";
import { PAGE_SIZE, flatPages, unwrapPage } from "@/lib/paging";
import { chunk, stillListed, toggled } from "@/lib/selection";

type Lead = Schemas["LeadOut"];
type LeadStatus = NonNullable<Schemas["LeadPatch"]["status"]>;
const LEAD_STATUSES = enumValues<LeadStatus>()("new", "contacted", "replied", "qualified", "proposal", "won", "lost", "archived");
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
  const empty = { from_name: "", from_email: "", from_phone: "", company: "", subject: "", body: "", source: "manual" as Source };
  const [f, setF] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [started, setStarted] = useState<string | null>(null);
  const m = useMutation({
    // Started as a lead-triage run so the phone number travels with it: the lead keeps it even when the AI
    // can't read the enquiry (round 3, A7).
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/runs", {
          params: { path: { venture_id: ventureId } },
          body: {
            workflow: "lead_triage",
            title: `Inquiry: ${f.company.trim() || f.from_name.trim() || f.from_email.trim() || f.from_phone.trim() || "unknown"}`.slice(0, 200),
            input: {
              from_name: f.from_name.trim() || null,
              from_email: f.from_email.trim() || null,
              from_phone: f.from_phone.trim() || null,
              company: f.company.trim() || null,
              subject: f.subject.trim() || null,
              body: f.body.trim(),
              source: f.source,
            },
          },
        }),
      ),
    onSuccess: (out) => {
      setStarted(out.id);
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
    const phone = phoneProblem(f.from_phone);
    if (phone) errs.from_phone = phone;
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
            <Field label="Phone" error={errors.from_phone}>
              <Input type="tel" inputMode="tel" value={f.from_phone} onChange={set("from_phone")} maxLength={30} placeholder="+91 98100 12345" />
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

function LeadDrawer({ lead, ventureId, onClose, onDeleted }: { lead: Lead | null; ventureId: string; onClose: () => void; onDeleted: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/leads/{lead_id}", { params: { path: { venture_id: ventureId, lead_id: id } } })),
    onSuccess: (_, id) => {
      toast.success("Lead deleted");
      setDeleting(false);
      onDeleted(id);
      void qc.invalidateQueries({ queryKey: ["leads", ventureId] });
      void qc.invalidateQueries({ queryKey: ["proposals", ventureId] });
    },
    onError: (e) => toast.error("Could not delete the lead", errorMessage(e)),
  });
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
    <Sheet open={Boolean(lead)} onClose={onClose} title={lead ? leadName(lead) : "Lead"} description={lead?.company ?? lead?.email ?? undefined} size="lg">
      {lead ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" icon={<FilePlus2 className="h-3.5 w-3.5" />} onClick={() => setProposing(true)}>
              New proposal
            </Button>
            <Button size="sm" variant="ghost" className="text-danger hover:text-danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDeleting(true)}>
              Delete
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={lead.status} />
            {lead.priority ? <StatusBadge status={lead.priority} /> : null}
            <Badge>{lead.source}</Badge>
            {lead.inquiry_count && lead.inquiry_count > 1 ? <Badge tone="info">{lead.inquiry_count} inquiries</Badge> : null}
          </div>
          {lead.source === "prospector" ? <ProspectPanel lead={lead} ventureId={ventureId} /> : null}
          <KeyValue
            items={[
              ["Company", lead.company ?? "—"],
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
      {lead ? (
        <>
          <LeadFormDialog open={editing} onClose={() => setEditing(false)} ventureId={ventureId} lead={lead} />
          <NewProposalDialog open={proposing} onClose={() => setProposing(false)} ventureId={ventureId} lead={lead} />
          <ConfirmDialog
            open={deleting}
            onClose={() => setDeleting(false)}
            onConfirm={() => del.mutate(lead.id)}
            loading={del.isPending}
            title="Delete this lead?"
            description={`${leadName(lead)} and their proposals are deleted. This can't be undone.`}
            confirmLabel="Delete lead"
          />
        </>
      ) : null}
    </Sheet>
  );
}

function LeadsView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const leads = useInfiniteQuery({
    queryKey: ["leads", v.id, "list"],
    // Prospects are named from Google Maps only when opened: each lookup is billed by Google.
    queryFn: ({ pageParam }) =>
      unwrapPage(api.GET("/ventures/{venture_id}/leads", { params: { path: { venture_id: v.id }, query: { limit: PAGE_SIZE, cursor: pageParam ?? undefined } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const all = flatPages(leads.data?.pages);
  const selectedId = params.get("lead");
  const inList = all.find((l) => l.id === selectedId) ?? null;
  // A link to a lead not loaded yet (or from a notification) opens it on its own.
  const single = useQuery({
    queryKey: ["leads", v.id, "one", selectedId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/leads/{lead_id}", { params: { path: { venture_id: v.id, lead_id: selectedId! } } })),
    enabled: Boolean(selectedId) && leads.isSuccess && !inList,
    retry: false,
  });
  const selected = inList ?? (single.data && single.data.id === selectedId ? single.data : null);
  const toast = useToast();
  // A lead that was removed (or a stale bookmark): say so once and drop it from the address, rather than
  // showing an error under a list that loaded fine.
  useEffect(() => {
    if (!selectedId || !single.isError) return;
    toast.info("That lead is no longer available", "It may have been removed. Showing all leads.");
    router.replace(`/v/${v.id}/leads`, { scroll: false });
  }, [selectedId, single.isError, toast, router, v.id]);
  const [readyOnly, setReadyOnly] = useState(false);
  const ready = all.filter((l) => l.outreach_draft && !l.opted_out_at);
  // Opening a lead adds a history entry, so Back returns to the list (round 3, A16); closing it goes back.
  const opened = useRef(false);
  const select = (id: string | null) => {
    if (id) {
      opened.current = true;
      router.push(`/v/${v.id}/leads?lead=${id}`, { scroll: false });
    } else if (opened.current) {
      opened.current = false;
      router.back();
    } else router.replace(`/v/${v.id}/leads`, { scroll: false });
  };

  const rows = readyOnly && ready.length ? ready : all;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const picked = stillListed(checked, all);
  const allChecked = rows.length > 0 && rows.every((l) => checked.has(l.id));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      let deleted = 0;
      for (const part of chunk(ids, 500))
        deleted += (await unwrap(api.POST("/ventures/{venture_id}/leads/bulk-delete", { params: { path: { venture_id: v.id } }, body: { ids: part } }))).deleted;
      return deleted;
    },
    onSuccess: (deleted, ids) => {
      toast.success(`${deleted} lead${deleted === 1 ? "" : "s"} deleted`, "Their proposals were deleted too.");
      setChecked(new Set());
      setConfirmDelete(false);
      if (selectedId && ids.includes(selectedId)) router.replace(`/v/${v.id}/leads`, { scroll: false });
      void qc.invalidateQueries({ queryKey: ["leads", v.id] });
      void qc.invalidateQueries({ queryKey: ["proposals", v.id] });
    },
    onError: (e) => toast.error("Could not delete", errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Leads"
        description="Inbound inquiries scored by the triage agent, and businesses the Prospector found for you."
        actions={
          <>
            <Button icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Add a lead
            </Button>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
              New inquiry
            </Button>
          </>
        }
      />
      {ready.length ? (
        <Notice tone="warning" className="mb-4">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {ready.length} WhatsApp message{ready.length === 1 ? " is" : "s are"} ready for you to send.
            </span>
            <button type="button" className="font-medium underline underline-offset-2" onClick={() => setReadyOnly((r) => !r)} aria-pressed={readyOnly}>
              {readyOnly ? "Show all leads" : "Show only these"}
            </button>
          </span>
        </Notice>
      ) : null}
      {picked.length ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2">
          <span className="text-sm text-muted">{picked.length} selected</span>
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setChecked(new Set())}>
              Clear
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirmDelete(true)}>
              Delete selected
            </Button>
          </span>
        </div>
      ) : null}
      <Card>
        {leads.isPending ? (
          <SkeletonRows rows={6} />
        ) : leads.isError ? (
          <ErrorState error={leads.error} onRetry={() => void leads.refetch()} />
        ) : all.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No leads yet"
            description="Paste your first inquiry, connect Gmail or add the lead-form webhook in Settings."
            action={<Button onClick={() => setOpen(true)}>New inquiry</Button>}
          />
        ) : (
          <>
            <Table label="Leads">
              <THead>
                <tr>
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border-strong accent-[var(--accent)]"
                      aria-label="Select all leads shown"
                      checked={allChecked}
                      onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((l) => l.id)) : new Set())}
                    />
                  </Th>
                  <Th>Name</Th>
                  <Th className="hidden md:table-cell">Contact</Th>
                  <Th>Score</Th>
                  <Th>Priority</Th>
                  <Th className="hidden sm:table-cell">Status</Th>
                  <Th className="hidden lg:table-cell text-right">Inquiries</Th>
                  <Th className="hidden lg:table-cell text-right">Budget</Th>
                  <Th className="hidden xl:table-cell">Last inquiry</Th>
                </tr>
              </THead>
              <TBody>
                {rows.map((l) => (
                  <Tr key={l.id} interactive onClick={() => select(l.id)}>
                    {/* The checkbox cell only selects; it doesn't open the lead. */}
                    <Td className="w-8" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border-strong accent-[var(--accent)]"
                        aria-label={`Select ${leadName(l)}`}
                        checked={checked.has(l.id)}
                        onChange={(e) => setChecked((s) => toggled(s, l.id, e.target.checked))}
                      />
                    </Td>
                    <Td className="max-w-[14rem]">
                      <button
                        type="button"
                        className="block max-w-full truncate text-left font-medium hover:text-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          select(l.id);
                        }}
                      >
                        {leadName(l)}
                      </button>
                      <span className="block truncate text-xs text-subtle">
                        {l.source === "prospector" ? outreachState(l).label : (l.company ?? "—")}
                      </span>
                    </Td>
                    <Td className="hidden max-w-[14rem] truncate text-muted md:table-cell">{l.email ?? l.phone ?? "—"}</Td>
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
            {leads.hasNextPage ? (
              <div className="flex justify-center border-t border-border p-3">
                <Button loading={leads.isFetchingNextPage} onClick={() => void leads.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
      <LeadDrawer
        lead={selected}
        ventureId={v.id}
        onClose={() => select(null)}
        onDeleted={(id) => {
          setChecked((s) => toggled(s, id, false));
          opened.current = false;
          router.replace(`/v/${v.id}/leads`, { scroll: false });
        }}
      />
      <NewInquiryDialog open={open} onClose={() => setOpen(false)} ventureId={v.id} />
      <LeadFormDialog open={adding} onClose={() => setAdding(false)} ventureId={v.id} />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => bulkDelete.mutate(picked)}
        loading={bulkDelete.isPending}
        title={`Delete ${picked.length} lead${picked.length === 1 ? "" : "s"}?`}
        description="Their proposals are deleted too. This can't be undone."
        confirmLabel="Delete leads"
      />
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
