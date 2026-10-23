"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Send } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Campaign = Schemas["CampaignOut"];
type Channel = Campaign["channel"];
type Audience = Campaign["audience"];

const STATUS: Record<Campaign["status"], { label: string; tone: Tone }> = {
  draft: { label: "draft", tone: "neutral" },
  waiting: { label: "waiting for your yes", tone: "warning" },
  sending: { label: "sending", tone: "info" },
  sent: { label: "sent", tone: "success" },
  rejected: { label: "not sent (your no)", tone: "neutral" },
  cancelled: { label: "stopped", tone: "neutral" },
  failed: { label: "couldn't send", tone: "danger" },
};
const AUDIENCE: Record<Audience, string> = {
  opted_in: "Everyone who agreed to hear from you",
  customers: "Customers (an invoice or a booking)",
  recent_customers: "Customers of the last 90 days",
};

function NewCampaign({ ventureId, onClose }: { ventureId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [audience, setAudience] = useState<Audience>("customers");
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const templates = useQuery({
    queryKey: ["wa-templates", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/whatsapp/templates", { params: { path: { venture_id: ventureId } } })),
    enabled: channel === "whatsapp",
  });
  const usable = (templates.data?.templates ?? []).filter((t) => t.status === "APPROVED" && t.sendable);
  const tpl = usable.find((t) => t.id === templateId);
  const size = useQuery({
    queryKey: ["campaign-audience", ventureId, channel, audience],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/campaigns/audience", { params: { path: { venture_id: ventureId }, query: { channel, audience } } })),
    enabled: !(channel === "email" && audience === "opted_in"),
  });
  // The draft made on the first try. If asking for the yes fails (e.g. the plan's limit), the next try sends
  // that same draft instead of making another one; if the form changed meanwhile, the old draft is removed.
  const made = useRef<{ id: string; key: string } | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const draft =
        channel === "whatsapp"
          ? { name: name.trim(), channel, audience, template_id: templateId, params }
          : { name: name.trim(), channel, audience, subject: subject.trim(), body: body.trim() };
      const key = JSON.stringify(draft);
      if (made.current && made.current.key !== key) {
        const old = made.current.id;
        made.current = null;
        await api.DELETE("/ventures/{venture_id}/campaigns/{campaign_id}", { params: { path: { venture_id: ventureId, campaign_id: old } } }).catch(() => undefined);
      }
      if (!made.current) {
        const c = await unwrap(api.POST("/ventures/{venture_id}/campaigns", { params: { path: { venture_id: ventureId } }, body: draft }));
        made.current = { id: c.id, key };
        void qc.invalidateQueries({ queryKey: ["campaigns", ventureId] });
      }
      const id = made.current.id;
      await unwrap(api.POST("/ventures/{venture_id}/campaigns/{campaign_id}/send", { params: { path: { venture_id: ventureId, campaign_id: id } } }));
      made.current = null;
      return id;
    },
    onSuccess: () => {
      toast.success("Campaign ready", "It waits for your yes with your other drafts, showing exactly how many people get it.");
      void qc.invalidateQueries({ queryKey: ["campaigns", ventureId] });
      onClose();
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const ok = name.trim() && (channel === "whatsapp" ? tpl && params.length === tpl.params && params.every((p) => p.trim()) : subject.trim() && body.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New campaign"
      description="One message to many customers. Only people who agreed to hear from you; never anyone who wrote STOP or unsubscribed."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Send className="h-4 w-4" />} loading={create.isPending} disabled={!ok} onClick={() => create.mutate()}>
            Ask for my yes
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name (for you)" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Diwali offer" />
          </Field>
          <Field label="Send by">
            <Select
              value={channel}
              onChange={(e) => {
                const c = e.target.value as Channel;
                setChannel(c);
                if (c === "email" && audience === "opted_in") setAudience("customers");
              }}
            >
              <option value="whatsapp">WhatsApp (an approved template)</option>
              <option value="email">Email</option>
            </Select>
          </Field>
          <Field label="To" className="sm:col-span-2" hint={size.data ? `${size.data.people} ${size.data.people === 1 ? "person" : "people"}${size.data.capped ? " (the first 2,000)" : ""}` : undefined}>
            <Select value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
              {(Object.keys(AUDIENCE) as Audience[])
                .filter((a) => channel === "whatsapp" || a !== "opted_in")
                .map((a) => (
                  <option key={a} value={a}>
                    {AUDIENCE[a]}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        {channel === "whatsapp" ? (
          <>
            {templates.data && !usable.length ? (
              <Notice tone="info" title="No approved template yet">
                Write one on Chats → Templates (category Marketing). WhatsApp approves it, usually within minutes.
              </Notice>
            ) : null}
            <Field label="Template">
              <Select
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  const t = usable.find((x) => x.id === e.target.value);
                  setParams(Array.from({ length: t?.params ?? 0 }, (_, i) => t?.examples[i] ?? ""));
                }}
              >
                <option value="">Choose…</option>
                {usable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </Select>
            </Field>
            {tpl ? (
              <>
                <p className="rounded-lg bg-surface-2 p-3 text-sm whitespace-pre-line">{tpl.body}</p>
                {params.map((p, i) => (
                  <Field key={i} label={`Fill-in ${i + 1} (the same for everyone)`}>
                    <Input value={p} onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? e.target.value : x)))} maxLength={200} />
                  </Field>
                ))}
              </>
            ) : null}
          </>
        ) : (
          <>
            <Field label="Subject" required>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} />
            </Field>
            <Field label="Message" required hint="Each email starts with the customer's first name and ends with a one-click unsubscribe link.">
              <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
            </Field>
          </>
        )}
        <FormError message={err} />
      </div>
    </Dialog>
  );
}

