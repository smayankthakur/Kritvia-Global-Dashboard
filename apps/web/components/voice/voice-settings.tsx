"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, FormError, Select, Switch, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { hotkeyLabel, isAllowedHotkey } from "@/lib/voice/hotkey";
import { DEFAULT_VOICE_SETTINGS, useVoice, useVoiceSettings, voiceSettingsKey, type VoiceSettings } from "./voice-provider";

const DESKTOP_RELEASES = "https://github.com/smayankthakur/Kritvia-Global-Dashboard/releases";

function HotkeyCapture({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [listening, setListening] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!listening) return;
    document.body.dataset.voiceCapture = "1"; // the push-to-talk listener stands down while a key is being chosen
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setListening(false);
        return;
      }
      if (!isAllowedHotkey(e.code)) {
        setErr(`${hotkeyLabel(e.code)} can't be used — it would get in the way of typing. Try Right Ctrl, Right Alt or F8.`);
        return;
      }
      setErr(null);
      onChange(e.code);
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      delete document.body.dataset.voiceCapture;
    };
  }, [listening, onChange]);
  return (
    <div>
      <div className="flex items-center gap-2">
        <kbd className="rounded-md border border-border-strong bg-surface-2 px-2.5 py-1 font-sans text-sm font-medium">{hotkeyLabel(value)}</kbd>
        <Button size="sm" onClick={() => setListening((l) => !l)} aria-pressed={listening} aria-label="Change push-to-talk key">
          {listening ? "Press a key… (Esc to cancel)" : "Change"}
        </Button>
      </div>
      {err ? <p className="mt-1.5 text-xs text-danger">{err}</p> : null}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-subtle">{hint}</div>
      </div>
      {children}
    </div>
  );
}

export function VoiceSettingsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const voice = useVoice();
  const q = useVoiceSettings();
  const opts = useQuery({ queryKey: ["voice-options"], queryFn: () => unwrap(api.GET("/voice/options")), staleTime: 10 * 60_000 });
  const [s, setS] = useState<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const [err, setErr] = useState<string | null>(null);
  const [tryText, setTryText] = useState("");
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (next: VoiceSettings) => unwrap(api.PUT("/me/voice-settings", { body: next })),
    onSuccess: (d) => {
      qc.setQueryData(voiceSettingsKey, d);
      setErr(null);
      toast.success("Voice settings saved");
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const set = <K extends keyof VoiceSettings>(k: K, v: VoiceSettings[K]) => setS((p) => ({ ...p, [k]: v }));

  if (q.isPending || opts.isPending) return <SkeletonRows />;
  if (q.isError) return <ErrorState error={q.error} />;
  const engines = opts.data?.engines ?? [];
  const langs = (opts.data?.languages ?? []).filter((l) =>
    s.engine === "sarvam" ? l.sarvam : s.engine === "whisper" || s.engine === "local" ? l.whisper : true,
  );
  const engineInfo = engines.find((e) => e.engine === s.engine);
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader title="Dictation" description="Applies to you in every venture: the web app, the floating widget and the desktop companion." />
        <div className="space-y-4 p-4">
          <FormError message={err} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Speech engine" hint={engineInfo?.detail}>
              <Select value={s.engine} onChange={(e) => set("engine", e.target.value as VoiceSettings["engine"])}>
                {engines.map((e) => (
                  <option key={e.engine} value={e.engine} disabled={!e.available}>
                    {e.engine === "auto" ? "Automatic" : e.engine === "sarvam" ? "Sarvam (Indian languages)" : e.engine === "whisper" ? "Whisper" : "Local only (private)"}
                    {e.available ? "" : " — not set up"}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Language" hint="Auto-detect handles Hinglish well with Sarvam. Pick one if you always speak it.">
              <Select value={s.language} onChange={(e) => set("language", e.target.value)}>
                {langs.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Push-to-talk key" hint="Hold it anywhere in Kritvia, speak, release. Pressing another key while holding cancels (so shortcuts still work).">
            <HotkeyCapture value={s.hotkey} onChange={(c) => set("hotkey", c)} />
          </Field>
          <div className="divide-y divide-border border-y border-border">
            <Row label="Remove filler words" hint="Drops “uh”, “um”, “er”. Turn off when you need a verbatim record.">
              <Switch label="Remove filler words" checked={s.remove_fillers} onChange={(v) => set("remove_fillers", v)} />
            </Row>
            <Row label="Mask profanity" hint="Replaces swear words (English and common Hindi) with ****.">
              <Switch label="Mask profanity" checked={s.profanity_filter} onChange={(v) => set("profanity_filter", v)} />
            </Row>
            <Row label="Learn from my corrections" hint="When you fix a dictated word, offer to remember it for next time.">
              <Switch label="Learn from my corrections" checked={s.auto_learn} onChange={(v) => set("auto_learn", v)} />
            </Row>
            <Row label="Floating widget" hint="The draggable mic in the corner. The hotkey and header mic work either way.">
              <Switch label="Floating widget" checked={s.widget_enabled} onChange={(v) => set("widget_enabled", v)} />
            </Row>
          </div>
          <div className="flex gap-2">
            <Button variant="primary" disabled={!dirty || !isAllowedHotkey(s.hotkey)} loading={save.isPending} onClick={() => save.mutate(s)}>
              Save
            </Button>
            {dirty ? (
              <Button variant="ghost" onClick={() => q.data && setS(q.data)}>
                Discard changes
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Try it" description={`Click in the box, hold ${hotkeyLabel(voice.settings.hotkey)} and speak.`} />
          <div className="p-3">
            <Textarea rows={4} value={tryText} onChange={(e) => setTryText(e.target.value)} placeholder="Your words appear here…" aria-label="Dictation test area" />
            {voice.last?.deployment ? (
              <p className="mt-2 text-xs text-subtle">
                Last: {voice.last.engine}
                {voice.last.language ? ` · ${voice.last.language}` : ""} · {voice.last.words} words
                {voice.last.vocabulary_applied ? ` · ${voice.last.vocabulary_applied} vocabulary fix${voice.last.vocabulary_applied === 1 ? "" : "es"}` : ""}
              </p>
            ) : null}
          </div>
        </Card>
        <Card>
          <CardHeader title="Desktop companion" description="Dictate into any app — Gmail, WhatsApp, Word, VS Code." />
          <div className="space-y-3 p-3 text-sm">
            <p className="text-muted">
              A small tray app for Windows and macOS with the same widget, hotkey, vocabulary and auto-learn — it signs in to Kritvia and types where your cursor is.
            </p>
            <a
              href={DESKTOP_RELEASES}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              <Laptop className="h-4 w-4" aria-hidden /> Download
            </a>
            <Notice tone="info">The browser can only hear the hotkey while a Kritvia tab is focused. The desktop companion works everywhere.</Notice>
          </div>
        </Card>
      </div>
    </div>
  );
}
