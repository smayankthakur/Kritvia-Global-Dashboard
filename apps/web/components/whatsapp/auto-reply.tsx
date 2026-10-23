"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Checkbox, Field, Select, Switch } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";

const CHANNELS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "email", label: "Email" },
] as const;
const TONES = [
  { value: "warm", label: "Warm & friendly" },
  { value: "professional", label: "Polite & professional" },
  { value: "playful", label: "Fun & playful" },
] as const;
const ALL = CHANNELS.map((c) => c.value as string);

/** Replying by itself: the inbox assistant's `auto_reply`, `auto_reply_channels` and `reply_tone` options,
 * where owners look (the Chats page). Off by default; the same options are under Agents → Inbox assistant. */
export function AutoReplySwitch({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const configs = useQuery({
    queryKey: ["workflow-configs", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: ventureId } } })),
  });
  const cfg = configs.data?.find((c) => c.workflow === "inbox_assistant");
  const settings = (cfg?.settings ?? {}) as Record<string, unknown>;
  const on = settings.auto_reply === true;
  const channels = Array.isArray(settings.auto_reply_channels) ? (settings.auto_reply_channels as string[]) : ALL;
  const tone = typeof settings.reply_tone === "string" ? settings.reply_tone : "warm";
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      unwrap(
        api.PUT("/ventures/{venture_id}/workflow-configs/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: "inbox_assistant" } },
          body: { enabled: cfg?.enabled ?? true, schedule: cfg?.schedule ?? null, settings: { ...settings, ...patch }, instructions: cfg?.instructions ?? "" },
        }),
      ),
    onSuccess: (_, patch) => {
      void qc.invalidateQueries({ queryKey: ["workflow-configs", ventureId] });
      if (patch.auto_reply === true) toast.success("Replying by itself", "Customers now get a friendly answer straight away. Money promises and complaints still come to you.");
      else if (patch.auto_reply === false) toast.success("Replies wait for your yes", "Every reply waits for your yes again.");
      else toast.success("Saved");
    },
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  if (!cfg?.enabled) return null;
  const busy = !canAdmin || save.isPending;
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <MessagesSquare className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Reply to every customer message by itself</p>
          <p className="mt-1 text-xs text-muted">
            A warm, human-sounding assistant answers straight away, in the customer&apos;s own language: Hindi, Hinglish or English. If someone asks, it
            says it is your AI assistant and offers them a person. It never makes up prices, offers, stock or timings.
          </p>
        </div>
        <Switch checked={on} disabled={busy} label="Reply to every customer message by itself" onChange={(next) => save.mutate({ auto_reply: next })} />
      </div>
      <div className="mt-3 rounded-lg border border-border bg-surface-2/60 p-3 text-xs text-muted sm:ml-11">
        <p className="font-medium text-fg">Still comes to you first</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>A price that isn&apos;t in your rate card or records, discounts and offers</li>
          <li>Refunds, payment disputes and complaints</li>
          <li>Promises and deals</li>
          <li>Customers who ask for a person</li>
        </ul>
        <p className="mt-1.5">
          Meanwhile the customer gets a short line saying the team will get back to them. At most 15 replies to one person an hour and 500 a day.
          Spam, automatic emails and chats you have taken over never get an automatic reply.
        </p>
      </div>
      {on ? (
        <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3 sm:ml-11">
          <fieldset>
            <legend className="text-sm font-medium text-fg">Reply by itself on</legend>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {CHANNELS.map((c) => (
                <Checkbox
                  key={c.value}
                  label={c.label}
                  checked={channels.includes(c.value)}
                  disabled={busy}
                  onChange={(e) =>
                    save.mutate({ auto_reply_channels: ALL.filter((v) => (v === c.value ? e.target.checked : channels.includes(v))) })
                  }
                />
              ))}
            </div>
          </fieldset>
          <Field label="Tone" className="max-w-xs">
            <Select value={tone} disabled={busy} onChange={(e) => save.mutate({ reply_tone: e.target.value })}>
              {TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
    </Card>
  );
}
