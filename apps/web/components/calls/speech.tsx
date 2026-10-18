"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type Voice = Schemas["VoiceOut"];
type KeyProvider = "sarvam" | "openai" | "deepgram" | "elevenlabs";
type Stt = Schemas["SpeechIn"]["stt_provider"];
type Tts = Schemas["SpeechIn"]["tts_provider"];

const voiceKey = (v: string) => ["voice", v] as const;

export const STT_LABELS: Record<NonNullable<Stt>, string> = {
  platform: "Kritvia's speech recognition",
  sarvam: "Sarvam (your key) — Indian languages",
  openai: "OpenAI or compatible, e.g. Groq (your key)",
  deepgram: "Deepgram (your key) — Hindi-English mix",
  local: "Speech server on Kritvia's machine",
};
export const TTS_LABELS: Record<NonNullable<Tts>, string> = {
  platform: "Kritvia's voice (on Kritvia's servers)",
  sarvam: "Sarvam Bulbul (your key) — Indian voices",
  openai: "OpenAI or compatible (your key)",
  elevenlabs: "ElevenLabs (your key)",
  local: "Speech server on Kritvia's machine",
};
const KEY_LABELS: Record<KeyProvider, string> = { sarvam: "Sarvam", openai: "OpenAI / compatible", deepgram: "Deepgram", elevenlabs: "ElevenLabs" };

/** Which providers need which key (for the hint under each select). */
export function keyNeeded(stt: Stt, tts: Tts): KeyProvider[] {
  const need = new Set<KeyProvider>();
  for (const p of [stt, tts]) if (p === "sarvam" || p === "openai" || p === "deepgram" || p === "elevenlabs") need.add(p);
  return [...need];
}

/** Connect an Indian number (Exotel ExoPhone): calls within India. */
export function ExotelSetup({ ventureId, voice }: { ventureId: string; voice: Voice }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ api_key: "", api_token: "", account_sid: "", exophone: "", region: "api.in.exotel.com" as "api.in.exotel.com" | "api.exotel.com" });
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (r: Schemas["ExotelLinkOut"]) => {
    setLink(r.voicebot_url);
    setError(null);
    qc.setQueryData(voiceKey(ventureId), r.voice);
  };
  const connect = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/voice/exotel", { params: { path: { venture_id: ventureId } }, body: f })),
    onSuccess: (r) => {
      done(r);
      setF({ ...f, api_token: "" });
      toast.success("Exotel number connected", "Paste the Voicebot link into your Exotel flow.");
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const relink = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/voice/exotel/link", { params: { path: { venture_id: ventureId } } })),
    onSuccess: done,
    onError: (e) => toast.error("Can't make a new link", errorMessage(e)),
  });
  const disconnect = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/voice/exotel", { params: { path: { venture_id: ventureId } } })),
    onSuccess: (v) => {
      setLink(null);
      qc.setQueryData(voiceKey(ventureId), v);
    },
    onError: (e) => toast.error("Can't disconnect", errorMessage(e)),
  });
  const ex = voice.exotel && voice.exotel.status === "active" ? voice.exotel : null;
  return (
    <div className="space-y-3">
      {ex ? (
        <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium" translate="no">
              {ex.number}
            </span>
            <Badge tone="success">connected</Badge>
            <span className="text-xs text-subtle">
              Exotel account …{ex.account} · {ex.region === "api.exotel.com" ? "Singapore" : "India"}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={relink.isPending} onClick={() => relink.mutate()}>
              New Voicebot link
            </Button>
            <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate();
          }}
          noValidate
        >
          <Field label="API key" hint="Exotel dashboard → Developer settings → API settings">
            <Input value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value.trim() })} autoComplete="off" />
          </Field>
          <Field label="API token" hint="Checked with Exotel, stored encrypted, never shown again">
            <Input type="password" value={f.api_token} onChange={(e) => setF({ ...f, api_token: e.target.value.trim() })} autoComplete="off" />
          </Field>
          <Field label="Account SID">
            <Input value={f.account_sid} onChange={(e) => setF({ ...f, account_sid: e.target.value.trim() })} autoComplete="off" />
          </Field>
          <Field label="ExoPhone (your Exotel number)">
            <Input value={f.exophone} onChange={(e) => setF({ ...f, exophone: e.target.value })} inputMode="tel" placeholder="080 4710 1234" />
          </Field>
          <Field label="Exotel region">
            <Select value={f.region} onChange={(e) => setF({ ...f, region: e.target.value as "api.in.exotel.com" })}>
              <option value="api.in.exotel.com">India (api.in.exotel.com)</option>
              <option value="api.exotel.com">Singapore (api.exotel.com)</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" loading={connect.isPending}>
              Connect Exotel number
            </Button>
          </div>
          <div className="sm:col-span-2">
            <FormError message={error} />
          </div>
        </form>
      )}
      {link ? (
        <Notice tone="warning" title="Copy this Voicebot link now (it is shown only once)">
          <code className="block break-all rounded bg-surface-2 p-2 text-xs" translate="no">
            {link}
          </code>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            icon={<Copy className="h-4 w-4" />}
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              toast.success("Copied");
            }}
          >
            Copy
          </Button>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
            <li>Exotel → App Bazaar → create a flow: Voicebot applet (paste this link, bidirectional), then a Hangup applet.</li>
            <li>Exotel → ExoPhones → set your number&apos;s flow to it.</li>
            <li>Switch answering on below and call your number.</li>
          </ol>
        </Notice>
      ) : null}
    </div>
  );
}

