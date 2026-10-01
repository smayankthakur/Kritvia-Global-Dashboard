"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookA, Pencil, Plus, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";

type Term = Schemas["TermOut"];
type Scope = "personal" | "shared";

export const vocabularyKey = (ventureId: string) => ["vocabulary", ventureId] as const;

/** "Kritvia, kreet via; critvia" -> ["kreet via", "critvia"] after the term. Exported for tests. */
export function parseImport(text: string): { term: string; sounds_like: string[] }[] {
  const out: { term: string; sounds_like: string[] }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.search(/[,\t]/);
    const t = (idx < 0 ? line : line.slice(0, idx)).trim();
    const rest = idx < 0 ? "" : line.slice(idx + 1);
    if (!t) continue;
    out.push({ term: t.slice(0, 64), sounds_like: rest.split(/[;|]/).map((s) => s.trim()).filter(Boolean).slice(0, 20) });
  }
  return out;
}

function ChipsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase()) && value.length < 20) onChange([...value, t.slice(0, 64)]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 focus-within:border-accent">
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-xs">
          {v}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="text-subtle hover:text-fg">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={value.length ? "" : placeholder}
        className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm outline-none"
        aria-label="Add a way it is misheard"
        data-voice-ignore
      />
    </div>
  );
}

function TermDialog({
  ventureId,
  canWrite,
  open,
  onClose,
  editing,
  seed,
}: {
  ventureId: string;
  canWrite: boolean;
  open: boolean;
  onClose: () => void;
  editing: Term | null;
  seed?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [term, setTerm] = useState("");
  const [sounds, setSounds] = useState<string[]>([]);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState<Scope>("personal");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setTerm(editing?.term ?? seed ?? "");
    setSounds(editing?.sounds_like ?? []);
    setCaseSensitive(editing?.case_sensitive ?? false);
    setScope((editing?.scope as Scope | undefined) ?? (canWrite && seed ? "shared" : "personal"));
  }, [open, editing, seed, canWrite]);
  const save = useMutation({
    mutationFn: () =>
      editing
        ? unwrap(
            api.PATCH("/ventures/{venture_id}/vocabulary/{term_id}", {
              params: { path: { venture_id: ventureId, term_id: editing.id } },
              body: { term, sounds_like: sounds, case_sensitive: caseSensitive },
            }),
          )
        : unwrap(
            api.POST("/ventures/{venture_id}/vocabulary", {
              params: { path: { venture_id: ventureId } },
              body: { term, sounds_like: sounds, case_sensitive: caseSensitive, scope },
            }),
          ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["vocabulary"] });
      toast.success(editing ? "Term updated" : "Term added");
      onClose();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? "Edit term" : "Add a term"}
      description="The correct spelling, and how the speech model tends to mishear it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!term.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={err} />
        <Field label="Correct spelling" hint="A name, brand, product or jargon — e.g. Sitelytc, Truhome, VAPT, Sharma ji">
          <Input value={term} maxLength={64} onChange={(e) => setTerm(e.target.value)} autoFocus data-voice-ignore />
        </Field>
        <Field label="Sounds like" hint="Press Enter after each. These are replaced with the correct spelling in every transcript.">
          <ChipsInput value={sounds} onChange={setSounds} placeholder="site lytic, sight lit sea…" />
        </Field>
        <Checkbox label="Match case exactly" hint="Only replace when the capitalisation matches too" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
        {!editing ? (
          <Field label="Who uses it">
            <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="personal">Just me</option>
              <option value="shared" disabled={!canWrite}>
                Everyone in this venture (also meeting transcripts){canWrite ? "" : " — needs write access"}
              </option>
            </Select>
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

function ImportDialog({ ventureId, canWrite, open, onClose }: { ventureId: string; canWrite: boolean; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>("personal");
  const [err, setErr] = useState<string | null>(null);
  const rows = parseImport(text);
  const run = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/vocabulary/import", {
          params: { path: { venture_id: ventureId } },
          body: { terms: rows.map((r) => ({ ...r, scope, case_sensitive: false })) },
        }),
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["vocabulary"] });
      toast.success(`Imported ${r.imported} term${r.imported === 1 ? "" : "s"}`);
      setText("");
      onClose();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import terms"
      description="One per line: the correct spelling, then a comma and the ways it is misheard separated by semicolons."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!rows.length || rows.length > 500} loading={run.isPending} onClick={() => run.mutate()}>
            Import {rows.length || ""}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={err} />
        <Textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Sitelytc, site lytic; sight lit sea\nTruhome, true home\nVAPT, vee apt"}
          className="font-mono text-xs"
          data-voice-ignore
        />
        <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Who uses them">
          <option value="personal">Just me</option>
          <option value="shared" disabled={!canWrite}>
            Everyone in this venture
          </option>
        </Select>
      </div>
    </Dialog>
  );
}

