"use client";

import { CalendarClock, Check, Lock, Mail, Pencil, ShieldAlert, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { workflowLabel } from "@/components/runs/run-actions";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeDiff, ValueDiff } from "@/components/ui/code-diff";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/field";
import { RichText } from "@/components/ui/markdown";
import { KeyValue, Notice } from "@/components/ui/page";
import { ApiError, errorMessage, type Schemas } from "@/lib/api";
import { buildEditedPayload, diffPayload, displayValue, parseUnified, type Payload, type PayloadFieldDiff } from "@/lib/diff";
import { formatDateTime, formatRelative, fromISTInput, titleCase, toISTInput } from "@/lib/format";

export type Approval = Schemas["ApprovalOut"];
export type Decision = Schemas["DecisionIn"];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

type FieldKind = "text" | "textarea" | "datetime" | "list" | "number" | "boolean" | "readonly";

export function fieldKind(key: string, value: unknown): FieldKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return value.every((v) => typeof v === "string") ? "list" : "readonly";
  if (typeof value === "string") {
    if (ISO_RE.test(value) && !Number.isNaN(Date.parse(value))) return "datetime";
    if (key === "body" || key === "description" || value.includes("\n") || value.length > 120) return "textarea";
    return "text";
  }
  return "readonly";
}

/** Form value (string/boolean) for a payload field. */
function toFormValue(kind: FieldKind, v: unknown): string | boolean {
  if (kind === "boolean") return Boolean(v);
  if (kind === "datetime") return toISTInput(v as string);
  if (kind === "list") return (v as string[]).join(", ");
  if (kind === "number") return String(v);
  return typeof v === "string" ? v : displayValue(v);
}

/** Convert edited form values back to payload values (only for fields the user touched). */
export function formToPayload(original: Payload, form: Record<string, string | boolean>, dirty: Set<string>): Payload {
  const edits: Payload = {};
  for (const key of dirty) {
    if (!(key in original)) continue;
    const kind = fieldKind(key, original[key]);
    const v = form[key];
    if (kind === "readonly" || v === undefined) continue;
    edits[key] = kind === "datetime" && typeof v === "string" ? fromISTInput(v) : v;
  }
  return buildEditedPayload(original, edits);
}

const LABELS: Record<string, string> = { to: "To", subject: "Subject", body: "Body", start: "Starts", end: "Ends", summary: "Title", attendees: "Attendees", description: "Description" };
const label = (k: string) => LABELS[k] ?? titleCase(k);

function PayloadView({ action, payload }: { action: string; payload: Payload }) {
  if (action === "gmail.send") {
    return (
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="space-y-1.5 border-b border-border bg-surface-2/60 px-4 py-3 text-sm">
          <div className="flex gap-2">
            <span className="w-16 shrink-0 text-subtle">To</span>
            <span className="min-w-0 font-medium break-all">{displayValue(payload.to) || "—"}</span>
          </div>
          <div className="flex gap-2">
            <span className="w-16 shrink-0 text-subtle">Subject</span>
            <span className="min-w-0 font-medium">{displayValue(payload.subject) || "—"}</span>
          </div>
        </div>
        <div className="max-h-[28rem] overflow-y-auto px-4 py-4">
          <RichText text={displayValue(payload.body)} />
        </div>
      </div>
    );
  }
  if (action === "calendar.create_event") {
    const attendees = Array.isArray(payload.attendees) ? (payload.attendees as unknown[]).map(String) : [];
    return (
      <div className="rounded-lg border border-border p-4">
        <p className="text-base font-semibold">{displayValue(payload.summary)}</p>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
          <CalendarClock className="h-4 w-4" aria-hidden />
          {formatDateTime(payload.start as string)} → {formatDateTime(payload.end as string)}
        </p>
        {attendees.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {attendees.map((a) => (
              <Badge key={a}>{a}</Badge>
            ))}
          </div>
        ) : null}
        {payload.description ? <p className="mt-3 text-sm whitespace-pre-wrap text-muted">{displayValue(payload.description)}</p> : null}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border p-4">
      <KeyValue items={Object.entries(payload).map(([k, v]) => [label(k), <span key={k} className="whitespace-pre-wrap">{displayValue(v) || "—"}</span>])} />
    </div>
  );
}

function DiffList({ diffs }: { diffs: PayloadFieldDiff[] }) {
  return (
    <div className="space-y-3">
      {diffs.map((d) => (
        <div key={d.field}>
          <p className="mb-1 text-xs font-medium text-subtle">{label(d.field)}</p>
          {d.lines ? <CodeDiff lines={d.lines} label={`Changes to ${label(d.field)}`} /> : <ValueDiff before={displayValue(d.before)} after={displayValue(d.after)} />}
        </div>
      ))}
    </div>
  );
}

