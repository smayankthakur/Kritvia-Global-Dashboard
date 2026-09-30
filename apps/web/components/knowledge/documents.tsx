"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Lock, NotebookPen, Upload } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { FileDrop } from "@/components/ui/file-drop";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, enumValues, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatBytes, formatRelative, titleCase } from "@/lib/format";

type UploadBody = Schemas["Body_upload_document_ventures__venture_id__documents_post"];
type DocKind = NonNullable<UploadBody["kind"]>;
const DOC_KINDS = enumValues<DocKind>()("upload", "note", "proposal", "report", "drive", "email");
export const ROLES = ["venture_admin", "operator", "approver", "viewer", "kitchen_manager", "loan_officer"] as const;

export function IngestSummary({ out }: { out: Schemas["IngestOut"] }) {
  return (
    <Notice tone={out.warnings.length ? "warning" : "success"} title={out.duplicate ? "Already in the knowledge base" : "Added to the knowledge base"}>
      {out.chunks} chunk(s), {out.entities} entit{out.entities === 1 ? "y" : "ies"}, {out.facts} fact(s)
      {out.pii_tags.length ? ` · PII: ${out.pii_tags.join(", ")}` : ""}
      {out.sensitive ? " · marked sensitive" : ""}
      {!out.embedded ? " · search index pending (embedding model unavailable)" : ""}
      {out.warnings.length ? (
        <ul className="mt-1 list-disc pl-4 text-xs">
          {out.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </Notice>
  );
}

export function UploadDocumentDialog({ open, onClose, ventureId }: { open: boolean; onClose: () => void; ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocKind>("upload");
  const [roles, setRoles] = useState<string[]>([]);
  const [sensitive, setSensitive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/documents", {
          params: { path: { venture_id: ventureId } },
          body: multipart<UploadBody>({
            file: files[0]!,
            title: title.trim() || null,
            kind,
            restricted_to: roles.length ? roles.join(",") : null,
            sensitive,
            extract: true,
          }),
        }),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["documents", ventureId] }),
  });
  const close = () => {
    setFiles([]);
    setTitle("");
    setRoles([]);
    setSensitive(false);
    setError(null);
    m.reset();
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!files.length) {
      setError("Choose a file");
      return;
    }
    setError(null);
    m.mutate(undefined, { onSuccess: () => toast.success("Document added") });
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Upload document"
      description="PDF, Word, text or images. Text is extracted, PII is detected and masked, and the content is encrypted per venture."
      size="lg"
      footer={
        m.data ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="doc-upload" loading={m.isPending} icon={<Upload className="h-4 w-4" />}>
              Upload
            </Button>
          </>
        )
      }
    >
      {m.data ? (
        <IngestSummary out={m.data} />
      ) : (
        <form id="doc-upload" onSubmit={submit} noValidate className="space-y-4">
          <FormError message={error ?? (m.isError ? errorMessage(m.error) : null)} />
          <FileDrop files={files} onChange={setFiles} label="Choose a document" hint="Up to 25 MB" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" hint="Defaults to the file name">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as DocKind)}>
                {DOC_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {titleCase(k)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Restrict to roles (optional)</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ROLES.map((r) => (
                <Checkbox
                  key={r}
                  label={titleCase(r)}
                  checked={roles.includes(r)}
                  onChange={(e) => setRoles((rs) => (e.target.checked ? [...rs, r] : rs.filter((x) => x !== r)))}
                />
              ))}
            </div>
            <p className="mt-1.5 text-xs text-subtle">Restricted documents are also treated as sensitive: only local models read them.</p>
          </fieldset>
          <Checkbox label="Sensitive" hint="Process only with local models; never sent to external providers" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
        </form>
      )}
    </Dialog>
  );
}

