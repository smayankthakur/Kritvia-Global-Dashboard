"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Github, KeyRound, LogIn, Plug, RefreshCw, Search, Send, Store, Trash2, Webhook } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { csrfHeaders } from "@/lib/bff/csrf";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";

type App = Schemas["AppOut"];
type Entry = Schemas["CatalogApp"];
type Auth = "none" | "bearer" | "header" | "basic";
type Gh = Schemas["GithubOut"];

const SOURCE: Record<Entry["source"], string> = { kritvia: "Checked by Kritvia", registry: "MCP Registry", github: "GitHub" };
const AUTH_LABEL: Record<string, string> = {
  oauth: "Sign in",
  bearer: "Token",
  header: "API key header",
  basic: "Key and secret (basic)",
  none: "No sign-in",
};
const OUTCOME: Record<string, [string, "success" | "warning" | "danger"]> = {
  connected: ["is connected: the assistant can use it now.", "success"],
  denied: ["The sign-in was cancelled.", "warning"],
  invalid_state: ["That sign-in link expired or was started in another browser. Start again.", "warning"],
  forbidden: ["Only the business's admins can connect apps.", "danger"],
  exchange_failed: ["The app didn't accept the sign-in. Try again, or connect it with a token.", "danger"],
};

/** A short name the assistant uses for the app (a-z, 0-9, _; starts with a letter). */
export function shortName(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "");
  return (s || "app").slice(0, 24);
}

