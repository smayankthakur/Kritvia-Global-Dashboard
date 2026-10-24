"use client";

import { csrfHeaders } from "@/lib/bff/csrf";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, BookOpenCheck, FolderDown, Forward, Mail, MessageCircle, RefreshCw, Send, Store, Trash2, Upload, Webhook } from "lucide-react";
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
import { ConnectVideo } from "@/components/settings/how-to-video";
import { GstCard } from "@/components/settings/gst";
import { PaymentsCard } from "@/components/settings/payments";
import { approverLinksKey } from "@/components/account/chat-approvals";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime, formatINR, formatRelative } from "@/lib/format";

const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";

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
  const [tally, setTally] = useState(false);
  const [removing, setRemoving] = useState<Connector | null>(null);

  const connect = useMutation({
    // Through the BFF route so the flow is bound to this browser (nonce cookie) — see lib/bff/oauth.ts
    mutationFn: async () => {
      const res = await fetch("/api/oauth/google/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
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

  const hasGoogle = Boolean(q.data?.some((c) => c.provider === "google"));
  const picker = useQuery({
    queryKey: ["drive-picker", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors/google/picker", { params: { path: { venture_id: ventureId } } })),
    enabled: hasGoogle && canAdmin,
  });

  if (q.isPending) return <SkeletonRows />;
  if (q.isError) return <ErrorState error={q.error} />;
  const google = q.data.find((c) => c.provider === "google");
  const hook = q.data.find((c) => c.provider === "webhook");
  const wa = q.data.find((c) => c.provider === "whatsapp");
  const tallyConn = q.data.find((c) => c.provider === "tally");
  const tg = q.data.find((c) => c.provider === "telegram");
  const slack = q.data.find((c) => c.provider === "slack");
  const indiamart = q.data.find((c) => c.provider === "indiamart");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-wrap items-center justify-between gap-2 lg:col-span-2">
        <p className="text-sm text-muted">Connect the tools your business already uses. Nothing is sent without your approval unless you switch on automatic replies.</p>
        <ConnectVideo />
      </div>
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
          description={
            google && !google.scopes.includes(GMAIL_READ)
              ? "Approved emails and calendar invites go out from this account; incoming mail arrives by forwarding (below). Drive files you choose go into business memory."
              : "Gmail inquiries in, approved emails and calendar invites out, Drive into knowledge."
          }
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
            <p className="text-sm text-muted">Connect the mailbox this venture sends from. Nothing is sent without approval unless you switch on automatic replies.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant={google ? "secondary" : "primary"} disabled={!canAdmin} loading={connect.isPending} onClick={() => connect.mutate()}>
              {google ? "Reconnect" : "Connect Google"}
            </Button>
            {google ? (
              <>
                {google.scopes.includes(GMAIL_READ) ? (
                  <Button icon={<RefreshCw className="h-4 w-4" />} disabled={!canAdmin} loading={sync.isPending} onClick={() => sync.mutate()}>
                    Sync now
                  </Button>
                ) : null}
                {picker.data?.ready ? (
                  // A full page load: only the picker page's policy lets Google's picker run (lib/csp.ts).
                  <Button icon={<FolderDown className="h-4 w-4" />} disabled={!canAdmin} onClick={() => window.location.assign(`/v/${ventureId}/drive-picker`)}>
                    Choose files from Drive
                  </Button>
                ) : picker.data?.full_drive ? (
                  <Button icon={<FolderDown className="h-4 w-4" />} disabled={!canAdmin} onClick={() => setDrive(true)}>
                    Import from Drive
                  </Button>
                ) : null}
                <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} disabled={!canAdmin} onClick={() => setRemoving(google)}>
                  Disconnect
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </Card>
      <ForwardingCard ventureId={ventureId} canAdmin={canAdmin} canSend={google?.status === "active"} />
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
            <p className="text-sm text-muted">Log in with Facebook and pick your business number; it takes about 2 minutes. Already on the WhatsApp Business app? You can keep using it.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {/* A full page load: only that page may run Meta's signup window (lib/csp.ts). */}
            <Button variant={wa ? "secondary" : "primary"} disabled={!canAdmin} onClick={() => window.location.assign(`/v/${ventureId}/whatsapp-connect`)}>
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
      <TelegramCard ventureId={ventureId} canAdmin={canAdmin} bot={tg} onRemove={() => tg && setRemoving(tg)} onChanged={() => void qc.invalidateQueries({ queryKey: key })} />
      <SlackCard ventureId={ventureId} canAdmin={canAdmin} conn={slack} onRemove={() => slack && setRemoving(slack)} onChanged={() => void qc.invalidateQueries({ queryKey: key })} />
      <IndiaMartCard ventureId={ventureId} canAdmin={canAdmin} conn={indiamart} onRemove={() => indiamart && setRemoving(indiamart)} onChanged={() => void qc.invalidateQueries({ queryKey: key })} />
      <PaymentsCard ventureId={ventureId} />
      <GstCard ventureId={ventureId} />
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
        title={
          removing?.provider === "google"
            ? "Disconnect Google?"
            : removing?.provider === "whatsapp"
              ? "Disconnect WhatsApp?"
              : removing?.provider === "telegram"
                ? "Disconnect the Telegram bot?"
                : removing?.provider === "slack"
                  ? "Disconnect Slack?"
                  : "Remove webhook?"
        }
        description={
          removing?.provider === "google"
            ? "Gmail polling and sending stop. Stored tokens are deleted."
            : removing?.provider === "whatsapp"
              ? "Incoming WhatsApp messages will be ignored and the stored token deleted."
              : removing?.provider === "telegram"
                ? "The bot stops sending messages to Kritvia and its token is deleted. Its chats stay on the Chats page."
                : removing?.provider === "slack"
                  ? "Kritvia stops posting to the channel and the stored address is deleted."
                  : "Submissions to the current URL will be refused."
        }
        confirmLabel="Remove"
      />
    </div>
  );
}


/** The business's Telegram bot: customers chat with it, Kritvia drafts the replies. */
function TelegramCard({ ventureId, canAdmin, bot, onRemove, onChanged }: {
  ventureId: string;
  canAdmin: boolean;
  bot: Connector | undefined;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/connectors/telegram", { params: { path: { venture_id: ventureId } }, body: { token: token.trim() } })),
    onSuccess: (out) => {
      setOpen(false);
      setToken("");
      setError(null);
      toast.success(`@${out.username} is connected`, "Customers who message it will appear on the Chats page.");
      onChanged();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const username = bot?.account_email?.replace(/^@/, "") ?? "";
  const close = () => {
    setOpen(false);
    setToken("");
    setError(null);
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Send className="h-4 w-4 text-subtle" aria-hidden /> Telegram bot
          </span>
        }
        description="Customers chat with your business's bot; Kritvia drafts the replies and your team approves or answers them on the Chats page."
        actions={bot ? <StatusBadge status={bot.status} /> : <Badge>not connected</Badge>}
      />
      <div className="space-y-4 p-4">
        {bot ? (
          <>
            <CopyField label="Link for customers" value={`https://t.me/${username}`} />
            <KeyValue
              items={[
                ["Bot", bot.account_email ?? "—"],
                ["Updated", formatRelative(bot.updated_at)],
              ]}
            />
          </>
        ) : (
          <p className="text-sm text-muted">Make a free bot with Telegram&apos;s @BotFather (about a minute), then paste its token here.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant={bot ? "secondary" : "primary"} disabled={!canAdmin} onClick={() => setOpen(true)}>
            {bot ? "Change bot" : "Connect a bot"}
          </Button>
          {bot ? (
            <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} disabled={!canAdmin} onClick={onRemove}>
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title="Connect a Telegram bot"
        description="Kritvia checks the token with Telegram and stores it encrypted; it is never shown again."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={connect.isPending} onClick={() => (token.trim() ? connect.mutate() : setError("Paste the bot's token first."))}>
              Connect
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) connect.mutate();
            else setError("Paste the bot's token first.");
          }}
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>
              In Telegram, open{" "}
              <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                @BotFather
              </a>{" "}
              and send <code className="font-mono">/newbot</code>.
            </li>
            <li>Give it your business&apos;s name, then a username ending in &ldquo;bot&rdquo;.</li>
            <li>BotFather replies with a token like <code className="font-mono">123456789:AA…</code>. Paste it below.</li>
          </ol>
          <Field label="Bot token" required>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={120}
              className="font-mono"
            />
          </Field>
          <FormError message={error} />
          <button type="submit" hidden />
        </form>
      </Dialog>
    </Card>
  );
}

/** The team's Slack channel hears when a draft waits for a yes or a chat needs a person. */
function SlackCard({ ventureId, canAdmin, conn, onRemove, onChanged }: {
  ventureId: string;
  canAdmin: boolean;
  conn: Connector | undefined;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [channel, setChannel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setUrl("");
    setChannel("");
    setError(null);
  };
  const connect = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/connectors/slack", {
          params: { path: { venture_id: ventureId } },
          body: { webhook_url: url.trim(), channel: channel.trim() || null },
        }),
      ),
    onSuccess: (out) => {
      close();
      toast.success("Slack is connected", `Kritvia posted a hello in ${out.channel ?? "the channel"}.`);
      onChanged();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (!url.trim().startsWith("https://hooks.slack.com/services/")) return setError("Paste the address Slack gives, starting https://hooks.slack.com/services/.");
    connect.mutate();
  };
  const links = useQuery({
    queryKey: approverLinksKey(ventureId),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/approver-links", { params: { path: { venture_id: ventureId } } })),
  });
  const appAvailable = Boolean(links.data?.slack_available);
  const appAdded = Boolean(links.data?.slack_app);
  // Through the BFF route so the flow is bound to this browser (nonce cookie), like Google.
  const install = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/oauth/slack/start", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ venture_id: ventureId }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; detail?: string };
      if (!res.ok || !body.url) throw new Error(body.detail ?? `HTTP ${res.status}`);
      return body as { url: string };
    },
    onSuccess: (out) => window.location.assign(out.url),
    onError: (e) => toast.error("Can't add Kritvia to Slack", errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <BellRing className="h-4 w-4 text-subtle" aria-hidden /> Slack
          </span>
        }
        description={
          appAvailable
            ? "Add Kritvia to Slack: team members get drafts that need their yes as DMs with Approve, Reject and Ask for changes, and a channel you pick hears when a chat needs a person."
            : "Your team's channel hears when a draft waits for a yes or a customer chat needs a person, with a link to open it. Never what a customer wrote."
        }
        actions={conn ? <StatusBadge status={conn.status} /> : <Badge>not connected</Badge>}
      />
      <div className="space-y-4 p-4">
        {conn ? (
          <KeyValue
            items={[
              ["Channel", conn.account_email ?? "—"],
              ["Last error", conn.last_error ? <span className="text-danger">{conn.last_error}</span> : "none"],
              ["Updated", formatRelative(conn.updated_at)],
            ]}
          />
        ) : (
          <p className="text-sm text-muted">
            {appAvailable
              ? "Add Kritvia to your Slack workspace and pick a channel. Or, for channel notices only, paste an Incoming Webhooks address."
              : "Add Slack's Incoming Webhooks app to a channel and paste the address it gives you."}
          </p>
        )}
        {appAdded ? (
          <p className="text-sm text-muted">
            Kritvia is in your Slack. Each team member links their own Slack under Your account → Approve from your phone.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {appAvailable ? (
            <Button variant={appAdded ? "secondary" : "primary"} disabled={!canAdmin} loading={install.isPending} onClick={() => install.mutate()}>
              {appAdded ? "Add to Slack again" : "Add to Slack"}
            </Button>
          ) : null}
          <Button variant={conn || appAvailable ? "secondary" : "primary"} disabled={!canAdmin} onClick={() => setOpen(true)}>
            {appAvailable ? "Paste a webhook instead" : conn ? "Change channel" : "Connect Slack"}
          </Button>
          {conn ? (
            <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} disabled={!canAdmin} onClick={onRemove}>
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title="Connect a Slack channel"
        description="Kritvia posts a hello to check the address, then stores it encrypted."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={connect.isPending} onClick={submit}>
              Connect
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>
              In Slack, add the{" "}
              <a href="https://slack.com/apps/A0F7XDUAZ-incoming-webhooks" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                Incoming Webhooks
              </a>{" "}
              app and pick the channel your team watches.
            </li>
            <li>Copy the Webhook URL it shows and paste it below.</li>
          </ol>
          <Field label="Webhook URL" required>
            <Input type="password" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} maxLength={300} className="font-mono" />
          </Field>
          <Field label="Channel name" hint="Only to show here, e.g. #sales">
            <Input value={channel} onChange={(e) => setChannel(e.target.value)} maxLength={80} />
          </Field>
          <FormError message={error} />
          <button type="submit" hidden />
        </form>
      </Dialog>
    </Card>
  );
}

/** IndiaMART: enquiries come in by themselves through the Lead Manager Pull API. */
function IndiaMartCard({ ventureId, canAdmin, conn, onRemove, onChanged }: {
  ventureId: string;
  canAdmin: boolean;
  conn: Connector | undefined;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setKey("");
    setError(null);
  };
  const connect = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/connectors/indiamart", { params: { path: { venture_id: ventureId } }, body: { key: key.trim() } })),
    onSuccess: (out) => {
      close();
      toast.success(
        "IndiaMART is connected",
        out.enquiries ? `${out.enquiries} enquiries from the last 24 hours went to Lead triage.` : "New enquiries will arrive as leads within about 10 minutes.",
      );
      onChanged();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    if (key.trim().length < 16) return setError("Paste the whole key IndiaMART shows under Pull API.");
    connect.mutate();
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Store className="h-4 w-4 text-subtle" aria-hidden /> IndiaMART
          </span>
        }
        description="Every IndiaMART enquiry, buy-lead and call becomes a lead by itself: scored, filed and with a reply drafted for your yes."
        actions={conn ? <StatusBadge status={conn.status} /> : <Badge>not connected</Badge>}
      />
      <div className="space-y-4 p-4">
        {conn ? (
          <KeyValue
            items={[
              ["Checked up to", conn.cursor ? formatDateTime(conn.cursor) : "—"],
              ["Last error", conn.last_error ? <span className="text-danger">{conn.last_error}</span> : "none"],
              ["Updated", formatRelative(conn.updated_at)],
            ]}
          />
        ) : (
          <p className="text-sm text-muted">Paste your Lead Manager Pull API key. Kritvia checks for new enquiries every 10 minutes.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant={conn ? "secondary" : "primary"} disabled={!canAdmin} onClick={() => setOpen(true)}>
            {conn ? "Change key" : "Connect IndiaMART"}
          </Button>
          {conn ? (
            <Button variant="ghost" className="text-danger" icon={<Trash2 className="h-4 w-4" />} disabled={!canAdmin} onClick={onRemove}>
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title="Connect IndiaMART"
        description="Kritvia checks the key with IndiaMART, then stores it encrypted. It is never shown again."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" loading={connect.isPending} onClick={submit}>
              Connect
            </Button>
          </>
        }
      >
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>
              Open{" "}
              <a href="https://seller.indiamart.com/leadmanager/crmapi" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                Lead Manager → Pull API
              </a>{" "}
              in IndiaMART and click Generate Key.
            </li>
            <li>Copy the key and paste it below. A key stops working if it isn&apos;t used for 7 days, so keep it connected.</li>
          </ol>
          <Field label="Pull API key" required>
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} maxLength={200} className="font-mono" />
          </Field>
          <FormError message={error} />
          <button type="submit" hidden />
        </form>
      </Dialog>
    </Card>
  );
}

/** Incoming mail by forwarding to the business's own Kritvia address (no Gmail read access needed). */
function ForwardingCard({ ventureId, canAdmin, canSend }: { ventureId: string; canAdmin: boolean; canSend: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["email-forwarding", ventureId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors/email-forwarding", { params: { path: { venture_id: ventureId } } })),
    refetchInterval: (query) =>
      query.state.data && !query.state.data.gmail_code && !query.state.data.gmail_link && !query.state.data.last_mail_at ? 15_000 : false,
  });
  const [confirmNew, setConfirmNew] = useState(false);
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/connectors/email-forwarding", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (d) => {
      setConfirmNew(false);
      qc.setQueryData(key, d);
      void qc.invalidateQueries({ queryKey: ["connectors", ventureId] });
      toast.success("Forwarding address ready", "Now add it in your mailbox's forwarding settings.");
    },
    onError: (e) => toast.error("Couldn't set up forwarding", errorMessage(e)),
  });
  const f = q.data;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Forward className="h-4 w-4 text-subtle" aria-hidden /> Email forwarding
          </span>
        }
        description={
          // Forwarding only brings mail in; replies go out only through a connected Google account (round 3, A1).
          canSend
            ? "Forward your business mail to Kritvia so the Inbox assistant can answer it. Kritvia never gets access to your mailbox; replies still go out from your own Gmail after you approve them."
            : "Forward your business mail to Kritvia so the Inbox assistant can draft answers. Forwarding only brings mail in: to send replies from Kritvia, connect Google above. Until then, copy each reply into your own mailbox."
        }
        actions={f ? <Badge tone="success">on</Badge> : <Badge>off</Badge>}
      />
      <div className="space-y-3 p-4">
        {q.isError ? <p className="text-sm text-muted">{errorMessage(q.error)}</p> : null}
        {f ? (
          <>
            <CopyField label="Your forwarding address" value={f.address} />
            {f.last_mail_at && !f.gmail_link && !f.gmail_code ? (
              <Notice tone="success" title="Forwarding works">
                The last email arrived {formatRelative(f.last_mail_at)}
                {f.forwarded_from ? <> from {f.forwarded_from}</> : null}.
                {f.gmail_reads_it
                  ? " Gmail is connected for this mailbox too, so Kritvia reads each email once; forwarded copies only add bills, CVs and bank statements."
                  : null}
              </Notice>
            ) : null}
            {f.gmail_link ? (
              <Notice tone="success" title={`Gmail asks you to confirm forwarding from ${f.gmail_mailbox || "your mailbox"}`}>
                Only if that is your own mailbox: open Google&apos;s confirmation page and press Confirm. Then, in Gmail&apos;s Forwarding settings,
                choose &ldquo;Forward a copy of incoming mail&rdquo; and Save.
                <div className="mt-2">
                  <a
                    className="text-sm font-medium text-accent underline underline-offset-2"
                    href={f.gmail_link}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Confirm in Gmail
                  </a>
                </div>
              </Notice>
            ) : f.gmail_code ? (
              <Notice tone="success">
                Gmail sent a confirmation code for {f.gmail_mailbox || "your mailbox"}: <strong className="font-mono">{f.gmail_code}</strong>. Enter it in Gmail to finish.
              </Notice>
            ) : null}
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>In Gmail, open Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding address.</li>
              <li>Paste the address above. Gmail sends a confirmation (a link or a code); it appears here within a minute.</li>
              <li>Confirm it, then choose &ldquo;Forward a copy of incoming mail&rdquo; and keep Gmail&apos;s copy. Save.</li>
            </ol>
            <p className="text-xs text-subtle">
              Outlook, Zoho Mail and others work too: add a rule that forwards incoming mail to this address. Forwarded mail can&apos;t be checked for who
              really sent it, so loan documents and sales reports still need Gmail connected.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">Get an address for this business, then set your mailbox to forward to it.</p>
        )}
        <Button
          variant={f ? "ghost" : "primary"}
          disabled={!canAdmin}
          loading={create.isPending && !confirmNew}
          onClick={() => (f ? setConfirmNew(true) : create.mutate())}
        >
          {f ? "Get a new address" : "Set up forwarding"}
        </Button>
        {f ? <p className="text-xs text-subtle">A new address stops the old one working.</p> : null}
        <ConfirmDialog
          open={confirmNew}
          onClose={() => setConfirmNew(false)}
          onConfirm={() => create.mutate()}
          loading={create.isPending}
          title="Get a new forwarding address?"
          description="The current address stops working straight away. Mail your mailbox forwards to it will no longer reach Kritvia until you put the new address in your mailbox's forwarding settings."
          confirmLabel="Get a new address"
        />
      </div>
    </Card>
  );
}