/** One message to many customers, after one yes. */
export function CampaignsTab({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ["campaigns", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/campaigns", { params: { path: { venture_id: ventureId } } })),
    refetchInterval: (query) => ((query.state.data ?? []).some((c) => c.status === "sending") ? 5000 : false),
  });
  const stop = useMutation({
    mutationFn: (c: Campaign) => unwrap(api.POST("/ventures/{venture_id}/campaigns/{campaign_id}/cancel", { params: { path: { venture_id: ventureId, campaign_id: c.id } } })),
    onSuccess: () => {
      toast.success("Campaign stopped");
      void qc.invalidateQueries({ queryKey: ["campaigns", ventureId] });
    },
    onError: (e) => toast.error("Couldn't stop it", errorMessage(e)),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          The list is fixed when the campaign asks for your yes; exactly those people get it, in batches. Turn on the Campaign ideas agent (Agents page)
          and Kritvia suggests one for each festival and slow fortnight.
        </p>
        {canAdmin ? (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New campaign
          </Button>
        ) : null}
      </div>
      <Card className="overflow-hidden p-0">
        <QueryState query={q} loading={<SkeletonRows rows={3} className="p-3" />}>
          {(d: Campaign[]) =>
            d.length ? (
              <ul className="divide-y divide-border" aria-label="Campaigns">
                {d.map((c) => (
                  <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{c.name}</span>
                      {c.suggested ? <Badge tone="info">suggested by Kritvia</Badge> : null}
                    </span>
                    <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                    <span className="text-xs text-subtle">
                      {c.channel === "whatsapp" ? `WhatsApp · ${c.template ?? "template"}` : `Email · ${c.subject ?? ""}`} · {AUDIENCE[c.audience]}
                      {c.recipients ? ` · ${c.sent} of ${c.recipients} sent${c.failed ? `, ${c.failed} failed` : ""}${c.skipped ? `, ${c.skipped} skipped` : ""}` : ""}
                      {c.sent_at ? ` · ${formatDateTime(c.sent_at)}` : ""}
                    </span>
                    <span className="flex justify-end">
                      {canAdmin && ["draft", "waiting", "sending"].includes(c.status) ? (
                        <Button size="sm" variant="ghost" loading={stop.isPending && stop.variables?.id === c.id} onClick={() => stop.mutate(c)}>
                          Stop
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No campaigns yet" description="Send a festival offer or news to customers who agreed to hear from you." />
            )
          }
        </QueryState>
      </Card>
      {creating ? <NewCampaign ventureId={ventureId} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