async function startSignIn(ventureId: string, name: string, url: string, catalogId: string | null): Promise<string> {
  const res = await fetch("/api/oauth/mcp/start", {
    method: "POST",
    headers: { "content-type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ venture_id: ventureId, name, url, catalog_id: catalogId }),
  });
  const body = (await res.json().catch(() => ({}))) as { authorize_url?: string; detail?: string };
  if (!res.ok || !body.authorize_url) throw new Error(typeof body.detail === "string" ? body.detail : `HTTP ${res.status}`);
  return body.authorize_url;
}

function TokenFields({
  auth,
  setAuth,
  modes,
  header,
  setHeader,
  token,
  setToken,
}: {
  auth: string;
  setAuth: (a: string) => void;
  modes: string[];
  header: string;
  setHeader: (h: string) => void;
  token: string;
  setToken: (t: string) => void;
}) {
  return (
    <>
      {modes.length > 1 ? (
        <Field label="How it connects">
          <Select value={auth} onChange={(e) => setAuth(e.target.value)}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {AUTH_LABEL[m] ?? m}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {auth === "header" ? (
        <Field label="Header name" hint="e.g. x-api-key">
          <Input value={header} onChange={(e) => setHeader(e.target.value)} autoComplete="off" maxLength={60} />
        </Field>
      ) : null}
      {auth === "bearer" || auth === "header" || auth === "basic" ? (
        <Field label={auth === "basic" ? "Key and secret, as key:secret" : "Token or API key"} hint="Stored encrypted; never shown again.">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </Field>
      ) : null}
    </>
  );
}

/** Connect one app from the store (an MCP address): sign in, or a token, or nothing. */
function ConnectDialog({ entry, ventureId, onClose, onDone }: { entry: Entry | null; ventureId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const modes = entry?.auth_modes?.length ? entry.auth_modes : ["oauth", "bearer", "none"];
  const [name, setName] = useState("");
  const [auth, setAuth] = useState("oauth");
  const [header, setHeader] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [envs, setEnvs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!entry) return;
    setName(shortName(entry.title));
    setAuth(modes[0] ?? "none");
    setHeader(entry.header_name ?? "");
    setToken("");
    setEnvs({});
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.id]);
  const go = useMutation({
    mutationFn: async () => {
      if (!entry) return null;
      if (entry.kind === "hosted") {
        return unwrap(
          api.POST("/ventures/{venture_id}/apps/hosted", { params: { path: { venture_id: ventureId } }, body: { name, catalog_id: entry.id, env: envs } }),
        );
      }
      if (auth === "oauth") {
        window.location.assign(await startSignIn(ventureId, name, entry.url ?? "", entry.id));
        return null;
      }
      return unwrap(
        api.POST("/ventures/{venture_id}/apps", {
          params: { path: { venture_id: ventureId } },
          body: {
            name,
            url: entry.url ?? "",
            kind: "mcp",
            auth: auth as Auth,
            header_name: auth === "header" ? header : null,
            token: token || null,
            base_url: null,
            catalog_id: entry.id,
          },
        }),
      );
    },
    onSuccess: (a) => {
      if (!a) return;
      toast.success(`${a.name} connected`, `${a.tools.length} tool(s) the assistant can use.`);
      onDone();
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open={entry !== null}
      onClose={onClose}
      title={entry ? `Connect ${entry.title}` : ""}
      description={entry?.description ?? undefined}
      footer={
        <Button onClick={() => go.mutate()} loading={go.isPending} icon={entry?.kind !== "hosted" && auth === "oauth" ? <LogIn className="h-4 w-4" /> : <Plug className="h-4 w-4" />}>
          {entry?.kind !== "hosted" && auth === "oauth" ? `Sign in to ${entry?.title ?? "the app"}` : "Connect"}
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Short name" hint="How the assistant calls it: a-z, 0-9 and _">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={24} autoComplete="off" />
        </Field>
        {entry?.kind === "hosted" ? (
          <>
            <p className="text-sm text-muted">
              Runs in Kritvia’s sandbox ({entry.package}). It can reach only: {entry.egress_hosts.length ? entry.egress_hosts.join(", ") : "no sites"}.
            </p>
            {(entry.env ?? []).map((e) => (
              <Field key={e.name} label={e.name} hint={e.description || (e.required ? "required" : "optional")}>
                <Input
                  type={e.secret ? "password" : "text"}
                  value={envs[e.name] ?? ""}
                  onChange={(ev) => setEnvs({ ...envs, [e.name]: ev.target.value })}
                  autoComplete="off"
                />
              </Field>
            ))}
          </>
        ) : (
          <TokenFields auth={auth} setAuth={setAuth} modes={modes} header={header} setHeader={setHeader} token={token} setToken={setToken} />
        )}
        {entry?.docs_url ? (
          <p className="text-xs text-subtle">
            Where to get a token:{" "}
            <a href={entry.docs_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {entry.title}’s guide
            </a>
          </p>
        ) : null}
        <FormError message={error} />
      </div>
    </Dialog>
  );
}

function EntryCard({ e, onConnect, onAsk, asking }: { e: Entry; onConnect: (e: Entry) => void; onAsk: (e: Entry) => void; asking: boolean }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{e.title}</p>
        <Badge tone={e.source === "kritvia" ? "success" : "neutral"}>{SOURCE[e.source]}</Badge>
      </div>
      {e.description ? <p className="line-clamp-3 text-sm text-muted">{e.description}</p> : null}
      <p className="text-xs text-subtle">
        {e.kind === "hosted" ? `Runs in Kritvia's sandbox: ${e.package ?? ""}` : (e.auth_modes ?? []).map((m) => AUTH_LABEL[m] ?? m).join(" · ")}
      </p>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {e.installable ? (
          <Button size="sm" onClick={() => onConnect(e)} icon={<Plug className="h-3.5 w-3.5" />} aria-label={`Connect ${e.title}`}>
            Connect
          </Button>
        ) : e.status === "pending" ? (
          <Badge tone="warning">Waiting for Kritvia’s review</Badge>
        ) : e.status === "rejected" ? (
          <Badge tone="danger">Not approved</Badge>
        ) : (
          <Button size="sm" variant="secondary" loading={asking} onClick={() => onAsk(e)} icon={<Send className="h-3.5 w-3.5" />}>
            Ask Kritvia’s team to review
          </Button>
        )}
        {e.repo_url || e.docs_url ? (
          <a href={(e.docs_url || e.repo_url) as string} target="_blank" rel="noreferrer" className="self-center text-xs text-subtle underline underline-offset-2">
            About
          </a>
        ) : null}
      </div>
    </Card>
  );
}

function Catalogue({ ventureId, source, search, onDone }: { ventureId: string; source?: "kritvia"; search: boolean; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<Entry | null>(null);
  const list = useQuery({
    queryKey: ["app-store", source ?? "all", term],
    queryFn: () => unwrap(api.GET("/app-store", { params: { query: { q: term || null, source: source ?? null, limit: 30 } } })),
    enabled: !search || term.length > 0,
  });
  const ask = useMutation({
    mutationFn: (e: Entry) => unwrap(api.POST("/app-store/request", { body: { id: e.id } })),
    onSuccess: () => {
      toast.success("Sent to Kritvia's team", "You'll be able to connect it once they approve it.");
      void qc.invalidateQueries({ queryKey: ["app-store"] });
    },
    onError: (e) => toast.error("Couldn't send it", errorMessage(e)),
  });
  return (
    <div className="space-y-3">
      {search ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(q.trim());
          }}
        >
          <Field label="Search apps" srLabel className="flex-1">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search thousands of MCP servers: crm, calendar, shopify…" />
          </Field>
          <Button type="submit" icon={<Search className="h-4 w-4" />}>
            Search
          </Button>
        </form>
      ) : null}
      {search && !term ? (
        <p className="text-sm text-subtle">The official MCP Registry, synced every hour, plus apps people sent in from GitHub that Kritvia’s team approved.</p>
      ) : (
        <QueryState query={list} loading={<SkeletonRows rows={3} />}>
          {(rows: Entry[]) =>
            rows.length ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((e) => (
                  <EntryCard key={e.id} e={e} onConnect={setOpen} onAsk={(x) => ask.mutate(x)} asking={ask.isPending && ask.variables?.id === e.id} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing found" description="Try another word, or add the app by its address." />
            )
          }
        </QueryState>
      )}
      <ConnectDialog entry={open} ventureId={ventureId} onClose={() => setOpen(null)} onDone={onDone} />
    </div>
  );
}

function FromGithub({ ventureId, onDone }: { ventureId: string; onDone: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Entry | null>(null);
  const analyse = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/apps/github", { params: { path: { venture_id: ventureId } }, body: { url: url.trim() } })),
    onSuccess: (a) => {
      setPicked(a.skills.map((s) => s.path));
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const importSkills = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/apps/github/skills", { params: { path: { venture_id: ventureId } }, body: { url: url.trim(), paths: picked } })),
    onSuccess: (out) => toast.success(`${out.skill_ids.length} skill(s) added`, "Find them on the Automations page; they run when you ask."),
    onError: (e) => toast.error("Couldn't add the skills", errorMessage(e)),
  });
  const submit = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/apps/github/submit", { params: { path: { venture_id: ventureId } }, body: { url: url.trim(), note: null } })),
    onSuccess: () => {
      toast.success("Sent to Kritvia's team", "They check the code and the sites it needs; then anyone can connect it.");
      analyse.mutate();
    },
    onError: (e) => toast.error("Couldn't send it", errorMessage(e)),
  });
  const a: Gh | undefined = analyse.data;
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          analyse.mutate();
        }}
      >
        <Field label="GitHub project" srLabel className="min-w-64 flex-1">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/project" inputMode="url" />
        </Field>
        <Button type="submit" loading={analyse.isPending} icon={<Github className="h-4 w-4" />}>
          Look at it
        </Button>
      </form>
      <FormError message={error} />
      {a ? (
        <Card className="space-y-3 p-4">
          <div>
            <p className="font-medium">
              {a.repo} <span className="text-xs text-subtle">{a.stars} stars on GitHub{a.license ? ` · ${a.license}` : ""}</span>
            </p>
            {a.description ? <p className="text-sm text-muted">{a.description}</p> : null}
          </div>
          {a.kind === "none" ? (
            <Notice tone="warning">
              {a.unpublished
                ? `It looks like an MCP server, but it isn't published on ${a.unpublished}. Kritvia runs only published packages, at a version its team checked.`
                : "Kritvia didn't find skills (SKILL.md), an MCP address or an MCP package in it."}
            </Notice>
          ) : null}
          {a.remote ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm">It has a hosted MCP address: {a.remote}</p>
              <Button
                size="sm"
                onClick={() =>
                  setOpen({
                    id: `github:${a.repo.toLowerCase()}`,
                    source: "github",
                    kind: "mcp",
                    title: a.title,
                    description: a.description,
                    url: a.remote,
                    auth_modes: ["oauth", "bearer", "none"],
                    header_name: null,
                    docs_url: a.repo_url,
                    repo_url: a.repo_url,
                    package: null,
                    env: [],
                    egress_hosts: [],
                    status: "listed",
                    installable: true,
                  })
                }
              >
                Connect
              </Button>
            </div>
          ) : null}
          {a.kind === "hosted" ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm">MCP server package: {a.package}</p>
              {a.catalog?.installable ? (
                <Button size="sm" onClick={() => setOpen(a.catalog!)} icon={<BadgeCheck className="h-3.5 w-3.5" />}>
                  Approved: connect
                </Button>
              ) : a.catalog?.status === "pending" ? (
                <Badge tone="warning">Waiting for Kritvia’s review</Badge>
              ) : a.catalog?.status === "rejected" ? (
                <Badge tone="danger">Not approved</Badge>
              ) : (
                <Button size="sm" variant="secondary" loading={submit.isPending} onClick={() => submit.mutate()} icon={<Send className="h-3.5 w-3.5" />}>
                  Send for review
                </Button>
              )}
            </div>
          ) : null}
          {a.skills.length ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Skills in it ({a.skills.length}): each becomes a Kritvia skill, read as instructions (no code from it runs)</p>
              {a.skills.map((s) => (
                <div key={s.path} className="space-y-1 rounded-md border border-border p-2">
                  <Checkbox
                    label={s.name}
                    hint={s.description || s.path}
                    checked={picked.includes(s.path)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, s.path] : picked.filter((p) => p !== s.path))}
                  />
                  <details>
                    <summary className="cursor-pointer text-xs text-subtle">What it says</summary>
                    <pre className="mt-2 max-h-48 overflow-auto text-xs whitespace-pre-wrap text-muted">{s.instructions}</pre>
                  </details>
                </div>
              ))}
              <Button size="sm" loading={importSkills.isPending} disabled={!picked.length} onClick={() => importSkills.mutate()}>
                Add {picked.length} skill(s)
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}
      <ConnectDialog entry={open} ventureId={ventureId} onClose={() => setOpen(null)} onDone={onDone} />
    </div>
  );
}

