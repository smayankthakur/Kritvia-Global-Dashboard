"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Job = Schemas["JobOut"];
type Candidate = Schemas["CandidateOut"];

const VERDICT: Record<NonNullable<Candidate["verdict"]>, { label: string; tone: Tone }> = {
  shortlist: { label: "shortlist", tone: "success" },
  maybe: { label: "maybe", tone: "warning" },
  reject: { label: "not a fit", tone: "neutral" },
};

function NewJob({ ventureId, onClose }: { ventureId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: "", location: "", description: "", must_have: "", nice_to_have: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/jobs", { params: { path: { venture_id: ventureId } }, body: { ...f, location: f.location || null } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["jobs", ventureId] });
      onClose();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New role"
      description="Kritvia scores every CV against what you write here. Be specific about the must-haves."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={f.title.trim().length < 2} onClick={() => save.mutate()}>
            Open the role
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Role" required>
          <Input value={f.title} onChange={set("title")} maxLength={120} placeholder="e.g. Sales Executive" />
        </Field>
        <Field label="Where">
          <Input value={f.location} onChange={set("location")} maxLength={120} placeholder="e.g. Paschim Vihar, Delhi" />
        </Field>
        <Field label="About the role" className="sm:col-span-2">
          <Textarea rows={3} value={f.description} onChange={set("description")} maxLength={4000} />
        </Field>
        <Field label="Must have" hint="e.g. 2+ years field sales; Hindi; own two-wheeler">
          <Textarea rows={3} value={f.must_have} onChange={set("must_have")} maxLength={2000} />
        </Field>
        <Field label="Nice to have">
          <Textarea rows={3} value={f.nice_to_have} onChange={set("nice_to_have")} maxLength={2000} />
        </Field>
      </div>
      <FormError message={err} />
    </Dialog>
  );
}

