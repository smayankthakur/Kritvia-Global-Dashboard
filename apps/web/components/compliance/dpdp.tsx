"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSearch, Play } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, saveBlob, unwrap, type Schemas } from "@/lib/api";
import { formatDate, formatDateTime, titleCase } from "@/lib/format";

type Kind = Schemas["DPDPIn"]["kind"];
type PatchStatus = Schemas["DPDPPatch"]["status"];
const KINDS = enumValues<Kind>()("access", "correction", "erasure", "grievance", "nomination");
const PATCH_STATUSES = enumValues<PatchStatus>()("verifying", "in_progress", "completed", "rejected");
type Req = Schemas["DPDPOut"];

function UpdateDialog({ req, ventureId, onClose }: { req: Req | null; ventureId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<PatchStatus>("in_progress");
  const [resolution, setResolution] = useState("");
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH("/ventures/{venture_id}/dpdp-requests/{request_id}", {
          params: { path: { venture_id: ventureId, request_id: req!.id } },
          body: { status, resolution: resolution.trim() || null },
        }),
      ),
    onSuccess: () => {
      toast.success("Request updated");
      void qc.invalidateQueries({ queryKey: ["dpdp", ventureId] });
      onClose();
    },
  });
  return (
    <Dialog
      open={Boolean(req)}
      onClose={onClose}
      title="Update request"
      description={req ? `${titleCase(req.kind)} request from ${req.principal_label}` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={m.isError ? errorMessage(m.error) : null} />
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as PatchStatus)}>
            {PATCH_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Resolution / note" hint="Recorded with the request; completed and rejected close it">
          <Textarea rows={3} value={resolution} maxLength={5000} onChange={(e) => setResolution(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export function DpdpRequests({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["dpdp", ventureId], queryFn: () => unwrap(api.GET("/ventures/{venture_id}/dpdp-requests", { params: { path: { venture_id: ventureId } } })) });
  const [f, setF] = useState({ identifier: "", kind: "access" as Kind, details: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [updating, setUpdating] = useState<Req | null>(null);
  const [erase, setErase] = useState<Req | null>(null);
  const [exportData, setExportData] = useState<{ req: Req; data: Record<string, unknown> } | null>(null);

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/dpdp-requests", { params: { path: { venture_id: ventureId } }, body: { ...f, identifier: f.identifier.trim() } })),
    onSuccess: (r) => {
      toast.success("Request logged", `Due ${formatDate(r.due_at)}`);
      setF({ identifier: "", kind: "access", details: "" });
      // show it at once, even if a list fetch that started before the insert lands afterwards
      qc.setQueryData<Req[]>(["dpdp", ventureId], (old) => [r, ...(old ?? []).filter((x) => x.id !== r.id)]);
      void qc.invalidateQueries({ queryKey: ["dpdp", ventureId] });
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });
  const exec = useMutation({
    mutationFn: (req: Req) => unwrap(api.POST("/ventures/{venture_id}/dpdp-requests/{request_id}/execute", { params: { path: { venture_id: ventureId, request_id: req.id } } })),
    onSuccess: (out, req) => {
      void qc.invalidateQueries({ queryKey: ["dpdp", ventureId] });
      setErase(null);
      if (req.kind === "access" && out.export) setExportData({ req, data: out.export });
      else toast.success("Erasure completed", Object.entries(out.request.result).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", "));
    },
    onError: (e) => toast.error("Could not execute", errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (f.identifier.trim().length < 3) errs.identifier = "Email, phone or PAN";
    setErrors(errs);
    if (!Object.keys(errs).length) create.mutate();
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader title="Data principal requests" description="DPDP Act rights: access, correction, erasure, grievance, nomination" />
        {!canAdmin ? (
          <Notice tone="info" className="m-3">
            Only a venture admin or owner can update or execute requests.
          </Notice>
        ) : null}
        <QueryState query={q} empty={<EmptyState icon={FileSearch} title="No requests" description="Log requests as they arrive — the statutory due date is tracked for you." />}>
          {(data) => (
            <ul className="divide-y divide-border">
              {data.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">{r.kind}</Badge>
                      <span className="font-mono text-[13px]">{r.principal_label}</span>
                      <StatusBadge status={r.status} />
                      {r.overdue ? <Badge tone="danger">overdue</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-subtle">
                      Received {formatDateTime(r.created_at)} · due {formatDate(r.due_at)}
                      {r.closed_at ? ` · closed ${formatDate(r.closed_at)}` : ""}
                    </p>
                    {r.resolution ? <p className="mt-1 text-sm text-muted">{r.resolution}</p> : null}
                    {Object.keys(r.result ?? {}).length ? (
                      <p className="mt-1 text-xs text-muted">
                        Result: {Object.entries(r.result).map(([k, n]) => `${String(n)} ${k.replace(/_/g, " ")}`).join(", ")}
                      </p>
                    ) : null}
                  </div>
                  {canAdmin && !r.closed_at ? (
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button size="sm" onClick={() => setUpdating(r)}>
                        Update
                      </Button>
                      {r.kind === "access" ? (
                        <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={exec.isPending && exec.variables?.id === r.id} onClick={() => exec.mutate(r)}>
                          Execute export
                        </Button>
                      ) : null}
                      {r.kind === "erasure" ? (
                        <Button size="sm" variant="danger" onClick={() => setErase(r)}>
                          Execute erasure
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Log a request" />
        <form onSubmit={submit} noValidate className="space-y-3 p-4">
          <FormError message={create.isError && !Object.keys(errors).length ? errorMessage(create.error) : null} />
          <Field label="Email, phone or PAN" error={errors.identifier} required>
            <Input value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Request type">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Details" error={errors.details}>
            <Textarea rows={3} value={f.details} maxLength={5000} onChange={(e) => setF({ ...f, details: e.target.value })} />
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending} className="w-full">
            Log request
          </Button>
        </form>
      </Card>
      <UpdateDialog req={updating} ventureId={ventureId} onClose={() => setUpdating(null)} />
      <ConfirmDialog
        open={Boolean(erase)}
        onClose={() => setErase(null)}
        onConfirm={() => erase && exec.mutate(erase)}
        loading={exec.isPending}
        title="Erase this person's data?"
        description={
          erase
            ? `Deletes every document, loan application and lead held about ${erase.principal_label} in this venture — including restricted loan files. Consent records are kept (withdrawn) as evidence. This cannot be undone.`
            : undefined
        }
        confirmLabel="Erase permanently"
        typeToConfirm="ERASE"
      />
      <Dialog
        open={Boolean(exportData)}
        onClose={() => setExportData(null)}
        size="lg"
        title="Access export"
        description={exportData ? `Everything held about ${exportData.req.principal_label}. Share it with the data principal securely.` : undefined}
        footer={
          <>
            <Button onClick={() => setExportData(null)}>Close</Button>
            <Button
              variant="primary"
              icon={<Download className="h-4 w-4" />}
              onClick={() =>
                exportData &&
                saveBlob(new Blob([JSON.stringify(exportData.data, null, 2)], { type: "application/json" }), `dpdp-access-${exportData.req.id.slice(0, 8)}.json`)
              }
            >
              Download JSON
            </Button>
          </>
        }
      >
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs">{exportData ? JSON.stringify(exportData.data, null, 2) : ""}</pre>
      </Dialog>
    </div>
  );
}
