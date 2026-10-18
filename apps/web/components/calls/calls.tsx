"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Mic, Phone, PhoneIncoming, PhoneOff, PhoneOutgoing, Send, Volume2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TimeField } from "@/components/ui/time-field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type Voice = Schemas["VoiceOut"];
type Call = Schemas["CallOut"];
type Line = { who: "agent" | "caller"; text: string };

export const voiceKey = (v: string) => ["voice", v] as const;
export const callsKey = (v: string) => ["calls", v] as const;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const OUTCOME: Record<string, string> = {
  answered: "Answered",
  message_taken: "Message taken",
  booking_requested: "Booking request",
  transferred: "Put through",
  opted_out: "Asked not to be called",
  hung_up: "Hung up",
  no_input: "Silent",
  too_long: "Too long",
  ended: "Ended",
};

/** "1 min 14 s" */
export function duration(s: number | null | undefined): string {
  if (!s) return "";
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

function speak(text: string, lang: string, on: boolean) {
  if (!on || typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    window.speechSynthesis.speak(u);
  } catch {
    /* no voice on this device */
  }
}

/** A call in the app: you are the caller, Kritvia answers as it would on the phone. */
export function TestCall({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const [callId, setCallId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [said, setSaid] = useState("");
  const [ended, setEnded] = useState(false);
  const [aloud, setAloud] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [lines]);
  const send = useMutation({
    mutationFn: (body: Schemas["TestIn"]) =>
      unwrap(api.POST("/ventures/{venture_id}/calls/test", { params: { path: { venture_id: ventureId } }, body })),
    onSuccess: (r, body) => {
      setError(null);
      setCallId(r.call_id);
      if (body.said) setLines((l) => [...l, { who: "caller", text: body.said! }]);
      if (r.say) setLines((l) => [...l, { who: "agent", text: r.say }]);
      if (r.transfer_to) setLines((l) => [...l, { who: "agent", text: `(would ring ${r.transfer_to})` }]);
      speak(r.say, r.language, aloud);
      if (r.ended) {
        setEnded(true);
        void qc.invalidateQueries({ queryKey: callsKey(ventureId) });
      }
      setSaid("");
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const start = () => {
    setLines([]);
    setEnded(false);
    send.mutate({ said: "", hang_up: false });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!callId || ended) return;
    send.mutate({ call_id: callId, said: said.trim(), hang_up: false });
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-accent" aria-hidden /> Try a call
          </span>
        }
        description="You are the caller. Type what you'd say (or use the voice button to speak); Kritvia answers exactly as it would on the phone. Test calls make no leads or tasks."
        actions={
          <Switch checked={aloud} onChange={setAloud} label="Read replies aloud" />
        }
      />
      <div className="space-y-3 p-4">
        {lines.length ? (
          <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-border bg-surface-2/50 p-3" aria-live="polite">
            {lines.map((l, i) => (
              <div key={i} className={l.who === "caller" ? "flex justify-end" : "flex justify-start"}>
                <p
                  className={
                    l.who === "caller"
                      ? "max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-sm text-accent-fg"
                      : "max-w-[80%] rounded-2xl rounded-bl-sm bg-surface px-3 py-2 text-sm shadow-sm"
                  }
                  translate="no"
                >
                  {l.text}
                </p>
              </div>
            ))}
            {ended ? <p className="text-center text-xs text-subtle">Call ended. The summary is in the list below.</p> : null}
            <div ref={end} />
          </div>
        ) : null}
        {callId && !ended ? (
          <form onSubmit={submit} className="flex gap-2">
            <Input value={said} onChange={(e) => setSaid(e.target.value)} maxLength={600} placeholder="Say something as the caller…" aria-label="What the caller says" />
            <Button type="submit" variant="primary" loading={send.isPending} icon={<Send className="h-4 w-4" />}>
              Say
            </Button>
            <Button
              variant="ghost"
              icon={<PhoneOff className="h-4 w-4" />}
              onClick={() => callId && send.mutate({ call_id: callId, said: "", hang_up: true })}
              aria-label="Hang up"
            />
          </form>
        ) : (
          <Button variant="primary" icon={<Mic className="h-4 w-4" />} loading={send.isPending} onClick={start}>
            {lines.length ? "Call again" : "Start a test call"}
          </Button>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}

function CallRow({ ventureId, c }: { ventureId: string; c: Call }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    queryKey: ["call", ventureId, c.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/calls/{call_id}", { params: { path: { venture_id: ventureId, call_id: c.id } } })),
    enabled: open,
  });
  const Icon = c.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-label={c.direction === "inbound" ? "Incoming" : "Outgoing"} />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <span translate="no">{c.caller_name || c.phone || (c.test ? "Test call" : "Caller")}</span>
              {c.test ? <Badge>test</Badge> : null}
              {c.outcome ? <Badge tone={c.outcome === "opted_out" ? "warning" : c.outcome === "message_taken" || c.outcome === "booking_requested" ? "info" : undefined}>{OUTCOME[c.outcome] ?? c.outcome}</Badge> : <StatusBadge status={c.status} />}
            </p>
            <p className="text-xs text-subtle">
              {formatRelative(c.started_at)}
              {c.duration_s ? ` · ${duration(c.duration_s)}` : ""}
              {c.purpose ? ` · about ${c.purpose}` : ""}
              {c.lead_id ? (
                <>
                  {" · "}
                  <Link href={`/v/${ventureId}/leads?lead=${c.lead_id}`} className="underline underline-offset-2">
                    lead
                  </Link>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={<ChevronDown className={open ? "h-4 w-4 rotate-180" : "h-4 w-4"} />} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "What was said"}
        </Button>
      </div>
      {c.summary ? (
        <p className="text-sm whitespace-pre-line text-muted" translate="no">
          {c.summary}
        </p>
      ) : null}
      {open ? (
        <QueryState query={detail} loading={<SkeletonRows rows={2} />}>
          {(d) => (
            <ol className="space-y-1 rounded-md bg-surface-2 p-3 text-sm" translate="no">
              {d.transcript.map((t, i) => (
                <li key={i}>
                  <span className="font-medium text-subtle">{t.who === "agent" ? "Kritvia" : "Caller"}:</span> {t.text}
                </li>
              ))}
            </ol>
          )}
        </QueryState>
      ) : null}
    </li>
  );
}

export function CallList({ ventureId }: { ventureId: string }) {
  const q = useQuery({
    queryKey: callsKey(ventureId),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/calls", { params: { path: { venture_id: ventureId }, query: { limit: 30 } } })),
    refetchInterval: 20_000,
  });
  return (
    <Card>
      <CardHeader title="Calls" description="Every call Kritvia answered or made, with a short summary. Messages and booking requests also become tasks." />
      <QueryState query={q} loading={<SkeletonRows rows={3} className="p-3" />}>
        {(rows: Call[]) =>
          rows.length ? (
            <ul className="divide-y divide-border">
              {rows.map((c) => (
                <CallRow key={c.id} ventureId={ventureId} c={c} />
              ))}
            </ul>
          ) : (
            <EmptyState title="No calls yet" description="Try a test call above." />
          )
        }
      </QueryState>
    </Card>
  );
}

/** Ask Kritvia to phone a customer: it waits for a yes, and is a test call until outbound calling is set up. */
export function PlaceCall({ ventureId, live }: { ventureId: string; live: boolean }) {
  const toast = useToast();
  const [f, setF] = useState({ phone: "", name: "", purpose: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/calls", {
          params: { path: { venture_id: ventureId } },
          body: { phone: f.phone.trim(), name: f.name.trim() || null, purpose: f.purpose.trim() },
        }),
      ),
    onSuccess: (r) => {
      setError(null);
      setPending(r.pending_approval_id ?? null);
      setF({ phone: "", name: "", purpose: "" });
      toast.success("The call waits for your yes", r.answer ?? undefined);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <PhoneOutgoing className="h-4 w-4 text-accent" aria-hidden /> Phone a customer
          </span>
        }
        description="For people you already deal with: a reminder, a callback they asked for. Kritvia says it is your AI assistant, calls 9 am to 9 pm only, and never calls a number that said no."
      />
      <form
        className="grid gap-3 p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
        noValidate
      >
        {!live ? (
          <div className="sm:col-span-2">
            <Notice tone="info" title="Test mode">
              Outbound calling isn&apos;t switched on, so an approved call is a test call: nothing is dialled, and it waits for you in the list
              below.
            </Notice>
          </div>
        ) : null}
        <Field label="Phone number" required>
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" placeholder="98110 00011" maxLength={20} />
        </Field>
        <Field label="Name (optional)">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="What is the call about?" required hint="A few words, e.g. tomorrow's 4 pm appointment. You see the exact opening line before saying yes.">
            <Input value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} maxLength={300} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" variant="primary" loading={m.isPending} icon={<Phone className="h-4 w-4" />}>
            Prepare the call
          </Button>
          {pending ? (
            <Link href={`/inbox?id=${pending}`} className="text-sm font-medium underline underline-offset-2">
              Review and say yes
            </Link>
          ) : null}
        </div>
        <div className="sm:col-span-2">
          <FormError message={error} />
        </div>
      </form>
    </Card>
  );
}

function ConnectTwilio({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ account_sid: "", auth_token: "", phone_number: "" });
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/voice/twilio", { params: { path: { venture_id: ventureId } }, body: { ...f, point_number: true } })),
    onSuccess: (v) => {
      setError(null);
      setF({ account_sid: "", auth_token: "", phone_number: "" });
      qc.setQueryData(voiceKey(ventureId), v);
      toast.success("Number connected", "Its calls now come to Kritvia once answering is on.");
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
      noValidate
    >
      <Field label="Account SID" hint="Twilio Console → Account info">
        <Input value={f.account_sid} onChange={(e) => setF({ ...f, account_sid: e.target.value.trim() })} placeholder="AC…" autoComplete="off" />
      </Field>
      <Field label="Auth token" hint="Checked with Twilio, stored encrypted, never shown again">
        <Input type="password" value={f.auth_token} onChange={(e) => setF({ ...f, auth_token: e.target.value.trim() })} autoComplete="off" />
      </Field>
      <Field label="Your Twilio number">
        <Input value={f.phone_number} onChange={(e) => setF({ ...f, phone_number: e.target.value })} inputMode="tel" placeholder="+91 80 4567 1234" />
      </Field>
      <div className="sm:col-span-3">
        <Button type="submit" loading={m.isPending}>
          Connect the number
        </Button>
        <FormError message={error} />
      </div>
    </form>
  );
}

/** Admin settings: the number, how calls are answered, outbound calling. */
export function VoiceSettings({ ventureId, voice }: { ventureId: string; voice: Voice }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Schemas["VoiceIn"]>({
    enabled: voice.enabled,
    language: voice.language,
    voice: voice.voice,
    greeting: voice.greeting ?? "",
    transfer_number: voice.transfer_number ?? "",
    open_days: voice.open_days,
    open_from: voice.open_from,
    open_to: voice.open_to,
    max_minutes: voice.max_minutes,
  });
  const [o, setO] = useState<{ dlt_entity_id: string; caller_id_kind: "160" | "landline" | "other"; confirm: boolean }>({
    dlt_entity_id: voice.dlt_entity_id ?? "",
    caller_id_kind: voice.caller_id_kind ?? "160",
    confirm: false,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<Schemas["VoiceIn"]>) => setD({ ...d, ...p });
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/voice", {
          params: { path: { venture_id: ventureId } },
          body: { ...d, greeting: (d.greeting ?? "").trim() || null, transfer_number: (d.transfer_number ?? "").trim() || null },
        }),
      ),
    onSuccess: (v) => {
      setError(null);
      qc.setQueryData(voiceKey(ventureId), v);
      toast.success("Saved", v.answering ? "Kritvia answers your number now." : undefined);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const outbound = useMutation({
    mutationFn: (enabled: boolean) =>
      unwrap(
        api.PUT("/ventures/{venture_id}/voice/outbound", {
          params: { path: { venture_id: ventureId } },
          body: { enabled, dlt_entity_id: o.dlt_entity_id.trim() || null, caller_id_kind: o.caller_id_kind, confirm: o.confirm },
        }),
      ),
    onSuccess: (v) => {
      qc.setQueryData(voiceKey(ventureId), v);
      toast.success(v.outbound_enabled ? "Outbound calls on" : "Outbound calls off");
    },
    onError: (e) => toast.error("Can't change it", errorMessage(e)),
  });
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/voice/twilio", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (v) => qc.setQueryData(voiceKey(ventureId), v),
    onError: (e) => toast.error("Can't disconnect", errorMessage(e)),
  });
  const days = d.open_days ?? [];
  return (
    <Card>
      <CardHeader title="Phone settings" description="Your own Twilio number (Kritvia never sees audio; Twilio speaks and listens), how calls are answered, and calling customers." />
      <div className="space-y-6 p-4">
        <section className="space-y-3" aria-labelledby="num-h">
          <h3 id="num-h" className="text-sm font-semibold">
            Number
          </h3>
          {voice.number && voice.number.status === "active" ? (
            <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium" translate="no">
                  {voice.number.number}
                </span>
                <Badge tone="success">connected</Badge>
                <span className="text-xs text-subtle">account …{voice.number.account}</span>
              </p>
              <p className="text-xs text-subtle">
                Webhooks set on the number (set them by hand in Twilio if needed): voice <code className="break-all">{voice.number.voice_url}</code>, status{" "}
                <code className="break-all">{voice.number.status_url}</code>
              </p>
              <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            </div>
          ) : (
            <ConnectTwilio ventureId={ventureId} />
          )}
        </section>

        <section className="space-y-3" aria-labelledby="ans-h">
          <h3 id="ans-h" className="text-sm font-semibold">
            Answering
          </h3>
          <Switch checked={Boolean(d.enabled)} onChange={(v) => set({ enabled: v })} label="Kritvia answers calls to this number" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Language">
              <Select value={d.language} onChange={(e) => set({ language: e.target.value as "hi-IN" })}>
                <option value="hi-IN">Hindi and Hinglish</option>
                <option value="en-IN">Indian English</option>
              </Select>
            </Field>
            <Field label="Voice">
              <Select value={d.voice} onChange={(e) => set({ voice: e.target.value as "Polly.Aditi" })}>
                <option value="Polly.Aditi">Aditi (Hindi + English)</option>
                <option value="Polly.Kajal-Neural">Kajal (natural)</option>
                <option value="Polly.Raveena">Raveena (English)</option>
              </Select>
            </Field>
            <Field label="Longest call (minutes)">
              <Input type="number" min={2} max={20} value={d.max_minutes ?? 8} onChange={(e) => set({ max_minutes: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label="Greeting (optional)" hint={`Empty: "${voice.greeting_preview}". It always says it is your AI assistant.`}>
            <Textarea rows={2} value={d.greeting ?? ""} onChange={(e) => set({ greeting: e.target.value })} maxLength={300} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Put callers through to (optional)" hint="Someone at the business, in opening hours">
              <Input value={d.transfer_number ?? ""} onChange={(e) => set({ transfer_number: e.target.value })} inputMode="tel" placeholder="98110 00011" />
            </Field>
            <Field label="Opens">
              <TimeField value={d.open_from ?? "10:00"} onChange={(t) => set({ open_from: t })} />
            </Field>
            <Field label="Closes">
              <TimeField value={d.open_to ?? "19:00"} onChange={(t) => set({ open_to: t })} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Open days">
            {WEEKDAYS.map((w, i) => {
              const on = days.includes(i);
              return (
                <Button key={w} size="sm" variant={on ? "primary" : "secondary"} aria-pressed={on} onClick={() => set({ open_days: on ? days.filter((x) => x !== i) : [...days, i].sort() })}>
                  {w}
                </Button>
              );
            })}
          </div>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} icon={<Volume2 className="h-4 w-4" />}>
            Save answering
          </Button>
          <FormError message={error} />
        </section>

        <section className="space-y-3" aria-labelledby="out-h">
          <h3 id="out-h" className="text-sm font-semibold">
            Calling customers
          </h3>
          <p className="text-sm text-muted">
            In India, business calls must come from a registered caller id. Register your business on a TRAI DLT platform (Jio, Airtel, Vi or BSNL) and use a
            160-series or registered landline number with Twilio. Kritvia only makes service calls to your own customers, after your yes each time.
          </p>
          {voice.outbound_enabled ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge tone="success">on</Badge>
              <span className="text-subtle">
                DLT entity {voice.dlt_entity_id} · confirmed {voice.registered_at ? formatRelative(voice.registered_at) : ""}
              </span>
              <Button size="sm" variant="ghost" loading={outbound.isPending} onClick={() => outbound.mutate(false)}>
                Switch off
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="DLT Principal Entity ID">
                <Input value={o.dlt_entity_id} onChange={(e) => setO({ ...o, dlt_entity_id: e.target.value.replace(/\D/g, "") })} inputMode="numeric" maxLength={25} />
              </Field>
              <Field label="Caller id">
                <Select value={o.caller_id_kind} onChange={(e) => setO({ ...o, caller_id_kind: e.target.value as "160" | "landline" | "other" })}>
                  <option value="160">160-series (service/transactional)</option>
                  <option value="landline">Registered landline</option>
                  <option value="other">Other registered number</option>
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Checkbox
                  checked={o.confirm}
                  onChange={(e) => setO({ ...o, confirm: e.target.checked })}
                  label="I confirm the business is registered as above, and calls are only service calls to our own customers (no promotion)."
                />
              </div>
              <div>
                <Button variant="secondary" disabled={!voice.number || !o.confirm || !o.dlt_entity_id} loading={outbound.isPending} onClick={() => outbound.mutate(true)}>
                  Switch on outbound calls
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}