/** Whose speech-to-text and voice calls use; the business's own keys (BYOK). */
export function SpeechSettings({ ventureId, voice }: { ventureId: string; voice: Voice }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Schemas["SpeechIn"]>({
    twilio_mode: voice.twilio_mode,
    stt_provider: voice.stt_provider,
    tts_provider: voice.tts_provider,
    stt_model: voice.stt_model ?? "",
    tts_model: voice.tts_model ?? "",
    tts_voice: voice.tts_voice ?? "",
  });
  const [key, setKey] = useState<{ provider: KeyProvider; key: string; base_url: string }>({ provider: "sarvam", key: "", base_url: "" });
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const keys = voice.keys ?? [];
  const saved = new Set(keys.map((k) => k.provider));
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/voice/speech", {
          params: { path: { venture_id: ventureId } },
          body: { ...d, stt_model: d.stt_model || null, tts_model: d.tts_model || null, tts_voice: d.tts_voice || null },
        }),
      ),
    onSuccess: (v) => {
      setError(null);
      qc.setQueryData(voiceKey(ventureId), v);
      toast.success("Voice saved", v.voice_problem ?? undefined);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const putKey = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/ventures/{venture_id}/voice/keys/{provider}", {
          params: { path: { venture_id: ventureId, provider: key.provider } },
          body: { key: key.key.trim(), base_url: key.base_url.trim() || null },
        }),
      ),
    onSuccess: (v) => {
      setKey({ ...key, key: "", base_url: "" });
      qc.setQueryData(voiceKey(ventureId), v);
      toast.success(`${KEY_LABELS[key.provider]} key saved`);
    },
    onError: (e) => toast.error("Can't save the key", errorMessage(e)),
  });
  const dropKey = useMutation({
    mutationFn: (p: KeyProvider) => unwrap(api.DELETE("/ventures/{venture_id}/voice/keys/{provider}", { params: { path: { venture_id: ventureId, provider: p } } })),
    onSuccess: (v) => qc.setQueryData(voiceKey(ventureId), v),
    onError: (e) => toast.error("Can't remove the key", errorMessage(e)),
  });
  const hear = async () => {
    setPlaying(true);
    try {
      const { data, error: err, response } = await api.POST("/ventures/{venture_id}/voice/speech/test", {
        params: { path: { venture_id: ventureId } },
        body: {},
        parseAs: "blob",
      });
      if (err || !data) throw new Error(errorMessage(err) || `HTTP ${response.status}`);
      const url = URL.createObjectURL(data as Blob);
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      toast.error("Can't play the voice", e instanceof Error ? e.message : String(e));
    } finally {
      setPlaying(false);
    }
  };
  const missing = keyNeeded(d.stt_provider, d.tts_provider).filter((p) => !saved.has(p));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        On Exotel (and Twilio in &quot;Kritvia&apos;s voice&quot; mode) Kritvia listens and speaks itself. Use Kritvia&apos;s speech, your own keys, or the speech
        server on Kritvia&apos;s machine. Only the text of what was said is kept, never the audio.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Speech-to-text (hearing the caller)">
          <Select value={d.stt_provider} onChange={(e) => setD({ ...d, stt_provider: e.target.value as Stt })}>
            {Object.entries(STT_LABELS).map(([k, l]) => (
              <option key={k} value={k} disabled={k === "local" && !voice.local_available}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Voice (text-to-speech)">
          <Select value={d.tts_provider} onChange={(e) => setD({ ...d, tts_provider: e.target.value as Tts })}>
            {Object.entries(TTS_LABELS).map(([k, l]) => (
              <option key={k} value={k} disabled={(k === "local" && !voice.local_available) || (k === "platform" && !voice.platform_voice)}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Voice name (optional)" hint="e.g. anushka (Sarvam), marin (OpenAI), an ElevenLabs voice id, hf_alpha (local)">
          <Input value={d.tts_voice ?? ""} onChange={(e) => setD({ ...d, tts_voice: e.target.value })} maxLength={80} />
        </Field>
        <Field label="Models (optional)" hint="Speech-to-text model / voice model; empty = the provider's default">
          <div className="flex gap-2">
            <Input value={d.stt_model ?? ""} onChange={(e) => setD({ ...d, stt_model: e.target.value })} maxLength={80} aria-label="Speech-to-text model" placeholder="stt" />
            <Input value={d.tts_model ?? ""} onChange={(e) => setD({ ...d, tts_model: e.target.value })} maxLength={80} aria-label="Voice model" placeholder="voice" />
          </div>
        </Field>
        {voice.number ? (
          <Field label="On your Twilio number">
            <Select value={d.twilio_mode} onChange={(e) => setD({ ...d, twilio_mode: e.target.value as "gather" })}>
              <option value="gather">Twilio speaks and listens (Polly voices)</option>
              <option value="stream">Kritvia&apos;s voice (the settings above)</option>
            </Select>
          </Field>
        ) : null}
      </div>
      {missing.length ? <p className="text-xs text-warning">Save your {missing.map((m) => KEY_LABELS[m]).join(" and ")} key below.</p> : null}
      {voice.voice_problem ? <p className="text-xs text-subtle">Now: {voice.voice_problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save voice
        </Button>
        <Button variant="secondary" icon={<Play className="h-4 w-4" />} loading={playing} disabled={Boolean(voice.voice_problem)} onClick={() => void hear()}>
          Hear it
        </Button>
      </div>
      <FormError message={error} />

      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4 text-subtle" aria-hidden /> Your keys
        </p>
        {keys.length ? (
          <ul className="space-y-1 text-sm">
            {keys.map((k) => (
              <li key={k.provider} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {KEY_LABELS[k.provider]} <Badge tone="success">saved</Badge>
                  {k.base_url ? <span className="text-xs text-subtle"> · {k.base_url}</span> : null}
                  <span className="text-xs text-subtle"> · {formatRelative(k.updated_at)}</span>
                </span>
                <Button size="icon" variant="ghost" aria-label={`Remove the ${KEY_LABELS[k.provider]} key`} icon={<Trash2 className="h-4 w-4" />} onClick={() => dropKey.mutate(k.provider)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-subtle">No keys saved. Keys are stored encrypted and never shown again.</p>
        )}
        <form
          className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            putKey.mutate();
          }}
          noValidate
        >
          <Field label="Provider">
            <Select value={key.provider} onChange={(e) => setKey({ ...key, provider: e.target.value as KeyProvider })}>
              {Object.entries(KEY_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Key">
            <Input type="password" value={key.key} onChange={(e) => setKey({ ...key, key: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Server (OpenAI-compatible only)">
            <Input value={key.base_url} onChange={(e) => setKey({ ...key, base_url: e.target.value })} disabled={key.provider !== "openai"} placeholder="https://api.groq.com/openai/v1" />
          </Field>
          <Button type="submit" loading={putKey.isPending} disabled={key.key.trim().length < 8}>
            Save key
          </Button>
        </form>
      </div>
    </div>
  );
}
