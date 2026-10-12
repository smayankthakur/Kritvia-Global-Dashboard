"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { useTemplates, type Template } from "./send-template";
import {
  blanks,
  CATEGORIES,
  fillTemplate,
  LANGUAGES,
  languageLabel,
  paramProblem,
  templateProblem,
  templateStatus,
  templateTitle,
} from "./templates";

function TemplateRow({ t, canAdmin, onDelete }: { t: Template; canAdmin: boolean; onDelete: (t: Template) => void }) {
  const s = templateStatus(t.status);
  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{templateTitle(t.name)}</span>
          <Badge tone={s.tone}>{s.label}</Badge>
          <span className="text-xs text-subtle">
            {t.category === "MARKETING" ? "Offer or news" : t.category === "UTILITY" ? "Update" : "Login code"} · {languageLabel(t.language)}
          </span>
        </div>
        {canAdmin ? (
          <Button size="sm" variant="ghost" onClick={() => onDelete(t)} icon={<Trash2 className="h-3.5 w-3.5" />}>
            <span className="sr-only">Delete {templateTitle(t.name)}</span>
          </Button>
        ) : null}
      </div>
      <p className="text-sm whitespace-pre-wrap break-words text-muted">{fillTemplate(t.body, t.examples)}</p>
      {t.reason && t.status !== "APPROVED" ? <p className="text-xs text-danger">WhatsApp says: {t.reason.replace(/_/g, " ").toLowerCase()}</p> : null}
      {!t.sendable && t.status === "APPROVED" ? (
        <p className="text-xs text-subtle">Has a photo, link or code: send it from WhatsApp Manager.</p>
      ) : null}
    </li>
  );
}

function NewTemplate({ ventureId, onDone }: { ventureId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [language, setLanguage] = useState<Schemas["TemplateIn"]["language"]>("en");
  const [body, setBody] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const n = blanks(body);
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/whatsapp/templates", {
          params: { path: { venture_id: ventureId } },
          body: { label: label.trim(), category, language, body: body.trim(), examples: examples.slice(0, n).map((e) => e.trim()) },
        }),
      ),
    onSuccess: () => {
      toast.success("Sent to WhatsApp for review", "It usually takes a few minutes; you'll get a notification.");
      void qc.invalidateQueries({ queryKey: ["whatsapp-templates", ventureId] });
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const addBlank = () => setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}{{${n + 1}}} `);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return setError("Give the template a name.");
    const p = templateProblem(body) ?? (Array.from({ length: n }, (_, i) => examples[i] ?? "").map(paramProblem).find(Boolean) ? "Give a sample for every blank." : null);
    if (p) return setError(p);
    setError(null);
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4 border-b border-border p-4" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="For your team, e.g. Order ready" required>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Language" required>
          <Select value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium">What kind of message?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {CATEGORIES.map((c) => (
            <label
              key={c.id}
              className={cn(
                "flex cursor-pointer gap-2.5 rounded-lg border p-3 text-sm",
                category === c.id ? "border-accent bg-accent-soft/40" : "border-border",
              )}
            >
              <input
                type="radio"
                name="wa-template-category"
                className="mt-0.5 accent-[var(--accent)]"
                checked={category === c.id}
                onChange={() => setCategory(c.id)}
              />
              <span>
                <span className="block font-medium">{c.label}</span>
                <span className="block text-xs text-subtle">{c.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Message" hint="Use blanks for what changes each time, like the customer's name or an order number." required>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={1024} placeholder="Hi {{1}}, your order {{2}} is ready for pickup today." />
      </Field>
      <Button type="button" size="sm" onClick={addBlank} icon={<Plus className="h-3.5 w-3.5" />}>
        Add a blank
      </Button>
      {n ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: n }, (_, i) => (
            <Field key={i} label={`Sample for blank ${i + 1}`} hint="WhatsApp's reviewers read these" required>
              <Input
                value={examples[i] ?? ""}
                maxLength={300}
                onChange={(e) => {
                  const next = [...examples];
                  next[i] = e.target.value;
                  setExamples(next);
                }}
              />
            </Field>
          ))}
        </div>
      ) : null}
      {body.trim() ? (
        <div>
          <p className="mb-1 text-xs font-medium text-subtle">Preview</p>
          <p className="max-w-md rounded-lg bg-accent-soft px-3 py-2 text-sm whitespace-pre-wrap break-words text-accent-soft-fg">
            {fillTemplate(body, examples)}
          </p>
        </div>
      ) : null}
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={create.isPending}>
          Send for review
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The Templates tab: messages WhatsApp approved in advance, for writing first or after 24 hours. */
export function TemplatesPanel({ ventureId, canWrite, canAdmin }: { ventureId: string; canWrite: boolean; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const templates = useTemplates(ventureId);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const refresh = useMutation({
    mutationFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/whatsapp/templates", { params: { path: { venture_id: ventureId }, query: { refresh: true } } }),
      ),
    onSuccess: (d) => qc.setQueryData(["whatsapp-templates", ventureId], d),
    onError: (e) => toast.error("Could not refresh", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/ventures/{venture_id}/whatsapp/templates/{template_id}", {
          params: { path: { venture_id: ventureId, template_id: id } },
        }),
      ),
    onSuccess: () => {
      toast.success("Template deleted");
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ["whatsapp-templates", ventureId] });
    },
    onError: (e) => toast.error("Could not delete", errorMessage(e)),
  });

  return (
    <QueryState query={templates} loading={<SkeletonRows rows={3} className="p-3" />}>
      {(d: Schemas["TemplatesOut"]) => (
        <Card className="overflow-hidden p-0">
          <CardHeader
            title="Templates"
            description="WhatsApp lets you write first, or answer after 24 hours, only with a message it approved in advance. Write one here; approval usually takes minutes."
            actions={
              d.manageable && canWrite ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" loading={refresh.isPending} onClick={() => refresh.mutate()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                    Refresh
                  </Button>
                  {!adding ? (
                    <Button size="sm" variant="primary" onClick={() => setAdding(true)} icon={<Plus className="h-3.5 w-3.5" />}>
                      New template
                    </Button>
                  ) : null}
                </div>
              ) : undefined
            }
          />
          {d.connected && !d.manageable ? (
            <div className="p-4">
              <Notice tone="info" title="Reconnect to write templates here">
                This number was connected with a token. Connect it again with the Connect WhatsApp button (Settings → Connectors), or write templates in
                WhatsApp Manager and send them from here once approved.
              </Notice>
            </div>
          ) : null}
          {adding ? <NewTemplate ventureId={ventureId} onDone={() => setAdding(false)} /> : null}
          {d.templates.length ? (
            <ul className="divide-y divide-border" aria-label="Templates">
              {d.templates.map((t) => (
                <TemplateRow key={t.id} t={t} canAdmin={canAdmin} onDelete={setDeleting} />
              ))}
            </ul>
          ) : !adding ? (
            <EmptyState
              title="No templates yet"
              description={d.connected ? "Write your first one, e.g. “Hi {{1}}, your order is ready.”" : "Connect WhatsApp first."}
            />
          ) : null}
          <ConfirmDialog
            open={deleting !== null}
            onClose={() => setDeleting(null)}
            onConfirm={() => deleting && remove.mutate(deleting.id)}
            loading={remove.isPending}
            title={`Delete “${deleting ? templateTitle(deleting.name) : ""}”?`}
            description="It is deleted from your WhatsApp account too. WhatsApp blocks the same name for 30 days."
            confirmLabel="Delete template"
          />
        </Card>
      )}
    </QueryState>
  );
}
