"use client";

import { Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { extensionFor, insertText, useRecorder } from "@/lib/recorder";

type Editable = HTMLInputElement | HTMLTextAreaElement;
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", ""]);

function isEditable(el: Element | null): el is Editable {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

/**
 * Voice input: records a short note, transcribes it with the venture's speech tier and
 * inserts the text into the field that last had focus (or the Ask box).
 */
export function VoiceButton() {
  const { venture } = useAccess();
  const toast = useToast();
  const rec = useRecorder();
  const [busy, setBusy] = useState(false);
  const target = useRef<Editable | null>(null);

  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target as Element | null;
      if (isEditable(el)) target.current = el;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  const toggle = async () => {
    if (!venture) return;
    if (rec.state === "recording") {
      const blob = await rec.stop();
      if (!blob) return;
      setBusy(true);
      try {
        const file = new File([blob], `voice.${extensionFor(blob.type)}`, { type: blob.type });
        const out = await unwrap(
          api.POST("/ventures/{venture_id}/transcribe", {
            params: { path: { venture_id: venture.venture_id } },
            body: multipart<Schemas["Body_voice_input_ventures__venture_id__transcribe_post"]>({ file, sensitive: false }),
          }),
        );
        const text = out.text.trim();
        const el = target.current && document.contains(target.current) ? target.current : null;
        if (!text) toast.info("No speech detected");
        else if (el) insertText(el, text);
        else {
          await navigator.clipboard?.writeText(text).catch(() => undefined);
          toast.info("Transcribed (copied to clipboard)", text);
        }
      } catch (e) {
        toast.error("Voice input failed", errorMessage(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    const ok = await rec.start();
    if (!ok && rec.error) toast.error(rec.error);
  };

  const recording = rec.state === "recording";
  const label = !venture
    ? "Voice input needs a venture"
    : recording
      ? `Stop recording (${rec.elapsed}s) and transcribe`
      : "Voice input: dictate into the focused field";
  return (
    <Button
      variant={recording ? "danger" : "ghost"}
      size={recording ? "sm" : "icon"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      disabled={!venture || busy || rec.state === "stopping"}
      aria-label={label}
      aria-pressed={recording}
      title={label}
    >
      {busy ? <Spinner /> : recording ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-4 w-4" />}
      {recording ? <span className="tabular-nums">{rec.elapsed}s</span> : null}
    </Button>
  );
}
