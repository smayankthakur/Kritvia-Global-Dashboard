"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderDown, Mail, RefreshCw, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";

type Connector = Schemas["ConnectorOut"];

export function signingSnippet(url: string): string {
  return `// Node.js: sign and send a lead to Kritvia
import crypto from "node:crypto";

const secret = process.env.KRITVIA_WEBHOOK_SECRET; // whsec_...
const body = JSON.stringify({ name: "Asha Rao", email: "asha@example.com", company: "Rao Foods", message: "Need a new website" });
const ts = Math.floor(Date.now() / 1000).toString();
const signature = "sha256=" + crypto.createHmac("sha256", secret).update(\`\${ts}.\${body}\`).digest("hex");

await fetch("${url}", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Kritvia-Timestamp": ts, "X-Kritvia-Signature": signature },
  body,
});`;
}

function DriveImportDialog({ open, onClose, ventureId }: { open: boolean; onClose: () => void; ventureId: string }) {
  const toast = useToast();
  const [query, setQuery] = useState("trashed = false and (mimeType contains 'document' or mimeType = 'application/pdf')");
  const [max, setMax] = useState("20");
  const m = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/connectors/google/drive-import", { params: { path: { venture_id: ventureId } }, body: { query, max_files: Number(max) } })),
    onSuccess: (out) => toast.success("Drive import finished", `${out.imported} imported, ${out.skipped} already present`),
  });
  return (
    <Dialog
      open={open}
      onClose={() => {
        m.reset();
        onClose();
      }}
      title="Import from Google Drive"
      description="Pull proposals, SOPs and templates into the knowledge base."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()} disabled={!(Number(max) >= 1 && Number(max) <= 100)}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormError message={m.isError ? errorMessage(m.error) : null} />
        <Field label="Drive search query" hint="Google Drive query syntax">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={500} className="font-mono text-xs" />
        </Field>
        <Field label="Maximum files" hint="1–100">
          <Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} className="w-24" />
        </Field>
        {m.data ? (
          <Notice tone={m.data.warnings.length ? "warning" : "success"} title={`${m.data.imported} imported · ${m.data.skipped} skipped`}>
            {m.data.warnings.length ? (
              <ul className="list-disc pl-4 text-xs">
                {m.data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : (
              "No problems."
            )}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}

export function ConnectorSettings({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["connectors", ventureId];
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors", { params: { path: { venture_id: ventureId } } })) });
  const [secret, setSecret] = useState<Schemas["WebhookOut"] | null>(null);
  const [drive, setDrive] = useState(false);
  const [removing, setRemoving] = useState<Connector | null>(null);

  const connect = useMutation({
    // Through the BFF route so the flow is bound to this browser (nonce cookie) — see lib/bff/oauth.ts
    mutationFn: async () => {
      const res = await fetch("/api/oauth/google/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venture_id: ventureId }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; detail?: string };
      if (!res.ok || !body.url) throw new Error(body.detail ?? `HTTP ${res.status}`);
      return body as { url: string };
    },
    onSuccess: (out) => window.location.assign(out.url),
    onError: (e) => toast.error("Can't connect Google", errorMessage(e)),
  });
  const sync = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/connectors/google/sync", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (out) => {
      const n = Object.values(out.started).reduce((a, b) => a + b, 0);
      toast.success("Gmail checked", n ? `${n} new run(s) started` : "No new messages");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Sync failed", errorMessage(e)),
  });
  const webhook = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/connectors/webhook", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (out) => {
      setSecret(out);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Could not create webhook", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/connectors/{connector_id}", { params: { path: { venture_id: ventureId, connector_id: id } } })),
    onSuccess: () => {
      toast.success("Connector removed");
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error("Could not remove", errorMessage(e)),
  });

  if (q.isPending) return <SkeletonRows />;
  if (q.isError) return <ErrorState error={q.error} />;
  const google = q.data.find((c) => c.provider === "google");
  const hook = q.data.find((c) => c.provider === "webhook");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {!canAdmin ? (
        <Notice tone="info" className="lg:col-span-2">
          Only a venture admin or owner can manage connectors.
        </Notice>
      ) : null}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-subtle" aria-hidden /> Google Workspace
            </span>
          }
          description="Gmail inquiries in, approved emails and calendar invites out, Drive into knowledge."
          actions={google ? <StatusBadge status={google.status} /> : <Badge>not connected</Badge>}
        />
        <div className="space-y-4 p-4">
          {google ? (
            <KeyValue
              items={[
                ["Account", google.account_email ?? "—"],
                ["Scopes", <span key="s" className="flex flex-wrap gap-1">{google.scopes.map((s) => <Badge key={s} className="font-mono">{s.replace("https://www.googleapis.com/auth/", "")}</Badge>)}</span>],
                ["Sync cursor", google.cursor ? <span className="font-mono text-xs">{google.cursor}</span> : "—"],
                ["Last error", google.last_error ? <span className="text-danger">{google.last_error}</span> : "none"],
                ["Updated", formatRelative(google.updated_at)],
              ]}
            />
          ) : (
            <p className="text-sm text-muted">Connect the mailbox this venture sends from. Nothing is sent without approval.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant={google ? "secondary" : "primary"} disabled={!canAdmin} loading={connect.isPending} onClick={() => connect.mutate()}>
              {google ? "Reconnect" : "Connect Google"}
            </Button>
            {google ? (
              <>
                <Button icon={<RefreshCw className="h-4 w-4" />} disabled={!canAdmin} loading={sync.isPending} onClick={() => sync.mutate()}>
                  Sync now
                </Button>
                <Button icon={<FolderDown className="h-4 w-4" />} disabled={!canAdmin} onClick={() => setDrive(true)}>
                  Import from Drive
                </Button>
                <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} disabled={!canAdmin} onClick={() => setRemoving(google)}>
                  Disconnect
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Webhook className="h-4 w-4 text-subtle" aria-hidden /> Lead-form webhook
            </span>
          }
          description="Your website's contact form posts here; each submission starts lead triage."
          actions={hook ? <StatusBadge status={hook.status} /> : <Badge>not set up</Badge>}
        />
        <div className="space-y-4 p-4">
          {hook?.webhook_url ? <CopyField label="Endpoint" value={hook.webhook_url} /> : null}
          {hook ? <p className="text-xs text-subtle">Created {formatDateTime(hook.created_at)}. The secret is shown only when created or rotated.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant={hook ? "secondary" : "primary"} disabled={!canAdmin} loading={webhook.isPending} onClick={() => webhook.mutate()}>
              {hook ? "Rotate secret" : "Create webhook"}
            </Button>
            {hook ? (
              <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} disabled={!canAdmin} onClick={() => setRemoving(hook)}>
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <Dialog
        open={Boolean(secret)}
        onClose={() => setSecret(null)}
        size="lg"
        title="Webhook ready"
        description="Copy the secret now — it will not be shown again. Rotating it invalidates the old one."
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            I&apos;ve stored the secret
          </Button>
        }
      >
        {secret ? (
          <div className="space-y-4">
            <CopyField label="Endpoint URL" value={secret.url} />
            <CopyField label="Signing secret" value={secret.secret} secret />
            <div>
              <p className="mb-1.5 text-[13px] font-medium">How to sign requests</p>
              <p className="mb-2 text-xs text-muted">
                Send <code className="font-mono">X-Kritvia-Timestamp</code> (unix seconds) and{" "}
                <code className="font-mono">X-Kritvia-Signature: sha256=HMAC(secret, &quot;&lt;ts&gt;.&lt;body&gt;&quot;)</code>. Requests older than 5 minutes are refused.
              </p>
              <pre className="max-h-72 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-5">{signingSnippet(secret.url)}</pre>
            </div>
          </div>
        ) : null}
      </Dialog>
      <DriveImportDialog open={drive} onClose={() => setDrive(false)} ventureId={ventureId} />
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing.id)}
        loading={remove.isPending}
        title={removing?.provider === "google" ? "Disconnect Google?" : "Remove webhook?"}
        description={removing?.provider === "google" ? "Gmail polling and sending stop. Stored tokens are deleted." : "Submissions to the current URL will be refused."}
        confirmLabel="Remove"
      />
    </div>
  );
}