export function AddNoteDialog({ open, onClose, ventureId }: { open: boolean; onClose: () => void; ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<{ title: string; text: string; kind: "note" | "proposal" }>({ title: "", text: "", kind: "note" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/notes", { params: { path: { venture_id: ventureId } }, body: { title: f.title.trim(), text: f.text, kind: f.kind } })),
    onSuccess: () => {
      toast.success("Note added");
      void qc.invalidateQueries({ queryKey: ["documents", ventureId] });
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    },
  });
  const close = () => {
    setF({ title: "", text: "", kind: "note" });
    setErrors({});
    m.reset();
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.title.trim()) errs.title = "Give the note a title";
    if (!f.text.trim()) errs.text = "Write something";
    setErrors(errs);
    if (!Object.keys(errs).length) m.mutate();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add note"
      description="Notes become searchable knowledge — pricing decisions, SOPs, client context."
      size="lg"
      footer={
        m.data ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" type="submit" form="note-form" loading={m.isPending}>
              Add note
            </Button>
          </>
        )
      }
    >
      {m.data ? (
        <IngestSummary out={m.data} />
      ) : (
        <form id="note-form" onSubmit={submit} noValidate className="space-y-4">
          <FormError message={m.isError && !Object.keys(errors).length ? errorMessage(m.error) : null} />
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Title" error={errors.title} required>
              <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={300} />
            </Field>
            <Field label="Kind">
              <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "note" | "proposal" })}>
                <option value="note">Note</option>
                <option value="proposal">Past proposal</option>
              </Select>
            </Field>
          </div>
          <Field label="Text" error={errors.text} required hint="Markdown is fine">
            <Textarea rows={10} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} maxLength={200000} />
          </Field>
        </form>
      )}
    </Dialog>
  );
}

export function DocumentsTable({ ventureId, kind }: { ventureId: string; kind?: string }) {
  const q = useQuery({
    queryKey: ["documents", ventureId, kind ?? "all"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/documents", { params: { path: { venture_id: ventureId }, query: { kind, limit: 200 } } })),
    refetchInterval: (query) => (query.state.data?.some((d) => d.status === "pending" || d.status === "processing") ? 5000 : false),
  });
  return (
    <QueryState query={q} empty={<EmptyState icon={FileText} title="No documents yet" description="Upload files or add notes. Every answer cites these sources." />}>
      {(data) => (
        <Table label="Documents">
          <THead>
            <tr>
              <Th>Title</Th>
              <Th className="hidden sm:table-cell">Kind</Th>
              <Th>Status</Th>
              <Th className="hidden md:table-cell">PII</Th>
              <Th className="hidden text-right lg:table-cell">Facts</Th>
              <Th className="hidden text-right lg:table-cell">Size</Th>
              <Th className="hidden md:table-cell">Added</Th>
            </tr>
          </THead>
          <TBody>
            {data.map((d) => (
              <Tr key={d.id}>
                <Td className="max-w-[18rem]">
                  <Link href={`/v/${ventureId}/knowledge/${d.id}`} className="flex items-center gap-1.5 font-medium hover:text-accent">
                    {d.sensitive ? <Lock className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="sensitive" /> : null}
                    <span className="truncate">{d.title}</span>
                  </Link>
                  {d.access_roles?.length ? <span className="block truncate text-xs text-subtle">only {d.access_roles.join(", ")}</span> : null}
                </Td>
                <Td className="hidden sm:table-cell">
                  <Badge>{d.kind}</Badge>
                </Td>
                <Td>
                  <StatusBadge status={d.status} />
                </Td>
                <Td className="hidden md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {d.pii_tags.slice(0, 3).map((t) => (
                      <Badge key={t} tone="warning">
                        {t}
                      </Badge>
                    ))}
                    {!d.pii_tags.length ? <span className="text-subtle">—</span> : null}
                  </div>
                </Td>
                <Td className="hidden text-right tabular-nums lg:table-cell">{d.facts ?? 0}</Td>
                <Td className="hidden text-right whitespace-nowrap text-muted lg:table-cell">{formatBytes(d.size_bytes)}</Td>
                <Td className="hidden whitespace-nowrap text-muted md:table-cell">{formatRelative(d.created_at)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </QueryState>
  );
}

export function NoteButton({ onClick }: { onClick: () => void }) {
  return (
    <Button icon={<NotebookPen className="h-4 w-4" />} onClick={onClick}>
      Add note
    </Button>
  );
}