function Candidates({ ventureId, job, canWrite }: { ventureId: string; job: Job; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const key = ["candidates", ventureId, job.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/jobs/{job_id}/candidates", { params: { path: { venture_id: ventureId, job_id: job.id } } })),
    refetchInterval: (query) => ((query.state.data ?? []).some((c) => c.status === "new") ? 5000 : false),
  });
  const upload = useMutation({
    mutationFn: (file: File) =>
      unwrap(
        api.POST("/ventures/{venture_id}/jobs/{job_id}/candidates", {
          params: { path: { venture_id: ventureId, job_id: job.id } },
          body: multipart<Schemas["Body_upload_cv_ventures__venture_id__jobs__job_id__candidates_post"]>({ file, name: null, email: null }),
        }),
      ),
    onSuccess: () => {
      toast.success("CV added", "Kritvia is reading it against the role.");
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ["jobs", ventureId] });
    },
    onError: (e) => toast.error("Couldn't add the CV", errorMessage(e)),
  });
  const decide = useMutation({
    mutationFn: ({ c, status }: { c: Candidate; status: "shortlisted" | "rejected" | "hired" }) =>
      unwrap(api.PATCH("/ventures/{venture_id}/candidates/{candidate_id}", { params: { path: { venture_id: ventureId, candidate_id: c.id } }, body: { status } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  return (
    <div className="space-y-3">
      {canWrite && job.status === "open" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="sr-only"
            aria-label="CV file"
            onChange={(e) => {
              for (const f of Array.from(e.target.files ?? [])) upload.mutate(f);
              e.target.value = "";
            }}
            multiple
          />
          <Button size="sm" loading={upload.isPending} onClick={() => fileRef.current?.click()} icon={<FileUp className="h-4 w-4" />}>
            Add CVs (PDF or Word)
          </Button>
        </div>
      ) : null}
      <QueryState query={q} loading={<SkeletonRows rows={3} />}>
        {(d: Candidate[]) =>
          d.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border" aria-label={`Candidates for ${job.title}`}>
              {d.map((c) => (
                <li key={c.id} className="space-y-1 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.score != null ? <span className="text-sm tabular-nums text-muted">{c.score}/100</span> : <Badge tone="info">reading…</Badge>}
                    {c.verdict ? <Badge tone={VERDICT[c.verdict].tone}>{VERDICT[c.verdict].label}</Badge> : null}
                    <Badge tone="neutral">{c.status}</Badge>
                    <span className="text-xs text-subtle">
                      {c.email ?? ""} · {c.source === "email" ? "emailed" : "uploaded"} {formatDate(c.created_at)}
                    </span>
                  </div>
                  {c.reasons ? <p className="text-sm whitespace-pre-line text-muted">{c.reasons}</p> : null}
                  {canWrite ? (
                    <div className="flex flex-wrap gap-1">
                      {c.status !== "shortlisted" && c.status !== "invited" ? (
                        <Button size="sm" variant="ghost" onClick={() => decide.mutate({ c, status: "shortlisted" })}>
                          Shortlist
                        </Button>
                      ) : null}
                      {c.status !== "rejected" ? (
                        <Button size="sm" variant="ghost" onClick={() => decide.mutate({ c, status: "rejected" })}>
                          Not a fit
                        </Button>
                      ) : null}
                      {c.status === "invited" || c.status === "shortlisted" ? (
                        <Button size="sm" variant="ghost" onClick={() => decide.mutate({ c, status: "hired" })}>
                          Hired
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-subtle">No applications yet.</p>
          )
        }
      </QueryState>
    </div>
  );
}

/** Open roles and the people who applied: every CV scored against the role, invites after a yes. */
export function HiringTab({ ventureId, canWrite, canAdmin }: { ventureId: string; canWrite: boolean; canAdmin: boolean }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const jobs = useQuery({ queryKey: ["jobs", ventureId], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/jobs", { params: { path: { venture_id: ventureId } } })) });
  const close = useMutation({
    mutationFn: (j: Job) =>
      unwrap(api.PATCH("/ventures/{venture_id}/jobs/{job_id}", { params: { path: { venture_id: ventureId, job_id: j.id } }, body: { status: j.status === "open" ? "closed" : "open" } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["jobs", ventureId] }),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Kritvia judges skills and experience only, explains every score, and never rejects anyone by itself.</p>
        {canAdmin ? (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New role
          </Button>
        ) : null}
      </div>
      <QueryState query={jobs} loading={<SkeletonRows rows={3} />}>
        {(d: Job[]) =>
          d.length ? (
            <div className="space-y-3">
              {d.map((j) => (
                <Card key={j.id}>
                  <CardHeader
                    title={
                      <button type="button" className="text-left hover:underline" onClick={() => setOpenId(openId === j.id ? null : j.id)} aria-expanded={openId === j.id}>
                        {j.title} {j.location ? <span className="text-sm font-normal text-subtle">· {j.location}</span> : null}
                      </button>
                    }
                    description={`${j.candidates} applied, ${j.shortlisted} shortlisted · code ${j.code}`}
                    actions={
                      <span className="flex items-center gap-2">
                        <Badge tone={j.status === "open" ? "success" : "neutral"}>{j.status}</Badge>
                        {canAdmin ? (
                          <Button size="sm" variant="ghost" onClick={() => close.mutate(j)}>
                            {j.status === "open" ? "Close" : "Reopen"}
                          </Button>
                        ) : null}
                      </span>
                    }
                  />
                  {openId === j.id ? (
                    <CardBody className="space-y-3">
                      {j.apply_by_email && j.status === "open" ? (
                        <Notice tone="info" title="CVs by email">
                          Ask people to email their CV to this address with <strong className="font-mono">{j.code}</strong> in the subject:
                          <CopyField className="mt-2" label="Apply to" value={j.apply_by_email} />
                        </Notice>
                      ) : null}
                      <Candidates ventureId={ventureId} job={j} canWrite={canWrite} />
                    </CardBody>
                  ) : null}
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState title="No roles yet" description="Open a role; add CVs or have people email them in with the role's code." />
          )
        }
      </QueryState>
      {creating ? <NewJob ventureId={ventureId} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