function ByAddress({ ventureId, kind, onDone }: { ventureId: string; kind: "mcp" | "openapi"; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [base, setBase] = useState("");
  const [auth, setAuth] = useState(kind === "mcp" ? "oauth" : "bearer");
  const [header, setHeader] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const modes = kind === "mcp" ? ["oauth", "bearer", "header", "basic", "none"] : ["bearer", "header", "basic", "none"];
  const add = useMutation({
    mutationFn: async () => {
      const n = name.trim().toLowerCase();
      if (kind === "mcp" && auth === "oauth") {
        window.location.assign(await startSignIn(ventureId, n, url.trim(), null));
        return null;
      }
      return unwrap(
        api.POST("/ventures/{venture_id}/apps", {
          params: { path: { venture_id: ventureId } },
          body: { name: n, url: url.trim(), kind, auth: auth as Auth, header_name: auth === "header" ? header : null, token: token || null, base_url: base.trim() || null, catalog_id: null },
        }),
      );
    },
    onSuccess: (a) => {
      if (!a) return;
      toast.success(`${a.name} connected`, `${a.tools.length} tool(s) the assistant can use.`);
      setName("");
      setUrl("");
      setToken("");
      setError(null);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
      noValidate
    >
      <p className="text-sm text-muted">
        {kind === "mcp"
          ? "Any app with an MCP server: paste its address (https). Most apps let you sign in; others give you a token or an API key."
          : "Any web app with an API: paste the address of its OpenAPI (Swagger) description. Its operations become tools: reads run at once, everything else waits for your yes."}
      </p>
      <Field label="Short name" hint="a-z, 0-9 and _">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "mcp" ? "hubspot" : "shop"} maxLength={24} autoComplete="off" />
      </Field>
      <Field label={kind === "mcp" ? "MCP server address" : "OpenAPI description address"}>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === "mcp" ? "https://…/mcp" : "https://…/openapi.json"} inputMode="url" autoComplete="off" />
      </Field>
      {kind === "openapi" ? (
        <Field label="API address (if the description doesn't say)" hint="optional, https">
          <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://api.example.com/v1" inputMode="url" autoComplete="off" />
        </Field>
      ) : null}
      <TokenFields auth={auth} setAuth={setAuth} modes={modes} header={header} setHeader={setHeader} token={token} setToken={setToken} />
      <FormError message={error} />
      <div>
        <Button type="submit" loading={add.isPending} icon={kind === "mcp" && auth === "oauth" ? <LogIn className="h-4 w-4" /> : <Plug className="h-4 w-4" />}>
          {kind === "mcp" && auth === "oauth" ? "Sign in and connect" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function Installed({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [hook, setHook] = useState<Schemas["AppHookOut"] | null>(null);
  const [removing, setRemoving] = useState<App | null>(null);
  const apps = useQuery({
    queryKey: ["apps", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/apps", { params: { path: { venture_id: ventureId } } })),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["apps", ventureId] });
  const p = (id: string) => ({ params: { path: { venture_id: ventureId, app_id: id } } });
  const reload = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/ventures/{venture_id}/apps/{app_id}/refresh", p(id))),
    onSuccess: refresh,
    onError: (e) => toast.error("Could not refresh", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/apps/{app_id}", p(id))),
    onSuccess: () => {
      toast.success("App removed");
      setRemoving(null);
      refresh();
    },
    onError: (e) => toast.error("Could not remove", errorMessage(e)),
  });
  const makeHook = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/ventures/{venture_id}/apps/{app_id}/hook", p(id))),
    onSuccess: (h) => {
      setHook(h);
      refresh();
    },
    onError: (e) => toast.error("Could not make the address", errorMessage(e)),
  });
  const signIn = useMutation({
    mutationFn: async (a: App) => window.location.assign(await startSignIn(ventureId, a.name, a.url, a.catalog_id ?? null)),
    onError: (e) => toast.error("Couldn't start the sign-in", errorMessage(e)),
  });
  return (
    <>
      <QueryState query={apps} loading={<SkeletonRows rows={2} />}>
        {(list: App[]) =>
          list.length ? (
            <ul className="divide-y divide-border">
              {list.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {a.name}
                      <Badge tone="neutral">{a.kind === "openapi" ? "web app" : a.kind === "hosted" ? "in Kritvia's sandbox" : AUTH_LABEL[a.auth]}</Badge>
                      {a.status === "needs_auth" ? <Badge tone="warning">sign in again</Badge> : a.status !== "active" ? <Badge tone="danger">{a.status}</Badge> : null}
                      {a.has_hook ? <Badge tone="info">sends events</Badge> : null}
                    </p>
                    <p className="truncate text-xs text-subtle">
                      {a.tools.length} tool(s): {a.tools.map((t) => t.name).join(", ")}
                    </p>
                    {a.last_error ? <p className="text-xs text-danger">{a.last_error}</p> : null}
                  </div>
                  {canAdmin ? (
                    <div className="flex flex-wrap gap-1">
                      {a.auth === "oauth" && a.status === "needs_auth" ? (
                        <Button size="sm" onClick={() => signIn.mutate(a)} loading={signIn.isPending} icon={<LogIn className="h-3.5 w-3.5" />}>
                          Sign in
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" loading={reload.isPending && reload.variables === a.id} onClick={() => reload.mutate(a.id)} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                        Refresh
                      </Button>
                      <Button size="sm" variant="ghost" loading={makeHook.isPending && makeHook.variables === a.id} onClick={() => makeHook.mutate(a.id)} icon={<Webhook className="h-3.5 w-3.5" />}>
                        {a.has_hook ? "New event address" : "Events in"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(a)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Store} title="No apps yet" description="Connect one from Popular, search the MCP Registry, or add any app by its address." />
          )
        }
      </QueryState>
      <Dialog open={hook !== null} onClose={() => setHook(null)} title="Address for the app's events" description="Set this up as a webhook in the app. Each event becomes an 'app.event' on your Activity page; skills and alerts can start right after one.">
        {hook ? (
          <div className="space-y-3">
            <CopyField label="Webhook address" value={hook.url} />
            <CopyField label="Secret (send as Authorization: Bearer …); shown only now" value={hook.secret} secret />
          </div>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.id)}
        title={`Remove ${removing?.name ?? "the app"}?`}
        description="The assistant stops using it. Its token is deleted."
        confirmLabel="Remove"
        loading={remove.isPending}
      />
    </>
  );
}

const TABS = [
  { id: "installed", label: "Installed" },
  { id: "popular", label: "Popular" },
  { id: "search", label: "Search all" },
  { id: "github", label: "From GitHub" },
  { id: "address", label: "By address" },
  { id: "web", label: "Web app (API)" },
];

export function AppStore({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState("installed");
  const [outcome, setOutcome] = useState<{ key: string; name: string } | null>(null);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const key = sp.get("app");
    if (key && OUTCOME[key]) {
      setOutcome({ key, name: sp.get("name") ?? "The app" });
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["apps", ventureId] });
    setTab("installed");
  };
  let body: ReactNode;
  if (tab === "installed") body = <Installed ventureId={ventureId} canAdmin={canAdmin} />;
  else if (!canAdmin) body = <Notice>Only the business’s admins can connect apps.</Notice>;
  else if (tab === "popular") body = <Catalogue ventureId={ventureId} source="kritvia" search={false} onDone={done} />;
  else if (tab === "search") body = <Catalogue ventureId={ventureId} search onDone={done} />;
  else if (tab === "github") body = <FromGithub ventureId={ventureId} onDone={done} />;
  else if (tab === "address") body = <ByAddress key="mcp" ventureId={ventureId} kind="mcp" onDone={done} />;
  else body = <ByAddress key="openapi" ventureId={ventureId} kind="openapi" onDone={done} />;
  return (
    <div className="space-y-4">
      {outcome ? (
        <Notice tone={OUTCOME[outcome.key]![1]}>
          {outcome.key === "connected" ? `${outcome.name} ${OUTCOME.connected![0]}` : OUTCOME[outcome.key]![0]}
        </Notice>
      ) : null}
      <Card className="space-y-4 p-4">
        <Tabs items={TABS} value={tab} onChange={setTab} label="App store" />
        <div role="tabpanel">{body}</div>
      </Card>
      <p className="flex items-start gap-2 text-xs text-subtle">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Tokens and sign-ins are stored encrypted with your business’s key. Tools that only read run straight away; anything that changes an app waits for a person’s
        yes. Packages from npm, PyPI or GitHub run only after Kritvia’s team checked that version, in a locked-down sandbox that can reach only the sites approved
          for it. Included in Growth and above.
        </span>
      </p>
    </div>
  );
}
