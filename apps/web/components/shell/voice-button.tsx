"use client";

import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useVoice } from "@/components/voice/voice-provider";
import { hotkeyLabel } from "@/lib/voice/hotkey";

/**
 * Header voice button: click to dictate into the field that last had focus (same pipeline as the
 * floating widget and the push-to-talk hotkey — vocabulary, cleanup and auto-learn included).
 */
export function VoiceButton() {
  const v = useVoice();
  const recording = v.phase === "recording";
  const busy = v.phase === "transcribing";
  const key = hotkeyLabel(v.settings.hotkey);
  const label = !v.available
    ? "Voice input needs a venture"
    : recording
      ? `Stop recording (${v.elapsed}s) and transcribe`
      : `Voice input: dictate into the focused field (or hold ${key})`;
  return (
    <Button
      variant={recording ? "danger" : "ghost"}
      size={recording ? "sm" : "icon"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={v.toggle}
      disabled={!v.available || busy}
      aria-label={label}
      aria-pressed={recording}
      title={label}
    >
      {busy ? <Spinner /> : recording ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-4 w-4" />}
      {recording ? <span className="tabular-nums">{v.elapsed}s</span> : null}
    </Button>
  );
}
