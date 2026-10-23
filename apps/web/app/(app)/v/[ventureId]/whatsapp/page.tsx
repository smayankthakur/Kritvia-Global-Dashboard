"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, CornerDownLeft, FileText, MessageSquarePlus, Trash2, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { AnswerFactsSwitch } from "@/components/whatsapp/answer-facts";
import { AutoReplySwitch } from "@/components/whatsapp/auto-reply";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/ui/cn";
import { CHANNEL_LABEL, cannotSend, chatAddress, chatName, messageText, needsTemplate, normalisePhone, senderLabel } from "@/components/whatsapp/chat";
import { TemplateFields, useTemplates, type TemplateChoice } from "@/components/whatsapp/send-template";
import { paramProblem, sendableTemplates } from "@/components/whatsapp/templates";
import { TemplatesPanel } from "@/components/whatsapp/templates-panel";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative, formatTime } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Chat = Schemas["ChatOut"];
type Message = Schemas["MessageOut"];

function ChatList({ chats, selected, onSelect, showChannel }: {
  chats: Chat[];
  selected: string | null;
  onSelect: (id: string) => void;
  showChannel: boolean;
}) {
  if (!chats.length)
    return <EmptyState title="No chats yet" description="When a customer messages your WhatsApp number or Telegram bot, the chat shows up here." />;
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
                {c.last_message ? messageText(c.last_message, null, c.channel) : "…"}
              </span>
              {c.unread ? (
                <Badge tone="accent">
                  {c.unread}
                  <span className="sr-only"> unread</span>
                </Badge>
              ) : null}
            </span>
            {c.handled_by === "person" || c.opted_out || showChannel ? (
              <span className="flex flex-wrap gap-1 pt-0.5">
                {showChannel ? <Badge tone={c.channel === "telegram" ? "info" : "neutral"}>{CHANNEL_LABEL[c.channel ?? "whatsapp"]}</Badge> : null}
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
          {m.kind === "template" ? " · template" : ""}
        </p>
        <p translate="no" className={cn("whitespace-pre-wrap break-words", m.kind === "start" && "italic text-muted")}>{messageText(m.body, m.kind)}</p>
        {m.status === "failed" ? <p className="mt-1 text-xs text-danger">Not delivered: {m.error ?? "it was refused"}</p> : null}
      </div>
    </li>
  );
}

/** Problem with a template choice before it is sent, or null. */
function choiceProblem(choice: TemplateChoice, count: number): string | null {
  if (!choice.templateId) return "Choose a template.";
  for (let i = 0; i < count; i++) {
    const p = paramProblem(choice.params[i] ?? "");
    if (p) return p;
  }
  return null;
}

/** Shown in a chat when the 24 hours are over: the only way to write is an approved template. */
function TemplateComposer({ ventureId, chatId, onSent }: { ventureId: string; chatId: string; onSent: () => void }) {
  const templates = useTemplates(ventureId);
  const [choice, setChoice] = useState<TemplateChoice>({ templateId: "", params: [] });
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/whatsapp/chats/{chat_id}/template", {
          params: { path: { venture_id: ventureId, chat_id: chatId } },
          body: { template_id: choice.templateId, params: choice.params.map((p) => p.trim()) },
        }),
      ),
    onSuccess: () => {
      setChoice({ templateId: "", params: [] });
      setError(null);
      onSent();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const all = templates.data?.templates ?? [];
  if (templates.isPending) return <SkeletonRows rows={1} />;
  if (!sendableTemplates(all).length)
    return (
      <p className="text-sm text-muted">
        No approved template yet.{" "}
        <Link href={`/v/${ventureId}/whatsapp?tab=templates`} className="font-medium underline underline-offset-2">
          Write one
        </Link>{" "}
        (approval usually takes minutes).
      </p>
    );
  const count = all.find((t) => t.id === choice.templateId)?.params ?? 0;
  return (
    <div className="space-y-3">
      <TemplateFields templates={all} value={choice} onChange={setChoice} idPrefix={`chat-${chatId}`} />
      <FormError message={error} />
      <Button
        variant="primary"
        loading={send.isPending}
        icon={<FileText className="h-4 w-4" />}
        onClick={() => {
          const p = choiceProblem(choice, count);
          if (p) return setError(p);
          send.mutate();
        }}
      >
        Send template
      </Button>
    </div>
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
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" }); // block body: scrollIntoView() may return a Promise
  }, [count]);
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
                  {chatAddress(c)}
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
            {blocked && needsTemplate(c, canWrite) ? (
              <div className="space-y-3 border-t border-border p-3">
                <p className="text-sm text-muted">{blocked}</p>
                <TemplateComposer ventureId={ventureId} chatId={chatId} onSent={refresh} />
              </div>
            ) : (
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
            )}
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

