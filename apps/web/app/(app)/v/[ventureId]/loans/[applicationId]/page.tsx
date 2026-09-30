"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, CircleDashed, Clock, Link2, RefreshCw, Upload, XCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { LoanOfficerNotice } from "@/components/loans/loan-officer-notice";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Checkbox, Select } from "@/components/ui/field";
import { FileDrop } from "@/components/ui/file-drop";
import { KeyValue, Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDate, formatDateTime, formatINR, formatRelative, titleCase } from "@/lib/format";
import { useVenture } from "@/lib/venture";

interface ChecklistResult {
  present?: Record<string, number>;
  missing?: { doc_type: string; label: string; have: number; need: number }[];
  stale?: { doc_type: string; label: string; document: string; age_days: number }[];
  mismatches?: { rule: string; field: string; documents: string[]; severity: string; detail?: string }[];
  passed?: string[];
  checked_at?: string;
}

function ChecklistView({ result, docTitles }: { result: ChecklistResult; docTitles: Map<string, string> }) {
  if (!result.checked_at) {
    return <EmptyState icon={CircleDashed} title="Not checked yet" description="Upload documents and run verification to see what is missing." />;
  }
  const rows: { icon: React.ReactNode; title: React.ReactNode; detail?: React.ReactNode; tone: string }[] = [];
  for (const [doc, n] of Object.entries(result.present ?? {})) {
    rows.push({ icon: <CheckCircle2 className="h-4 w-4 text-success" />, title: titleCase(doc), detail: `${n} document(s) received`, tone: "present" });
  }
  for (const m of result.missing ?? []) {
    rows.push({ icon: <XCircle className="h-4 w-4 text-danger" />, title: m.label, detail: `Missing — have ${m.have} of ${m.need}`, tone: "missing" });
  }
  for (const s of result.stale ?? []) {
    rows.push({
      icon: <Clock className="h-4 w-4 text-warning" />,
      title: s.label,
      detail: `Too old (${s.age_days} days) — ${docTitles.get(s.document) ?? "document"}`,
      tone: "stale",
    });
  }
  for (const m of result.mismatches ?? []) {
    rows.push({
      icon: <CircleAlert className="h-4 w-4 text-danger" />,
      title: (
        <span className="flex items-center gap-2">
          {titleCase(m.rule)} <StatusBadge status={m.severity} />
        </span>
      ),
      detail: m.detail ?? `${titleCase(m.field)} differs across: ${m.documents.map((d) => docTitles.get(d) ?? "document").join(", ") || "documents"}`,
      tone: "mismatch",
    });
  }
  for (const p of result.passed ?? []) {
    rows.push({ icon: <CheckCircle2 className="h-4 w-4 text-success" />, title: titleCase(p), detail: "Rule passed", tone: "passed" });
  }
  const counts = { missing: result.missing?.length ?? 0, stale: result.stale?.length ?? 0, mismatches: result.mismatches?.length ?? 0 };
  return (
    <div>
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
        <Badge tone={counts.missing ? "danger" : "success"}>{counts.missing} missing</Badge>
        <Badge tone={counts.stale ? "warning" : "success"}>{counts.stale} stale</Badge>
        <Badge tone={counts.mismatches ? "danger" : "success"}>{counts.mismatches} mismatches</Badge>
        <span className="ml-auto text-xs text-subtle">checked {formatDate(result.checked_at)}</span>
      </div>
      <ul className="divide-y divide-border" aria-label="Checklist">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-3 px-4 py-2.5">
            <span className="mt-0.5" aria-hidden>
              {r.icon}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                <span className="sr-only">{r.tone}: </span>
                {r.title}
              </p>
              {r.detail ? <p className="text-xs text-subtle">{r.detail}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UploadCard({ ventureId, applicationId }: { ventureId: string; applicationId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [verify, setVerify] = useState(true);
  const [result, setResult] = useState<Schemas["UploadResultOut"] | null>(null);
  const up = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/loan-applications/{application_id}/documents", {
          params: { path: { venture_id: ventureId, application_id: applicationId }, query: { verify } },
          body: multipart<Schemas["Body_upload_loan_documents_ventures__venture_id__loan_applications__application_id__documents_post"]>({ files }),
        }),
      ),
    onSuccess: (out) => {
      setResult(out);
      setFiles([]);
      toast.success(`${out.uploaded} document(s) uploaded`, out.run_id ? "Verification started." : undefined);
      void qc.invalidateQueries({ queryKey: ["loans", ventureId] });
    },
    onError: (e) => toast.error("Upload failed", errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader title="Upload documents" description="PDF or images. Text is extracted locally and PII is masked." />
      <div className="space-y-3 p-4">
        <FileDrop files={files} onChange={setFiles} multiple maxFiles={20} accept=".pdf,.jpg,.jpeg,.png,.webp,.txt" hint="Up to 20 files, 25 MB each" />
        <Checkbox label="Verify after upload" hint="Runs the checklist with the new documents" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
        <Button variant="primary" icon={<Upload className="h-4 w-4" />} disabled={!files.length} loading={up.isPending} onClick={() => up.mutate()}>
          Upload {files.length ? `${files.length} file(s)` : ""}
        </Button>
        {result?.warnings.length ? (
          <Notice tone="warning" title="Some files need attention">
            <ul className="list-disc pl-4">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {result?.run_id ? (
          <Link href={`/v/${ventureId}/runs/${result.run_id}`} className="block text-sm text-accent hover:underline">
            Follow the verification run →
          </Link>
        ) : null}
      </div>
    </Card>
  );
}

function UploadLinkCard({ ventureId, applicationId, expires }: { ventureId: string; applicationId: string; expires: string | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const link = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/loan-applications/{application_id}/upload-link", {
          params: { path: { venture_id: ventureId, application_id: applicationId }, query: { days } },
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["loans", ventureId, "detail", applicationId] }),
    onError: (e) => toast.error("Could not create link", errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader title="Client upload link" description="A single-application, expiring link the applicant can use without an account." />
      <div className="space-y-3 p-4">
        {link.data ? (
          <>
            <CopyField label="Share this link with the applicant" value={link.data.url} />
            <p className="text-xs text-subtle">Expires {formatDateTime(link.data.expires_at)}. Creating a new link revokes this one.</p>
          </>
        ) : expires ? (
          <p className="text-sm text-muted">
            A link is active until {formatDateTime(expires)}. For security the URL is shown only once — create a new one to share again.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-32">
            <label htmlFor="link-days" className="mb-1 block text-xs font-medium text-subtle">
              Valid for
            </label>
            <Select id="link-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} day{d > 1 ? "s" : ""}
                </option>
              ))}
            </Select>
          </div>
          <Button icon={<Link2 className="h-4 w-4" />} loading={link.isPending} onClick={() => link.mutate()}>
            {expires || link.data ? "Create new link" : "Create link"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function LoanApplicationPage() {
  const v = useVenture();
  const { applicationId } = useParams<{ applicationId: string }>();
  const toast = useToast();
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["loans", v.id, "detail", applicationId],
    queryFn: () =>
      unwrap(api.GET("/ventures/{venture_id}/loan-applications/{application_id}", { params: { path: { venture_id: v.id, application_id: applicationId } } })),
    refetchInterval: (query) => (query.state.data?.status === "verifying" ? 4000 : false),
  });
  const verify = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/loan-applications/{application_id}/verify", { params: { path: { venture_id: v.id, application_id: applicationId } } })),
    onSuccess: (out) => {
      toast.success("Verification started");
      void qc.invalidateQueries({ queryKey: ["loans", v.id] });
      setRunId(out.run_id);
    },
    onError: (e) => toast.error("Could not start verification", errorMessage(e)),
  });

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError)
    return (
      <>
        <LoanOfficerNotice ventureId={v.id} roles={v.roles} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  const a = q.data;
  const docs = a.documents ?? [];
  const docTitles = new Map(docs.map((d) => [d.document_id, d.title]));
  const lastRun = runId ?? a.last_run_id;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/v/${v.id}/loans`} className="hover:text-accent">
            ← Loan applications
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{a.reference}</span>
            <StatusBadge status={a.status} />
          </span>
        }
        description={`${a.applicant.name} · ${titleCase(a.loan_type)} · ${formatINR(a.amount_inr)}`}
        actions={
          <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} loading={verify.isPending} onClick={() => verify.mutate()} disabled={!a.consent_active}>
            Verify now
          </Button>
        }
      />
      {!a.consent_active ? (
        <Notice tone="danger" title="No active consent" className="mb-4">
          Consent for loan processing has been withdrawn or is missing. Documents won&apos;t be processed until new consent is recorded.
        </Notice>
      ) : null}
      {lastRun ? (
        <p className="mb-4 text-sm">
          <Link href={`/v/${v.id}/runs/${lastRun}`} className="text-accent hover:underline">
            Latest verification run →
          </Link>
        </p>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Checklist" description="Against the active checklist for this loan type" />
            <ChecklistView result={a.checklist_result as ChecklistResult} docTitles={docTitles} />
          </Card>
          <Card>
            <CardHeader title="Documents" description={`${docs.length} received`} />
            {docs.length ? (
              <Table label="Documents">
                <THead>
                  <tr>
                    <Th>Document</Th>
                    <Th>Type</Th>
                    <Th className="hidden sm:table-cell text-right">Confidence</Th>
                    <Th>Status</Th>
                    <Th className="hidden md:table-cell">Issues</Th>
                    <Th className="hidden lg:table-cell">PII</Th>
                  </tr>
                </THead>
                <TBody>
                  {docs.map((d) => (
                    <Tr key={d.id}>
                      <Td className="max-w-[14rem]">
                        <Link href={`/v/${v.id}/knowledge/${d.document_id}`} className="block truncate font-medium hover:text-accent">
                          {d.title}
                        </Link>
                        <span className="text-xs text-subtle">{formatRelative(d.created_at)}</span>
                      </Td>
                      <Td className="text-muted">{d.doc_type ? titleCase(d.doc_type) : "—"}</Td>
                      <Td className="hidden text-right tabular-nums sm:table-cell">{d.confidence === null ? "—" : `${Math.round(d.confidence * 100)}%`}</Td>
                      <Td>
                        <StatusBadge status={d.status} />
                      </Td>
                      <Td className="hidden md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {(d.issues as { code?: string; severity?: string }[]).map((i, n) => (
                            <Badge key={n} tone={i.severity === "high" ? "danger" : "warning"}>
                              {titleCase(i.code)}
                            </Badge>
                          ))}
                          {!d.issues.length ? <span className="text-subtle">—</span> : null}
                        </div>
                      </Td>
                      <Td className="hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {d.pii_tags.map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                          {!d.pii_tags.length ? <span className="text-subtle">—</span> : null}
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <EmptyState title="No documents yet" description="Upload them here or send the applicant a secure upload link." />
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <UploadCard ventureId={v.id} applicationId={a.id} />
          <UploadLinkCard ventureId={v.id} applicationId={a.id} expires={a.upload_link_expires} />
          <Card>
            <CardHeader title="Applicant" />
            <div className="p-4">
              <KeyValue
                items={[
                  ["Name", a.applicant.name],
                  ["Email", a.applicant.email ?? "—"],
                  ["Phone", a.applicant.phone ?? "—"],
                  ["PAN", a.applicant.pan ? <span className="font-mono">{a.applicant.pan}</span> : "—"],
                  ["Date of birth", a.applicant.dob ? formatDate(a.applicant.dob) : "—"],
                  ["Consent", a.consent_active ? <Badge tone="success">active</Badge> : <Badge tone="danger">not active</Badge>],
                  ["Created", formatDateTime(a.created_at)],
                ]}
              />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