export function VocabularyManager({ ventureId, canWrite }: { ventureId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"" | Scope>("");
  const [dialog, setDialog] = useState<{ open: boolean; editing: Term | null; seed?: string }>({ open: false, editing: null });
  const [importing, setImporting] = useState(false);
  const q = useQuery({
    queryKey: [...vocabularyKey(ventureId), search, scope],
    queryFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/vocabulary", {
          params: { path: { venture_id: ventureId }, query: { q: search || undefined, scope: scope || undefined } },
        }),
      ),
    placeholderData: (prev) => prev,
  });
  const sug = useQuery({
    queryKey: ["vocabulary", ventureId, "suggestions"],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/vocabulary/suggestions", { params: { path: { venture_id: ventureId }, query: { limit: 12 } } })),
  });
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/vocabulary/{term_id}", { params: { path: { venture_id: ventureId, term_id: id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["vocabulary"] }),
    onError: (e) => toast.error("Could not delete", errorMessage(e)),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <Card>
        <CardHeader
          title="Vocabulary"
          description="Names and terms Kritvia should always spell right — in dictation and (for shared terms) meeting transcripts. They are also sent to the speech model as spelling hints."
          actions={
            <div className="flex gap-2">
              <Button size="sm" icon={<Upload className="h-3.5 w-3.5" />} onClick={() => setImporting(true)}>
                Import
              </Button>
              <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog({ open: true, editing: null })}>
                Add term
              </Button>
            </div>
          }
        />
        <div className="flex flex-wrap gap-2 border-b border-border p-3">
          <div className="w-full max-w-xs">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search terms" aria-label="Search terms" data-voice-ignore />
          </div>
          <div className="w-40">
            <Select value={scope} onChange={(e) => setScope(e.target.value as "" | Scope)} aria-label="Filter by scope">
              <option value="">All terms</option>
              <option value="personal">Just mine</option>
              <option value="shared">Shared</option>
            </Select>
          </div>
        </div>
        {q.isPending ? (
          <SkeletonRows />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState
            icon={BookA}
            title={search || scope ? "No matching terms" : "No vocabulary yet"}
            description="Add the names you say often. When you fix a dictated word, Kritvia also offers to remember it."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table label="Vocabulary terms">
              <THead>
                <Tr>
                  <Th>Term</Th>
                  <Th>Sounds like</Th>
                  <Th>Used by</Th>
                  <Th className="text-right">Fixes</Th>
                  <Th className="w-20">
                    <span className="sr-only">Actions</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {q.data.map((t) => {
                  const editable = t.scope === "personal" || canWrite;
                  return (
                    <Tr key={t.id}>
                      <Td className="font-medium">
                        {t.term}
                        {t.source === "auto_learn" ? (
                          <Badge tone="accent" className="ml-2" title="Learned from one of your corrections">
                            learned
                          </Badge>
                        ) : null}
                      </Td>
                      <Td className="text-muted">{t.sounds_like.length ? t.sounds_like.join(", ") : <span className="text-subtle">—</span>}</Td>
                      <Td>
                        <Badge tone={t.scope === "shared" ? "info" : "neutral"}>{t.scope === "shared" ? "Everyone" : "Just me"}</Badge>
                      </Td>
                      <Td className="text-right tabular-nums">{t.uses}</Td>
                      <Td>
                        {editable ? (
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" aria-label={`Edit ${t.term}`} onClick={() => setDialog({ open: true, editing: t })}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" aria-label={`Delete ${t.term}`} onClick={() => del.mutate(t.id)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </Card>

      <Card className="h-fit">
        <CardHeader title="From your knowledge" description="People, clients and products Kritvia has met in your documents and meetings." />
        <div className="p-3">
          {sug.isPending ? (
            <SkeletonRows rows={3} />
          ) : sug.isError || !sug.data.length ? (
            <p className="px-1 text-sm text-subtle">Nothing to suggest yet. As documents, emails and meetings are added, names show up here.</p>
          ) : (
            <ul className="space-y-1">
              {sug.data.map((s) => (
                <li key={`${s.type}-${s.term}`} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{s.term}</div>
                    <div className="text-[11px] text-subtle">
                      {s.type} · {s.mentions} link{s.mentions === 1 ? "" : "s"}
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" aria-label={`Add ${s.term}`} onClick={() => setDialog({ open: true, editing: null, seed: s.term })}>
                    <Sparkles className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Notice tone="info" className="mt-3">
            Names of people are only sent to hosted speech models as hints if the venture allows it (Settings → General). Local models always use them.
          </Notice>
        </div>
      </Card>

      <TermDialog ventureId={ventureId} canWrite={canWrite} open={dialog.open} editing={dialog.editing} seed={dialog.seed} onClose={() => setDialog({ open: false, editing: null })} />
      <ImportDialog ventureId={ventureId} canWrite={canWrite} open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