function NewChatDialog({ ventureId, open, onClose, onCreated }: {
  ventureId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (chatId: string) => void;
}) {
  const templates = useTemplates(ventureId);
  const [phone, setPhone] = useState("+91 ");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [choice, setChoice] = useState<TemplateChoice>({ templateId: "", params: [] });
  const [error, setError] = useState<string | null>(null);
  const all = templates.data?.templates ?? [];
  const create = useMutation({
    mutationFn: (digits: string) =>
      unwrap(
        api.POST("/ventures/{venture_id}/whatsapp/chats", {
          params: { path: { venture_id: ventureId } },
          body: {
            phone: `+${digits}`,
            name: name.trim() || null,
            consent: true,
            template_id: choice.templateId,
            params: choice.params.map((p) => p.trim()),
          },
        }),
      ),
    onSuccess: (c) => {
      setPhone("+91 ");
      setName("");
      setConsent(false);
      setChoice({ templateId: "", params: [] });
      setError(null);
      onCreated(c.id);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const digits = normalisePhone(phone);
    if (!digits) return setError("Write the number with its country code, e.g. +91 98111 22233.");
    const p = choiceProblem(choice, all.find((t) => t.id === choice.templateId)?.params ?? 0);
    if (p) return setError(p);
    if (!consent) return setError("Only message people who agreed to hear from you on WhatsApp.");
    setError(null);
    create.mutate(digits);
  };
  const none = templates.data && !sendableTemplates(all).length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New WhatsApp chat"
      description="Write first with an approved template. When they answer, Kritvia drafts the replies like in any other chat."
      footer={
        none ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={() => submit()}>
              Send
            </Button>
          </>
        )
      }
    >
      {none ? (
        <Notice tone="info" title="No approved template yet">
          WhatsApp only lets a business write first with a message it approved in advance.{" "}
          <Link href={`/v/${ventureId}/whatsapp?tab=templates`} onClick={onClose} className="font-medium underline underline-offset-2">
            Write a template
          </Link>
          ; approval usually takes minutes.
        </Notice>
      ) : (
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="WhatsApp number" hint="With country code" required>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" maxLength={24} />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
          </div>
          <TemplateFields templates={all} value={choice} onChange={setChoice} idPrefix="new-chat" />
          <Checkbox
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            label="This person agreed to get WhatsApp messages from us"
            hint="WhatsApp blocks numbers that message people who didn't ask for it."
          />
          <FormError message={error} />
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

function ChatsView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("c");
  const tab = params.get("tab") === "templates" ? "templates" : "chats";
  const [newChat, setNewChat] = useState(false);
  const chats = useQuery({
    queryKey: ["whatsapp", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/whatsapp/chats", { params: { path: { venture_id: v.id } } })),
    refetchInterval: 10000,
  });
  const select = (id: string | null) => router.replace(id ? `/v/${v.id}/whatsapp?c=${id}` : `/v/${v.id}/whatsapp`, { scroll: false });
  const setTab = (t: string) => router.replace(t === "templates" ? `/v/${v.id}/whatsapp?tab=templates` : `/v/${v.id}/whatsapp`, { scroll: false });
  const canWrite = v.access === "write";
  const canAdmin = Boolean(v.can_admin || v.is_owner);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Chats"
        description="Your customers' WhatsApp and Telegram chats. Kritvia drafts each reply with the whole chat in mind and waits for your yes; take over any chat to answer it yourself."
      />
      {chats.data && !chats.data.connected && !chats.data.telegram_bot ? (
        <Notice tone="warning" title="No chat app is connected">
          {/* A full page load (not a client-side link): only that page may open Meta's signup window. */}
          <a href={`/v/${v.id}/whatsapp-connect`} className="font-medium underline underline-offset-2">
            Connect WhatsApp
          </a>{" "}
          by logging in with Facebook (about 2 minutes), or{" "}
          <Link href={`/v/${v.id}/settings?tab=connectors`} className="font-medium underline underline-offset-2">
            connect a Telegram bot
          </Link>
          , and new customer messages will appear here.
        </Notice>
      ) : null}
      {chats.data?.connected || chats.data?.telegram_bot ? (
        <>
          <AutoReplySwitch ventureId={v.id} canAdmin={canAdmin} />
          <AnswerFactsSwitch ventureId={v.id} canAdmin={canAdmin} />
        </>
      ) : null}
      {chats.data?.telegram_bot ? (
        <p className="text-sm text-muted">
          Customers can chat with your bot at{" "}
          <a href={`https://t.me/${chats.data.telegram_bot}`} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
            t.me/{chats.data.telegram_bot}
          </a>
          ; share the link on your website and visiting cards.
        </p>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs
          label="Chats"
          value={tab}
          onChange={setTab}
          items={[
            { id: "chats", label: "Chats" },
            { id: "templates", label: "WhatsApp templates" },
          ]}
        />
        {tab === "chats" && canWrite && chats.data?.connected ? (
          <Button size="sm" onClick={() => setNewChat(true)} icon={<MessageSquarePlus className="h-4 w-4" />}>
            New chat
          </Button>
        ) : null}
      </div>
      {tab === "templates" ? (
        <TemplatesPanel ventureId={v.id} canWrite={canWrite} canAdmin={canAdmin} />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-1 lg:grid-cols-[20rem_minmax(0,1fr)]">
            <div className={cn("min-w-0 border-border lg:border-r", selected && "hidden lg:block")}>
              <QueryState query={chats} loading={<SkeletonRows rows={5} className="p-3" />}>
                {(d: Schemas["ChatsOut"]) => (
                  <ChatList
                    chats={d.chats}
                    selected={selected}
                    onSelect={select}
                    showChannel={Boolean(d.telegram_bot) || d.chats.some((c) => c.channel === "telegram")}
                  />
                )}
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
      )}
      <NewChatDialog
        ventureId={v.id}
        open={newChat}
        onClose={() => setNewChat(false)}
        onCreated={(id) => {
          setNewChat(false);
          void chats.refetch();
          select(id);
        }}
      />
    </div>
  );
}

export default function ChatsPage() {
  return (
    <Suspense>
      <ChatsView />
    </Suspense>
  );
}
