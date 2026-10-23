"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Mail, MessageCircle, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type Link = Schemas["ApproverLinkOut"];

export const approverLinksKey = (ventureId: string) => ["approver-links", ventureId] as const;

export const CHANNEL_NAME: Record<string, string> = { telegram: "Telegram", slack: "Slack", whatsapp: "WhatsApp" };
export const askAddressKey = (ventureId: string) => ["ask-address", ventureId] as const;

/** "Ask Kritvia from anywhere": link your Telegram chat, WhatsApp number or Slack account to one business, or make a private
 * email address for it. Drafts that need your yes arrive in the chats; in all four you can ask the business anything and get
 * the answer from its records (the front door). */
export function ChatApprovals({ ventureId, ventureName }: { ventureId: string; ventureName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = approverLinksKey(ventureId);
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/approver-links", { params: { path: { venture_id: ventureId } } })),
  });
  const ask = useQuery({
    queryKey: askAddressKey(ventureId),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/ask-address", { params: { path: { venture_id: ventureId } } })),
  });
  const [shownAddress, setShownAddress] = useState<string | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const makeAddress = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/ask-address", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (out) => {
      setShownAddress(out.address ?? null);
      setConfirmNew(false);
      void qc.invalidateQueries({ queryKey: askAddressKey(ventureId) });
    },
    onError: (e) => toast.error("Can't make an address", errorMessage(e)),
  });
  const removeAddress = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/ask-address", { params: { path: { venture_id: ventureId } } })),
    onSuccess: () => {
      setShownAddress(null);
      toast.success("Address removed", "Mail to it is no longer answered.");
      void qc.invalidateQueries({ queryKey: askAddressKey(ventureId) });
    },
    onError: (e) => toast.error("Can't remove it", errorMessage(e)),
  });
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [waLink, setWaLink] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const telegram = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/approver-links/telegram", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (out) => setTgLink(out.link),
    onError: (e) => toast.error("Can't link Telegram", errorMessage(e)),
  });
  const whatsapp = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/approver-links/whatsapp", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (out) => setWaLink(out.link),
    onError: (e) => toast.error("Can't link WhatsApp", errorMessage(e)),
  });
  const slack = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/approver-links/slack", { params: { path: { venture_id: ventureId } } })),
    onSuccess: () => toast.success("Check Slack", "Kritvia sent you a message with a Link button. Press it within 15 minutes."),
    onError: (e) => toast.error("Can't link Slack", errorMessage(e)),
  });
  const unlink = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/ventures/{venture_id}/approver-links/{link_id}", { params: { path: { venture_id: ventureId, link_id: id } } })),
    onSuccess: () => {
      toast.success("Unlinked", "Drafts no longer go there.");
      refresh();
    },
    onError: (e) => toast.error("Can't unlink", errorMessage(e)),
  });

  const header = (
    <CardHeader
      title={
        <span className="flex items-center gap-2">
          <BellRing className="h-4 w-4 text-subtle" aria-hidden /> Ask Kritvia from anywhere
        </span>
      }
      description={`Ask ${ventureName} anything from WhatsApp, Telegram, Slack or email, and get the answer from its own records: money in, who owes what, bookings, leads. Drafts that need your yes arrive in the chats with Approve, Reject and Ask for changes. You act as yourself, with the same rights as here.`}
    />
  );
  if (q.isLoading) {
    return (
      <Card>
        {header}
        <SkeletonRows rows={2} />
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card>
        {header}
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </Card>
    );
  }
  const d = q.data;
  const mine = (channel: string): Link | undefined => d.links.find((l) => l.mine && l.channel === channel);
  const others = d.links.filter((l) => !l.mine);

  const row = (channel: "telegram" | "whatsapp" | "slack", available: boolean, missing: string, link: () => void, pending: boolean) => {
    const linked = mine(channel);
    return (
      <li className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-fg">
            {CHANNEL_NAME[channel]}
            {linked ? <Badge tone="success" dot>linked</Badge> : null}
          </p>
          <p className="text-xs text-muted">
            {linked
              ? `${linked.label ?? CHANNEL_NAME[channel]} · since ${formatRelative(linked.created_at)}` +
                (channel === "slack" ? ". Ask by messaging the Kritvia app directly, or mention it in a channel." : "")
              : available
                ? channel === "telegram"
                  ? `Through ${d.telegram_bot}, the business's bot.`
                  : channel === "whatsapp"
                    ? `Send a one-time code from your phone to ${d.whatsapp_number}, the business's number.`
                    : "Kritvia messages the Slack member with your email address to confirm it's you."
                : missing}
          </p>
        </div>
        {linked ? (
          <Button variant="ghost" size="sm" className="text-danger" icon={<Trash2 className="h-4 w-4" />} loading={unlink.isPending} onClick={() => unlink.mutate(linked.id)}>
            Unlink
          </Button>
        ) : (
          <Button size="sm" disabled={!available} loading={pending} onClick={link}>
            Link {CHANNEL_NAME[channel]}
          </Button>
        )}
      </li>
    );
  };

  return (
    <Card>
      {header}
      <div className="p-4">
        <ul className="divide-y divide-border">
          {row("telegram", Boolean(d.telegram_bot), "Connect the business's Telegram bot first (Settings → Connectors).", () => telegram.mutate(), telegram.isPending)}
          {row(
            "whatsapp",
            Boolean(d.whatsapp_number),
            "Connect the business's WhatsApp number first (Settings → Connectors).",
            () => whatsapp.mutate(),
            whatsapp.isPending,
          )}
          {row(
            "slack",
            d.slack_app,
            d.slack_available ? "An admin adds Kritvia to Slack first (Settings → Connectors)." : "Not available on this server yet.",
            () => slack.mutate(),
            slack.isPending,
          )}
          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-fg">
                Email
                {ask.data?.exists ? <Badge tone="success" dot>on</Badge> : null}
              </p>
              <p className="text-xs text-muted">
                {!ask.data
                  ? "…"
                  : !ask.data.available
                    ? "Not available on this server yet."
                    : ask.data.exists
                      ? `Your private address ends in …${ask.data.hint}` +
                        (ask.data.last_used_at ? `, last used ${formatRelative(ask.data.last_used_at)}.` : ". Not used yet.")
                      : "A private address only for you. Only mail from your own address is answered, and the answer comes back to it."}
              </p>
            </div>
            {ask.data?.available ? (
              ask.data.exists ? (
                <div className="flex gap-2">
                  <Button size="sm" loading={makeAddress.isPending} onClick={() => setConfirmNew(true)}>
                    New address
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    icon={<Trash2 className="h-4 w-4" />}
                    loading={removeAddress.isPending}
                    onClick={() => removeAddress.mutate()}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <Button size="sm" icon={<Mail className="h-4 w-4" />} loading={makeAddress.isPending} onClick={() => makeAddress.mutate()}>
                  Make my address
                </Button>
              )
            ) : null}
          </li>
        </ul>
        {shownAddress ? (
          <div className="mt-3 space-y-2 rounded-md border border-border bg-surface-2 p-3 text-sm">
            <CopyField value={shownAddress} label="Your ask address" />
            <p className="text-muted">
              Save it as a contact. Kritvia shows it only now. Email it from {ask.data?.your_email ?? "your own address"}, with your question in the subject
              or the message; the answer comes back by email. Mail from any other address is ignored.
            </p>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirmNew}
          onClose={() => setConfirmNew(false)}
          onConfirm={() => makeAddress.mutate()}
          loading={makeAddress.isPending}
          title="Make a new address?"
          description="The old address stops working at once."
          confirmLabel="Make a new one"
          cancelLabel="Keep the old one"
        />
        {tgLink && !mine("telegram") ? (
          <div className="mt-3 rounded-md border border-border bg-surface-2 p-3 text-sm">
            <p className="text-fg">Open this on the phone that has Telegram and tap Start. It works once, for 15 minutes.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a className="inline-flex items-center gap-2 font-medium text-accent underline" href={tgLink} target="_blank" rel="noreferrer">
                <Send className="h-4 w-4" aria-hidden /> Open Telegram
              </a>
              <Button variant="ghost" size="sm" onClick={refresh}>
                I tapped Start
              </Button>
            </div>
          </div>
        ) : null}
        {waLink && !mine("whatsapp") ? (
          <div className="mt-3 rounded-md border border-border bg-surface-2 p-3 text-sm">
            <p className="text-fg">Open this on your phone: WhatsApp opens a chat with the business&apos;s number with the code typed in. Send it. It works once, for 15 minutes.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a className="inline-flex items-center gap-2 font-medium text-accent underline" href={waLink} target="_blank" rel="noreferrer">
                <MessageCircle className="h-4 w-4" aria-hidden /> Open WhatsApp
              </a>
              <Button variant="ghost" size="sm" onClick={refresh}>
                I sent it
              </Button>
            </div>
          </div>
        ) : null}
        {mine("telegram") || mine("whatsapp") || mine("slack") || ask.data?.exists ? (
          <div className="mt-4 rounded-md border border-border p-3 text-sm">
            <p className="font-medium text-fg">Run the business from anywhere</p>
            <p className="mt-1 text-muted">
              Ask anything in Hindi, Hinglish or English: &quot;Is hafte kitna paisa aaya?&quot;, &quot;Kaun baaki hai?&quot;, &quot;Aaj ki bookings&quot;, &quot;Priya ko
              follow-up bhejo&quot;. The answer comes back where you asked, with the actual names and amounts; anything that sends or changes something arrives as a
              draft for your yes. Quick: /today, /week, /waiting, /help. Voice notes work in Telegram and WhatsApp.
            </p>
          </div>
        ) : null}
        {others.length ? (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-subtle">Your team</p>
            <ul className="mt-1 divide-y divide-border">
              {others.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {l.person} · {CHANNEL_NAME[l.channel] ?? l.channel}
                    {l.label ? <span className="text-muted"> ({l.label})</span> : null}
                  </span>
                  <Button variant="ghost" size="sm" className="text-danger" onClick={() => unlink.mutate(l.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-subtle">
          Drafts marked sensitive arrive without buttons and are reviewed here. WhatsApp only lets the business message you for 24 hours after you last wrote, so
          send it a message now and then. Telegram, WhatsApp and Slack keep the messages they deliver.
        </p>
      </div>
    </Card>
  );
}
