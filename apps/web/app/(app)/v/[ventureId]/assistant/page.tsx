"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDashed, Clock, CornerDownLeft, Plug, RefreshCw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FormError, Input, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { EXAMPLES, inProgress, toolLabel } from "@/components/assistant/labels";
import { SaveAsSkill } from "@/components/skills/skills";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Item = Schemas["AssistantItem"];
type App = Schemas["AppOut"];

const STEP_ICON = {
  done: <Check className="h-3.5 w-3.5 text-success" aria-hidden />,
  failed: <X className="h-3.5 w-3.5 text-danger" aria-hidden />,
  "not approved": <X className="h-3.5 w-3.5 text-subtle" aria-hidden />,
  "waiting for approval": <Clock className="h-3.5 w-3.5 text-warning" aria-hidden />,
} as const;

function Request({ item, ventureId, canWrite }: { item: Item; ventureId: string; canWrite: boolean }) {
  const working = inProgress(item.status);
  const worked = item.status === "completed" && item.steps.some((s) => s.result === "done");
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 font-medium whitespace-pre-wrap">{item.request}</p>
        <div className="flex items-center gap-2 text-xs text-subtle">
          <span>{formatRelative(item.created_at)}</span>
          {item.skill_id ? <Badge tone="info">skill</Badge> : null}
          {item.pending_approval_id ? <Badge tone="warning">Needs your yes</Badge> : <StatusBadge status={working ? "working" : item.status} />}
        </div>
      </div>
      {item.steps.length ? (
        <ol className="space-y-1 text-sm" aria-label="What the assistant did">
          {item.steps.map((s) => (
            <li key={`${s.n}-${s.tool}-${s.result}`} className="flex items-center gap-2 text-muted">
              {STEP_ICON[s.result]}
              <span>
                {toolLabel(s.tool)} <span className="text-subtle">· {s.result}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {working ? (
        <p className="flex items-center gap-2 text-sm text-subtle" role="status">
          <CircleDashed className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Working on it…
        </p>
      ) : null}
      {item.pending_approval_id ? (
        <Notice tone="warning" title="A draft is waiting for your approval">
          Nothing is sent until you approve it.{" "}
          <Link href={`/inbox?id=${item.pending_approval_id}`} className="font-medium underline underline-offset-2">
            Review the draft
          </Link>
        </Notice>
      ) : null}
      {item.answer ? <p className="rounded-md border border-border bg-surface-2 p-3 text-sm whitespace-pre-wrap">{item.answer}</p> : null}
      {item.status === "failed" ? <p className="text-sm text-danger">Something went wrong. Try asking again in a moment.</p> : null}
      {worked && !item.skill_id && canWrite ? (
        <div className="flex justify-end">
          <SaveAsSkill ventureId={ventureId} runId={item.run_id} />
        </div>
      ) : null}
    </Card>
  );
}

function Composer({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (request: string) =>
      unwrap(api.POST("/ventures/{venture_id}/assistant", { params: { path: { venture_id: ventureId } }, body: { request } })),
    onSuccess: () => {
      setText("");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["assistant", ventureId] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const request = text.trim();
    if (request.length < 2) return setError("Write what you want done");
    m.mutate(request);
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <Field label="What should Kritvia do?" hint="English, Hindi or Hinglish. Drafts wait for your approval before anything is sent.">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
          rows={3}
          maxLength={4000}
          placeholder={EXAMPLES[1]}
        />
      </Field>
      <FormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={m.isPending} icon={<CornerDownLeft className="h-4 w-4" />}>
          Ask
        </Button>
        <span className="text-xs text-subtle">Ctrl + Enter</span>
      </div>
      <div className="flex flex-wrap gap-2 pt-1" aria-label="Examples">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setText(ex)}
            className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ex}
          </button>
        ))}
      </div>
    </form>
  );
}

/** Ready-made picks for the add form. Only apps whose MCP address and token are documented. */
const APP_PICKS = [
  {
    key: "zapier",
    label: "Zapier (8,000+ apps)",
    name: "zapier",
    url: "https://mcp.zapier.com/api/v1/connect",
    help: "In Zapier MCP (mcp.zapier.com): Add MCP server → Other → choose the apps and actions you want → Connect tab → Generate token. Paste the token here; it is shown only once.",
  },
  {
    key: "own",
    label: "Another app's MCP server",
    name: "",
    url: "",
    help: "Paste the app's MCP server address (https) and, if it needs one, its token. Only addresses on the public internet are accepted.",
  },
] as const;

