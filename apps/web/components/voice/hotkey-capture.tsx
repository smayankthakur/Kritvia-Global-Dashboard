"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { hotkeyLabel, isAllowedHotkey } from "@/lib/voice/hotkey";

/** Click "Change", press a key: it becomes the push-to-talk key (keys that type text are refused). */
export function HotkeyCapture({ value, onChange }: { value: string; onChange: (code: string) => void }) {
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