function ServerDiff({ diff }: { diff: Schemas["FieldDiff"][] }) {
  return (
    <div className="space-y-3">
      {diff.map((d) => (
        <div key={d.field}>
          <p className="mb-1 text-xs font-medium text-subtle">{label(d.field)}</p>
          {d.unified ? (
            <CodeDiff lines={parseUnified(d.unified)} label={`Changes to ${label(d.field)}`} />
          ) : (
            <ValueDiff before={displayValue(d.before)} after={displayValue(d.after)} />
          )}
        </div>
      ))}
    </div>
  );
}

export function ApprovalDetail({
  approval,
  onDecide,
  onConflict,
}: {
  approval: Approval;
  onDecide: (body: Decision) => Promise<Approval>;
  onConflict?: () => void;
}) {
  const original = useMemo<Payload>(() => (approval.payload ?? {}) as Payload, [approval.payload]);
  const editable = useMemo(() => Object.keys(original).filter((k) => fieldKind(k, original[k]) !== "readonly"), [original]);
  const [mode, setMode] = useState<"view" | "edit" | "review">("view");
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [rejectOpen, setRejectOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Approval | null>(approval.status !== "pending" ? approval : null);

  const edited = useMemo(() => formToPayload(original, form, dirty), [original, form, dirty]);
  const preview = useMemo(() => diffPayload(original, edited), [original, edited]);
  const disabled = !approval.can_decide || Boolean(result);

  const startEdit = () => {
    const f: Record<string, string | boolean> = {};
    for (const k of editable) f[k] = toFormValue(fieldKind(k, original[k]), original[k]);
    setForm(f);
    setDirty(new Set());
    setMode("edit");
  };

  const setField = (k: string, v: string | boolean) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty((d) => new Set(d).add(k));
  };

  const decide = async (body: Decision) => {
    setBusy(body.decision);
    setError(null);
    try {
      const out = await onDecide(body);
      setResult(out);
      setRejectOpen(false);
      setMode("view");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError(`Already decided: ${e.detail}. Refreshing the inbox.`);
        onConflict?.();
      } else setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const validateEdits = (): string | null => {
    if ("to" in original && typeof edited.to === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(edited.to)) return "Recipient must be an email address";
    for (const k of editable) {
      if (fieldKind(k, original[k]) === "datetime" && dirty.has(k) && !form[k]) return `${label(k)} is required`;
    }
    if (typeof edited.start === "string" && typeof edited.end === "string" && Date.parse(edited.end) <= Date.parse(edited.start)) return "End must be after start";
    return null;
  };

  const Icon = approval.action === "gmail.send" ? Mail : approval.action.startsWith("calendar") ? CalendarClock : Pencil;

  return (
    <article className="space-y-5" aria-labelledby={`approval-${approval.id}`}>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">
            <Icon className="h-3 w-3" aria-hidden /> {approval.action}
          </Badge>
          {approval.sensitive ? (
            <Badge tone="danger" title="Sensitive: decided only by the required role; processed by local models">
              <Lock className="h-3 w-3" aria-hidden /> Sensitive
            </Badge>
          ) : null}
          <StatusBadge status={result?.status ?? approval.status} />
        </div>
        <h2 id={`approval-${approval.id}`} className="text-lg font-semibold tracking-tight">
          {approval.title}
        </h2>
        {approval.summary ? <p className="text-sm text-muted">{approval.summary}</p> : null}
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-subtle">
          <div>
            <dt className="inline">Venture </dt>
            <dd className="inline font-medium text-muted">{approval.venture_name}</dd>
          </div>
          <div>
            <dt className="inline">Workflow </dt>
            <dd className="inline font-medium text-muted">
              <Link className="hover:text-accent hover:underline" href={`/v/${approval.venture_id}/runs/${approval.run_id}`}>
                {workflowLabel(approval.workflow)}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="inline">Agent </dt>
            <dd className="inline font-medium text-muted">{approval.agent}</dd>
          </div>
          <div>
            <dt className="inline">Drafted </dt>
            <dd className="inline font-medium text-muted">{formatRelative(approval.created_at)}</dd>
          </div>
          {approval.expires_at ? (
            <div>
              <dt className="inline">Expires </dt>
              <dd className="inline font-medium text-muted" title={formatDateTime(approval.expires_at)}>
                {formatRelative(approval.expires_at)}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="inline">Needs role </dt>
            <dd className="inline font-medium text-muted">{approval.required_roles.join(" or ")}</dd>
          </div>
        </dl>
      </header>

      {!approval.can_decide && !result ? (
        <Notice tone="warning" title="You can view this draft but not decide it">
          Deciding needs the {approval.required_roles.map((r) => r.replace(/_/g, " ")).join(" or ")} role in {approval.venture_name}
          {approval.sensitive ? ". Sensitive drafts can't be decided by owners without that role" : ""}. Ask an owner to add the role under
          Settings → Members.
        </Notice>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {result ? (
        <section className="space-y-3" aria-live="polite">
          <Notice tone={result.status === "rejected" ? "warning" : "success"} title={`Decision recorded: ${result.status}`}>
            {result.decided_by_email ? `By ${result.decided_by_email}` : null}
            {result.decided_at ? ` · ${formatDateTime(result.decided_at)}` : null}
            {result.comment ? <span className="mt-1 block">“{result.comment}”</span> : null}
            {result.status === "rejected" ? <span className="mt-1 block">The agent will use your feedback to redraft.</span> : null}
          </Notice>
          {result.diff?.length ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold">What you changed</h3>
              <ServerDiff diff={result.diff} />
            </div>
          ) : null}
          <PayloadView action={approval.action} payload={(result.final_payload ?? result.payload ?? original) as Payload} />
        </section>
      ) : mode === "view" ? (
        <PayloadView action={approval.action} payload={original} />
      ) : mode === "edit" ? (
        <form
          noValidate
          className="space-y-4 rounded-lg border border-border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const v = validateEdits();
            if (v) setError(v);
            else {
              setError(null);
              setMode("review");
            }
          }}
          aria-label="Edit draft"
        >
          {editable.map((k) => {
            const kind = fieldKind(k, original[k]);
            const v = form[k];
            if (kind === "boolean")
              return <Checkbox key={k} label={label(k)} checked={Boolean(v)} onChange={(e) => setField(k, e.target.checked)} />;
            return (
              <Field
                key={k}
                label={label(k)}
                hint={kind === "datetime" ? "India Standard Time (IST)" : kind === "list" ? "Separate with commas" : undefined}
              >
                {kind === "textarea" ? (
                  <Textarea rows={k === "body" ? 14 : 4} value={String(v ?? "")} onChange={(e) => setField(k, e.target.value)} className="font-mono text-[13px]" />
                ) : (
                  <Input
                    type={kind === "datetime" ? "datetime-local" : kind === "number" ? "number" : k === "to" ? "email" : "text"}
                    value={String(v ?? "")}
                    onChange={(e) => setField(k, e.target.value)}
                  />
                )}
              </Field>
            );
          })}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setMode("view")}>Discard edits</Button>
            <Button type="submit" variant="primary">
              Review changes
            </Button>
          </div>
        </form>
      ) : (
        <section className="space-y-3 rounded-lg border border-border p-4" aria-label="Review changes">
          <h3 className="text-sm font-semibold">Review your changes</h3>
          {preview.length ? (
            <DiffList diffs={preview} />
          ) : (
            <p className="text-sm text-subtle">No changes — this will be approved as drafted.</p>
          )}
          <Field label="Note for the record (optional)">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setMode("edit")}>Back to editing</Button>
            <Button
              variant="primary"
              loading={busy === "approve"}
              icon={<Check className="h-4 w-4" />}
              onClick={() =>
                decide({ decision: "approve", edited_payload: preview.length ? edited : null, comment: comment.trim() || null })
              }
            >
              {preview.length ? "Approve with edits" : "Approve"}
            </Button>
          </div>
        </section>
      )}

      {!result && mode === "view" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button
            variant="primary"
            icon={<Check className="h-4 w-4" />}
            disabled={disabled}
            loading={busy === "approve"}
            onClick={() => decide({ decision: "approve" })}
          >
            Approve & send
          </Button>
          <Button icon={<Pencil className="h-4 w-4" />} disabled={disabled || !editable.length} onClick={startEdit}>
            Edit
          </Button>
          <Button variant="ghost" className="text-danger hover:text-danger" icon={<X className="h-4 w-4" />} disabled={disabled} onClick={() => setRejectOpen(true)}>
            Reject
          </Button>
          {approval.sensitive ? (
            <span className="ml-auto flex items-center gap-1 text-xs text-subtle">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Contains personal data
            </span>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject this draft"
        description="Your feedback is used to redraft — say what should change."
        size="md"
        footer={
          <>
            <Button onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy === "reject"}
              onClick={() => {
                if (comment.trim().length < 3) {
                  setCommentError("Add a short reason (at least 3 characters)");
                  return;
                }
                setCommentError(null);
                void decide({ decision: "reject", comment: comment.trim() });
              }}
            >
              Reject draft
            </Button>
          </>
        }
      >
        <Field label="Feedback" error={commentError} required>
          <Textarea
            rows={4}
            value={comment}
            maxLength={2000}
            placeholder="e.g. Quote the fixed-price package instead and drop the hourly line."
            onChange={(e) => setComment(e.target.value)}
          />
        </Field>
      </Dialog>
    </article>
  );
}