function ConnectedApps({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useQuery({
    queryKey: ["apps", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/apps", { params: { path: { venture_id: ventureId } } })),
  });
  const [form, setForm] = useState({ name: "", url: "", token: "" });
  const [pick, setPick] = useState<(typeof APP_PICKS)[number]["key"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["apps", ventureId] });
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/apps", {
          params: { path: { venture_id: ventureId } },
          body: { name: form.name.trim().toLowerCase(), url: form.url.trim(), token: form.token.trim() || null },
        }),
      ),
    onSuccess: (a) => {
      toast.success(`${a.name} connected`, `${a.tools.length} tool(s) the assistant can use.`);
      setForm({ name: "", url: "", token: "" });
      setError(null);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const reload = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST("/ventures/{venture_id}/apps/{app_id}/refresh", { params: { path: { venture_id: ventureId, app_id: id } } })),
    onSuccess: refresh,
    onError: (e) => toast.error("Could not refresh", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/ventures/{venture_id}/apps/{app_id}", { params: { path: { venture_id: ventureId, app_id: id } } })),
    onSuccess: () => {
      toast.success("App removed");
      refresh();
    },
    onError: (e) => toast.error("Could not remove", errorMessage(e)),
  });
  return (
    <Card className="space-y-4 p-4" aria-labelledby="apps-heading">
      <div>
        <h2 id="apps-heading" className="flex items-center gap-2 font-semibold">
          <Plug className="h-4 w-4 text-subtle" aria-hidden /> Connected apps
        </h2>
        <p className="text-sm text-muted">
          Add any app that offers an MCP server, or thousands at once through Zapier. Tools that only read run straight away; anything that changes the app waits
          for a person to approve it. Included in Growth and above.
        </p>
      </div>
      <QueryState query={apps} loading={<SkeletonRows rows={2} />}>
        {(list: App[]) =>
          list.length ? (
            <ul className="divide-y divide-border">
              {list.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {a.name} {a.status !== "active" ? <Badge tone="danger">{a.status}</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-subtle">
                      {a.tools.length} tool(s): {a.tools.map((t) => t.name).join(", ")}
                    </p>
                    {a.last_error ? <p className="text-xs text-danger">{a.last_error}</p> : null}
                  </div>
                  {canAdmin ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" loading={reload.isPending && reload.variables === a.id} onClick={() => reload.mutate(a.id)} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                        Refresh
                      </Button>
                      <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === a.id} onClick={() => remove.mutate(a.id)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-subtle">No apps connected yet.</p>
          )
        }
      </QueryState>
      {canAdmin ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick picks">
          {APP_PICKS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={pick === p.key ? "primary" : "secondary"}
              aria-pressed={pick === p.key}
              onClick={() => {
                setPick(p.key);
                setForm({ name: p.name, url: p.url, token: "" });
                setError(null);
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>
      ) : null}
      {canAdmin && pick ? <p className="text-sm text-muted">{APP_PICKS.find((p) => p.key === pick)!.help}</p> : null}
      {canAdmin ? (
        <form
          className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
          noValidate
        >
          <Field label="Short name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="hubspot" maxLength={24} autoComplete="off" />
          </Field>
          <Field label="MCP server address">
            <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…/mcp" inputMode="url" autoComplete="off" />
          </Field>
          <Field label="Token (if the app needs one)">
            <Input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} autoComplete="off" />
          </Field>
          <Button type="submit" loading={add.isPending}>
            Connect
          </Button>
          <div className="sm:col-span-4">
            <FormError message={error} />
          </div>
        </form>
      ) : null}
    </Card>
  );
}

export default function AssistantPage() {
  const v = useVenture();
  const items = useQuery({
    queryKey: ["assistant", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/assistant", { params: { path: { venture_id: v.id }, query: { limit: 20 } } })),
    // keep polling while something is being worked on
    refetchInterval: (q) => ((q.state.data ?? []).some((i) => inProgress(i.status)) ? 3000 : false),
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Assistant" description="Ask Kritvia to do anything in plain words. It looks things up, drafts the messages and keeps you in control." />
      <Card className="p-4">
        <Composer ventureId={v.id} />
      </Card>
      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="font-semibold">
          Your requests
        </h2>
        <QueryState query={items} loading={<SkeletonRows rows={3} />}>
          {(list: Item[]) =>
            list.length ? (
              <div className="space-y-3">
                {list.map((i) => (
                  <Request key={i.run_id} item={i} ventureId={v.id} canWrite={v.access === "write"} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing asked yet" description="Try one of the examples above." />
            )
          }
        </QueryState>
      </section>
      <ConnectedApps ventureId={v.id} canAdmin={Boolean(v.can_admin || v.is_owner)} />
    </div>
  );
}
