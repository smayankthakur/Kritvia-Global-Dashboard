"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, CornerDownLeft, Trash2, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { FormError, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";
import { cannotSend, chatName, formatPhone, senderLabel } from "@/components/whatsapp/chat";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative, formatTime } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Chat = Schemas["ChatOut"];
type Message = Schemas["MessageOut"];

function ChatList({ chats, selected, onSelect }: { chats: Chat[]; selected: string | null; onSelect: (id: string) => void }) {
  if (!chats.length)
    return <EmptyState title="No chats yet" description="When a customer messages your WhatsApp Business number, the chat shows up here." />;
  return (
    <ul className="divide-y divide-border" aria-label="Chats">
      {chats.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onSelect(c.id)}
            aria-current={selected === c.id ? "true" : undefined}
            className={cn(
              "w-full space-y-0.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
              selected === c.id && "bg-surface-2",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{chatName(c)}</span>
              <span className="shrink-0 text-xs text-subtle">{formatRelative(c.last_message_at)}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-muted">
                {c.last_direction === "out" ? "You: " : ""}
                {c.last_message || "…"}
              </span>
              {c.unread ? (
                <Badge tone="accent">
                  {c.unread}
                  <span className="sr-only"> unread</span>
                </Badge>
              ) : null}
            </span>
            {c.handled_by === "person" || c.opted_out ? (
              <span className="flex gap-1 pt-0.5">
                {c.handled_by === "person" ? <Badge tone="warning">You&apos;re replying</Badge> : null}
                {c.opted_out ? <Badge tone="neutral">Opted out</Badge> : null}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Bubble({ m, customer }: { m: Message; customer: string }) {
  const out = m.direction === "out";
  return (
    <li className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm",
          out ? "bg-accent-soft text-accent-soft-fg" : "bg-surface-2",
          m.status === "failed" && "border border-danger",
        )}
      >
        <p className="mb-0.5 text-xs text-subtle">
          {senderLabel(m.sent_by, customer)} · {formatTime(m.created_at)}
        </p>
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        {m.status === "failed" ? <p className="mt-1 text-xs text-danger">Not delivered: {m.error ?? "WhatsApp refused it"}</p> : null}
      </div>
    </li>
  );
}

function Conversation({ ventureId, chatId, canWrite, canAdmin, onClose }: {
  ventureId: string;
  chatId: string;
  canWrite: boolean;
  canAdmin: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const key = ["whatsapp-chat", ventureId, chatId];
  const detail = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(api.GET("/ventures/{venture_id}/whatsapp/chats/{chat_id}", { params: { path: { venture_id: ventureId, chat_id: chatId } } })),
    refetchInterval: 5000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["whatsapp", ventureId] });
  };
  const count = detail.data?.messages.length ?? 0;
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [count]);
  // Opening a chat marks it read on the server; refresh the list so its unread count clears.
  const loaded = Boolean(detail.data);
  useEffect(() => {
    if (loaded) void qc.invalidateQueries({ queryKey: ["whatsapp", ventureId] });
  }, [loaded, qc, ventureId]);

  const send = useMutation({
    mutationFn: (body: string) =>
      unwrap(
        api.POST("/ventures/{venture_id}/whatsapp/chats/{chat_id}/reply", {
          params: { path: { venture_id: ventureId, chat_id: chatId } },
          body: { body },
        }),
      ),
    onSuccess: () => {
      setText("");
      setError(null);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const handler = useMutation({
    mutationFn: (handled_by: "kritvia" | "person") =>
      unwrap(
        api.PUT("/ventures/{venture_id}/whatsapp/chats/{chat_id}/handler", {
          params: { path: { venture_id: ventureId, chat_id: chatId } },
          body: { handled_by },
        }),
      ),
    onSuccess: (c) => {
      toast.success(c.handled_by === "kritvia" ? "Kritvia is drafting replies again" : "You're replying to this chat");
      refresh();
    },
    onError: (e) => toast.error("Could not change who replies", errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE("/ventures/{venture_id}/whatsapp/chats/{chat_id}", { params: { path: { venture_id: ventureId, chat_id: chatId } } })),
    onSuccess: () => {
      toast.success("Chat deleted");
      setConfirmDelete(false);
      void qc.invalidateQueries({ queryKey: ["whatsapp", ventureId] });
      onClose();
    },
    onError: (e) => toast.error("Could not delete", errorMessage(e)),
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return setError("Write a message first");
    send.mutate(body);
  };

  return (
    <QueryState query={detail} loading={<SkeletonRows rows={4} />}>
      {(d: Schemas["ChatDetailOut"]) => {
        const c = d.chat;
        const name = chatName(c);
        const blocked = cannotSend(c, canWrite);
        return (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <Button size="sm" variant="ghost" className="lg:hidden" onClick={onClose} icon={<ArrowLeft className="h-4 w-4" />}>
                Chats
              </Button>
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-semibold">{name}</h2>
                <p className="text-xs text-subtle">
                  {formatPhone(c.phone)}
                  {c.lead_id ? (
                    <>
                      {" · "}
                      <Link href={`/v/${ventureId}/leads?lead=${c.lead_id}`} className="underline underline-offset-2">
                        Lead
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
              {c.handled_by === "kritvia" ? (
                <Badge tone="success">
                  <Bot className="h-3 w-3" aria-hidden /> Kritvia drafts replies
                </Badge>
              ) : (
                <Badge tone="warning">
                  <UserRound className="h-3 w-3" aria-hidden /> You&apos;re replying
                </Badge>
              )}
              {canWrite ? (
                <Button
                  size="sm"
                  loading={handler.isPending}
                  onClick={() => handler.mutate(c.handled_by === "kritvia" ? "person" : "kritvia")}
                >
                  {c.handled_by === "kritvia" ? "Take over" : "Give back to Kritvia"}
                </Button>
              ) : null}
              {canAdmin ? (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                  <span className="sr-only">Delete chat</span>
                </Button>
              ) : null}
            </div>
            {c.handled_by === "person" && c.handoff_reason ? (
              <p className="border-b border-border bg-warning-soft px-3 py-2 text-sm text-warning-fg">
                Handed to your team: {c.handoff_reason}
              </p>
            ) : null}
            <div className="max-h-[55vh] min-h-64 flex-1 overflow-y-auto p-3">
              <ol className="space-y-2" aria-label={`Messages with ${name}`} aria-live="polite">
                {d.messages.map((m) => (
                  <Bubble key={m.id} m={m} customer={name} />
                ))}
              </ol>
              <div ref={end} />
            </div>
            {c.pending_approval_id ? (
              <div className="border-t border-border p-3">
                <Notice tone="info" title="Kritvia drafted a reply">
                  It goes out when someone approves it.{" "}
                  <Link href={`/inbox?id=${c.pending_approval_id}`} className="font-medium underline underline-offset-2">
                    Review the draft
                  </Link>
                </Notice>
              </div>
            ) : null}
            <form onSubmit={submit} className="space-y-2 border-t border-border p-3" noValidate>
              {blocked ? (
                <p className="text-sm text-muted">{blocked}</p>
              ) : (
                <>
                  <label htmlFor="wa-reply" className="sr-only">
                    Reply to {name}
                  </label>
                  <Textarea
                    id="wa-reply"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
                    }}
                    rows={2}
                    maxLength={4096}
                    placeholder="Type a reply…"
                  />
                  <FormError message={error} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" variant="primary" loading={send.isPending} icon={<CornerDownLeft className="h-4 w-4" />}>
                      Send now
                    </Button>
                    <span className="text-xs text-subtle">
                      {c.handled_by === "kritvia" ? "Sending takes this chat over from Kritvia. " : ""}Ctrl + Enter
                    </span>
                  </div>
                </>
              )}
            </form>
            <ConfirmDialog
              open={confirmDelete}
              onClose={() => setConfirmDelete(false)}
              onConfirm={() => remove.mutate()}
              loading={remove.isPending}
              title={`Delete the chat with ${name}?`}
              description="Every message in it is erased for good. Use this when a customer asks for their data to be deleted."
              confirmLabel="Delete chat"
            />
          </div>
        );
      }}
    </QueryState>
  );
}

function WhatsAppView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("c");
  const chats = useQuery({
    queryKey: ["whatsapp", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/whatsapp/chats", { params: { path: { venture_id: v.id } } })),
    refetchInterval: 10000,
  });
  const select = (id: string | null) => router.replace(id ? `/v/${v.id}/whatsapp?c=${id}` : `/v/${v.id}/whatsapp`, { scroll: false });
  const canWrite = v.access === "write";
  const canAdmin = Boolean(v.can_admin || v.is_owner);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="WhatsApp"
        description="Your customers' chats. Kritvia drafts each reply with the whole chat in mind and waits for your yes; take over any chat to answer it yourself."
      />
      {chats.data && !chats.data.connected ? (
        <Notice tone="warning" title="WhatsApp isn't connected">
          Connect your WhatsApp Business number in{" "}
          <Link href="/settings/connectors" className="font-medium underline underline-offset-2">
            Settings → Connectors
          </Link>{" "}
          and new customer messages will appear here.
        </Notice>
      ) : null}
      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-1 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <div className={cn("min-w-0 border-border lg:border-r", selected && "hidden lg:block")}>
            <QueryState query={chats} loading={<SkeletonRows rows={5} className="p-3" />}>
              {(d: Schemas["ChatsOut"]) => <ChatList chats={d.chats} selected={selected} onSelect={select} />}
            </QueryState>
          </div>
          <div className={cn("min-w-0", !selected && "hidden lg:block")}>
            {selected ? (
              <Conversation
                key={selected}
                ventureId={v.id}
                chatId={selected}
                canWrite={canWrite}
                canAdmin={canAdmin}
                onClose={() => select(null)}
              />
            ) : (
              <EmptyState title="Pick a chat" description="Choose a customer on the left to read the chat and reply." />
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

export default function WhatsAppPage() {
  return (
    <Suspense>
      <WhatsAppView />
    </Suspense>
  );
}
