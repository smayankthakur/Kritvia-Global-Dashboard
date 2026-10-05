"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Keyboard, Mic, MicOff, PartyPopper, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage, unwrap } from "@/lib/api";
import { hotkeyLabel } from "@/lib/voice/hotkey";
import { useMicLevel } from "@/lib/voice/mic-level";
import { HotkeyCapture } from "./hotkey-capture";
import { useVoice, voiceSettingsKey } from "./voice-provider";

/**
 * "Set up your mic" — Scribe's try-it wizard: mic → key → try it → done.
 * Each step proves the thing works before moving on, so nobody is left talking to a mic that
 * never answers. Earlier steps collapse into ticked pills above the current one.
 */
type Stage = "mic" | "key" | "try" | "done";
const STAGES: { id: Stage; label: string }[] = [
  { id: "mic", label: "Microphone" },
  { id: "key", label: "Your key" },
  { id: "try", label: "Try it" },
  { id: "done", label: "Done" },
];
const PRESETS = ["ControlRight", "AltRight", "F8"];
const HEARD_LEVEL = 0.15;
const HEARD_MS = 400;
const SAMPLE = "Schedule the review with the team for Monday at 11.";

function Bars({ level, active }: { level: number; active: boolean }) {
  const [hist, setHist] = useState<number[]>(Array(11).fill(0));
  useEffect(() => setHist((h) => [...h.slice(1), level]), [level]);
  return (
    <div className="flex h-12 items-center justify-center gap-1" aria-hidden>
      {hist.map((v, i) => (
        <span
          key={i}
          className={cn("w-1.5 rounded-full transition-[height] duration-100 motion-reduce:transition-none", active ? "bg-success" : "bg-border-strong")}
          style={{ height: `${Math.max(6, Math.round(v * 44))}px` }}
        />
      ))}
    </div>
  );
}

