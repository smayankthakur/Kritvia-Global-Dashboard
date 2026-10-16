"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type Link = Schemas["ApproverLinkOut"];

export const approverLinksKey = (ventureId: string) => ["approver-links", ventureId] as const;

export const CHANNEL_NAME: Record<string, string> = { telegram: "Telegram", slack: "Slack" };

/** "Approve from your phone": link your Telegram chat or Slack account to one business. */
export function ChatApprovals({ ventureId, ventureName }: { ventureId: string; ventureName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = approverLinksKey(ventureId);
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/approver-links", { params: { path: { venture_id: ventureId } } })),
  });
  const [tgLink, setTgLink] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const telegram = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/approver-links/telegram", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (out) => setTgLink(out.link),
    onError: (e) => toast.error("Can't link Telegram", errorMessage(e)),
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
          <BellRing className="h-4 w-4 text-subtle" aria-hidden /> Approve from your phone
        </span>
      }
      description={`Get ${ventureName}'s drafts that need your yes in Telegram or Slack, with Approve, Reject and Ask for changes. You decide as yourself, with the same rights as here.`}
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

  const row = (channel: "telegram" | "slack", available: boolean, missing: string, link: () => void, pending: boolean) => {
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
              ? `${linked.label ?? CHANNEL_NAME[channel]} · since ${formatRelative(linked.created_at)}`
              : available
                ? channel === "telegram"
                  ? `Through ${d.telegram_bot}, the business's bot.`
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
            "slack",
            d.slack_app,
            d.slack_available ? "An admin adds Kritvia to Slack first (Settings → Connectors)." : "Not available on this server yet.",
            () => slack.mutate(),
            slack.isPending,
          )}
        </ul>
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
          Drafts marked sensitive arrive without buttons and are reviewed here. Telegram and Slack keep the messages they deliver.
        </p>
      </div>
    </Card>
  );
}
