"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, FolderDown, Mail, MessageCircle, RefreshCw, Trash2, Upload, Webhook } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/field";
import { KeyValue, Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime, formatINR, formatRelative } from "@/lib/format";

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

function WhatsAppDialog({ open, onClose, ventureId, onDone }: { open: boolean; onClose: () => void; ventureId: string; onDone: () => void }) {
  const toast = useToast();
  const [phoneId, setPhoneId] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<Schemas["WhatsAppConnectOut"] | null>(null);
  const m = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/connectors/whatsapp", { params: { path: { venture_id: ventureId } }, body: { phone_number_id: phoneId.trim(), access_token: token.trim() } })),
    onSuccess: (out) => {
      setResult(out);
      setToken("");
      toast.success("WhatsApp connected", out.display_phone_number ?? undefined);
      onDone();
    },
  });
  const close = () => {
    m.reset();
    setResult(null);
    setToken("");
    onClose();
  };
  const valid = /^\d{5,40}$/.test(phoneId.trim()) && token.trim().length >= 20;
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Connect WhatsApp Business"
      description="Customers message your business number; the inbox assistant drafts replies for approval."
      footer={
        result ? (
          <Button variant="primary" onClick={close}>Done</Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={m.isPending} disabled={!valid} onClick={() => m.mutate()}>
              Connect
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <Notice tone="success" title={`Connected ${result.display_phone_number ?? ""}`}>
            {result.verified_name ? `Verified name: ${result.verified_name}. ` : null}The token was checked with Meta and stored encrypted.
          </Notice>
          <p className="text-sm text-muted">Last step, once per Meta app: in Meta for Developers → WhatsApp → Configuration, set the webhook to this URL and subscribe to <code className="font-mono">messages</code>.</p>
          <CopyField label="Webhook URL" value={result.webhook_url} />
          {!result.webhook_ready ? (
            <Notice tone="warning">The server has no WhatsApp app secret yet, so Meta&apos;s webhook will be refused. Ask your administrator to set WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN.</Notice>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <FormError message={m.isError ? errorMessage(m.error) : null} />
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>In Meta Business Manager, add your business number to a WhatsApp Business app.</li>
            <li>Create a system user with the <em>whatsapp_business_messaging</em> permission and generate a permanent token.</li>
            <li>Paste the number&apos;s <strong>phone number id</strong> and that token below. Kritvia checks them with Meta before saving.</li>
          </ol>
          <Field label="Phone number id" hint="A long number from WhatsApp → API setup, not the phone number itself." required>
            <Input value={phoneId} inputMode="numeric" placeholder="123456789012345" onChange={(e) => setPhoneId(e.target.value)} />
          </Field>
          <Field label="Permanent access token" hint="Stored encrypted; never shown again." required>
            <Input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function TallyImportDialog({ open, onClose, ventureId, onDone }: { open: boolean; onClose: () => void; ventureId: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Schemas["TallyImportOut"] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: (f: File) =>
      unwrap(
        api.POST("/ventures/{venture_id}/connectors/tally/import", {
          params: { path: { venture_id: ventureId } },
          body: multipart<Schemas["Body_import_tally_ventures__venture_id__connectors_tally_import_post"]>({ file: f }),
        }),
      ),
    onSuccess: (out) => {
      setResult(out);
      onDone();
    },
  });
  const close = () => {
    m.reset();
    setResult(null);
    setFile(null);
    onClose();
  };
  const owed = result ? Object.entries(result.outstanding) : [];
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Import from Tally"
      description="Export the Day Book (or a ledger) from Tally Prime as XML and upload it here. Re-importing an overlapping period is safe."
      footer={
        result ? (
          <Button variant="primary" onClick={close}>Done</Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={m.isPending} disabled={!file} onClick={() => file && m.mutate(file)}>
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <Notice tone="success" title={`${result.imported} vouchers imported, ${result.updated} updated`}>
            {result.period_from} to {result.period_to}. A summary document was filed in Knowledge, so you can ask questions about it.
          </Notice>
          <KeyValue items={Object.entries(result.by_type).map(([k, v]) => [k, `${v.count} · ${formatINR(String(v.total))}`])} />
          {owed.length ? (
            <div>
              <p className="mb-1 text-[13px] font-medium">Billed minus received in this period</p>
              <ul className="text-sm text-muted">
                {owed.slice(0, 8).map(([p, a]) => (
                  <li key={p} className="flex justify-between gap-3"><span>{p}</span><span className="font-mono">{formatINR(a)}</span></li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <FormError message={m.isError ? errorMessage(m.error) : null} />
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>In Tally Prime: Display More Reports → Day Book, set the period, press <kbd>Alt+E</kbd> → Export.</li>
            <li>Choose <strong>XML (Data Interchange)</strong> and save the file.</li>
            <li>Upload it below. Only dates, parties, amounts and narrations are kept.</li>
          </ol>
          <input ref={input} type="file" accept=".xml,text/xml,application/xml" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="flex items-center gap-3">
            <Button icon={<Upload className="h-4 w-4" />} onClick={() => input.current?.click()}>Choose XML file</Button>
            <span className="text-sm text-muted">{file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "No file chosen"}</span>
          </div>
        </div>
      )}
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
  const [whatsapp, setWhatsapp] = useState(false);
  const [tally, setTally] = useState(false);
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
  const wa = q.data.find((c) => c.provider === "whatsapp");
  const tallyConn = q.data.find((c) => c.provider === "tally");

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

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-subtle" aria-hidden /> WhatsApp Business
            </span>
          }
          description="Customer messages start the inbox assistant; approved replies go out from your number."
          actions={wa ? <StatusBadge status={wa.status} /> : <Badge>not connected</Badge>}
        />
        <div className="space-y-4 p-4">
          {wa ? (
            <KeyValue
              items={[
                ["Number", wa.account_email ?? "—"],
                ["Last error", wa.last_error ? <span className="text-danger">{wa.last_error}</span> : "none"],
                ["Updated", formatRelative(wa.updated_at)],
              ]}
            />
          ) : (
            <p className="text-sm text-muted">Needs a WhatsApp Business (Meta Cloud API) number. Free-form replies are allowed within 24 hours of the customer&apos;s message.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant={wa ? "secondary" : "primary"} disabled={!canAdmin} onClick={() => setWhatsapp(true)}>
              {wa ? "Reconnect" : "Connect WhatsApp"}
            </Button>
            {wa ? (
              <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} disabled={!canAdmin} onClick={() => setRemoving(wa)}>
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <BookOpenCheck className="h-4 w-4 text-subtle" aria-hidden /> Tally
            </span>
          }
          description="Import a Tally XML export so Kritvia can answer questions about sales, purchases and who owes you."
          actions={tallyConn ? <StatusBadge status={tallyConn.status} /> : <Badge>not imported</Badge>}
        />
        <div className="space-y-4 p-4">
          {tallyConn ? (
            <KeyValue items={[["Last import", tallyConn.cursor ?? "—"], ["Updated", formatRelative(tallyConn.updated_at)]]} />
          ) : (
            <p className="text-sm text-muted">Tally has no cloud API; a periodic export keeps Kritvia in step. Nothing is written back to Tally.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant={tallyConn ? "secondary" : "primary"} icon={<Upload className="h-4 w-4" />} disabled={!canAdmin} onClick={() => setTally(true)}>
              {tallyConn ? "Import again" : "Import from Tally"}
            </Button>
          </div>
        </div>
      </Card>

      <WhatsAppDialog open={whatsapp} onClose={() => setWhatsapp(false)} ventureId={ventureId} onDone={() => void qc.invalidateQueries({ queryKey: key })} />
      <TallyImportDialog open={tally} onClose={() => setTally(false)} ventureId={ventureId} onDone={() => void qc.invalidateQueries({ queryKey: key })} />
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
        title={removing?.provider === "google" ? "Disconnect Google?" : removing?.provider === "whatsapp" ? "Disconnect WhatsApp?" : "Remove webhook?"}
        description={
          removing?.provider === "google"
            ? "Gmail polling and sending stop. Stored tokens are deleted."
            : removing?.provider === "whatsapp"
              ? "Incoming WhatsApp messages will be ignored and the stored token deleted."
              : "Submissions to the current URL will be refused."
        }
        confirmLabel="Remove"
      />
    </div>
  );
}