export function MicWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const v = useVoice();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>("mic");
  const [heard, setHeard] = useState(false);
  const [hotkey, setHotkey] = useState(v.settings.hotkey);
  const [text, setText] = useState("");
  const [tried, setTried] = useState<"idle" | "ok" | "empty" | "error">("idle");
  const loudSince = useRef<number | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const testing = useRef(false);

  const [attempt, setAttempt] = useState(0);
  const mic = useMicLevel(open && stage === "mic", attempt);

  useEffect(() => {
    if (!open) return;
    setStage("mic");
    setHeard(false);
    setText("");
    setTried("idle");
    setHotkey(v.settings.hotkey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // "We can hear you" once the level stays up for a moment (a click or a bump is not a voice)
  useEffect(() => {
    if (stage !== "mic" || heard) return;
    if (mic.level >= HEARD_LEVEL) {
      loudSince.current ??= Date.now();
      if (Date.now() - loudSince.current >= HEARD_MS) setHeard(true);
    } else if (mic.level < 0.08) {
      loudSince.current = null;
    }
  }, [mic.level, stage, heard]);

  // the try-it result: words in the box = it works; otherwise a gentle nudge to retry
  useEffect(() => {
    if (stage !== "try" || !testing.current) return;
    if (v.phase === "done" && v.last) {
      testing.current = false;
      setTried(v.last.status === "ok" && v.last.text ? "ok" : "empty");
    } else if (v.phase === "error") {
      testing.current = false;
      setTried(v.last?.status === "no_speech" || v.last?.status === "too_short" ? "empty" : "error");
    }
  }, [v.phase, v.last, stage]);

  const saveKey = useMutation({
    mutationFn: (code: string) => unwrap(api.PUT("/me/voice-settings", { body: { ...v.settings, hotkey: code } })),
    onSuccess: (d) => {
      qc.setQueryData(voiceSettingsKey, d);
      setStage("try");
    },
  });

  const recording = v.phase === "recording";
  const busy = v.phase === "transcribing";
  const idx = STAGES.findIndex((s) => s.id === stage);

  const startTry = () => {
    box.current?.focus();
    setTried("idle");
    testing.current = true;
    v.toggle();
  };

  // starting with the hotkey counts as a try too
  useEffect(() => {
    if (stage === "try" && recording) {
      testing.current = true;
      setTried("idle");
    }
  }, [stage, recording]);

  const close = () => {
    if (recording) v.cancel();
    onClose();
  };

  let body: React.ReactNode;
  let footer: React.ReactNode;

  if (stage === "mic") {
    const status = mic.status;
    body = (
      <div className="space-y-4 text-center">
        <div className={cn("mx-auto flex h-16 w-16 items-center justify-center rounded-full", heard ? "bg-success-soft text-success-fg" : "bg-accent-soft text-accent-soft-fg")}>
          {status === "denied" || status === "no-device" || status === "error" ? <MicOff className="h-7 w-7" /> : heard ? <Check className="h-7 w-7" /> : <Mic className="h-7 w-7" />}
        </div>
        <Bars level={mic.level} active={heard} />
        <p className="text-sm" role="status" aria-live="polite">
          {status === "asking"
            ? "Allow the microphone when your browser asks."
            : status === "denied"
              ? "The microphone is blocked. Click the lock icon in the address bar, allow Microphone, then try again."
              : status === "no-device"
                ? "No microphone found. Plug one in (or check your headset), then try again."
                : status === "error"
                  ? "We couldn't open the microphone. Close other apps using it, then try again."
                  : heard
                    ? "We can hear you. Your mic is working."
                    : "Say a few words — the bars move when we hear you."}
        </p>
        {status === "denied" || status === "no-device" || status === "error" ? (
          <Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>
        ) : null}
      </div>
    );
    footer = (
      <Button variant="primary" disabled={!heard} onClick={() => setStage("key")}>
        Next
      </Button>
    );
  } else if (stage === "key") {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Two ways to dictate. <strong className="text-fg">Click the mic and speak</strong> — Kritvia finishes by itself when you pause. Or{" "}
          <strong className="text-fg">hold a key</strong> while you speak and let go when you&apos;re done. Pick the key:
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Push-to-talk key">
          {PRESETS.map((code) => (
            <button
              key={code}
              type="button"
              role="radio"
              aria-checked={hotkey === code}
              onClick={() => setHotkey(code)}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm",
                hotkey === code ? "border-accent bg-accent-soft font-medium text-accent-soft-fg" : "border-border hover:bg-surface-2",
              )}
            >
              <Keyboard className="h-3.5 w-3.5" aria-hidden /> {hotkeyLabel(code)}
            </button>
          ))}
        </div>
        <div className="text-sm text-muted">
          <div className="mb-1.5">Or choose your own:</div>
          <HotkeyCapture value={hotkey} onChange={setHotkey} />
        </div>
        {saveKey.isError ? <p className="text-xs text-danger">{errorMessage(saveKey.error)}</p> : null}
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStage("mic")}>
          Back
        </Button>
        <Button
          variant="primary"
          loading={saveKey.isPending}
          onClick={() => (hotkey === v.settings.hotkey ? setStage("try") : saveKey.mutate(hotkey))}
        >
          Next
        </Button>
      </>
    );
  } else if (stage === "try") {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Click the mic and read this out, then pause — or hold <kbd className="rounded border border-border-strong bg-surface-2 px-1.5 font-sans text-xs">{hotkeyLabel(v.settings.hotkey)}</kbd> while you say it:
        </p>
        <blockquote className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">“{SAMPLE}”</blockquote>
        <Textarea
          ref={box}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your words appear here…"
          aria-label="Try dictation here"
          autoFocus
        />
        <div className="flex items-center gap-3">
          <Button
            variant={recording ? "danger" : "primary"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (recording ? v.stop() : startTry())}
            disabled={busy}
            aria-label={recording ? "Finish now" : "Click and speak"}
          >
            {busy ? <Spinner /> : recording ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-4 w-4" />}
            {busy ? "Writing it down…" : recording ? `Listening… pause to finish (${v.elapsed}s)` : "Click and speak"}
          </Button>
        </div>
        <p className="min-h-5 text-sm" role="status" aria-live="polite">
          {tried === "ok"
            ? "That's it — your words land wherever your cursor is."
            : tried === "empty"
              ? "We didn't catch any words. Speak a little louder or closer to the mic, then try again."
              : tried === "error"
                ? (v.message ?? "Something went wrong. Try again in a moment.")
                : ""}
        </p>
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={() => setStage("key")}>
          Back
        </Button>
        <Button variant="primary" disabled={tried !== "ok"} onClick={() => setStage("done")}>
          Next
        </Button>
      </>
    );
  } else {
    body = (
      <div className="space-y-3 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success-fg">
          <PartyPopper className="h-6 w-6" aria-hidden />
        </div>
        <p className="font-medium">You&apos;re all set.</p>
        <ul className="mx-auto max-w-sm space-y-1.5 text-left text-sm text-muted">
          <li>• Click into any text box, then click the mic and speak — it stops when you pause.</li>
          <li>
            • Or hold <strong className="text-fg">{hotkeyLabel(v.settings.hotkey)}</strong> anywhere in Kritvia while you speak.
          </li>
          <li>• Hover the floating mic for Note (save to Knowledge) and Ask (ask Kritvia) modes.</li>
        </ul>
      </div>
    );
    footer = (
      <Button variant="primary" onClick={v.finishSetup}>
        Start dictating
      </Button>
    );
  }

  return (
    <Dialog open={open} onClose={close} title="Set up your mic" size="md" footer={footer}>
      <ol className="mb-5 flex flex-wrap items-center gap-1.5" aria-label="Steps">
        {STAGES.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === idx ? "step" : undefined}
            className={cn(
              "flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs",
              i < idx ? "bg-success-soft text-success-fg" : i === idx ? "bg-accent-soft font-medium text-accent-soft-fg" : "bg-surface-2 text-subtle",
            )}
          >
            {i < idx ? <Check className="h-3 w-3" aria-hidden /> : null}
            {s.label}
          </li>
        ))}
      </ol>
      {body}
    </Dialog>
  );
}
