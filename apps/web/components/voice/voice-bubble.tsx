"use client";

import { AlertCircle, Check, Copy, EyeOff, FileText, Keyboard, Mic, MessageCircleQuestion, Settings2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useAccess } from "@/lib/access";
import { hotkeyLabel } from "@/lib/voice/hotkey";
import { useVoice, type VoiceMode } from "./voice-provider";

const POS_KEY = "kv_voice_bubble_pos";
const SIZE = 52;
const MARGIN = 12;

interface Pos {
  right: number;
  bottom: number;
}

function loadPos(): Pos {
  try {
    const p = JSON.parse(window.localStorage.getItem(POS_KEY) ?? "null") as Pos | null;
    if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) return p;
  } catch {
    /* default position */
  }
  // bottom centre (Scribe's default) keeps clear of toasts, which stack bottom-right
  return { right: Math.round((window.innerWidth - SIZE) / 2), bottom: 20 };
}

function clamp(p: Pos): Pos {
  if (typeof window === "undefined") return p;
  const maxR = Math.max(MARGIN, window.innerWidth - SIZE - MARGIN);
  const maxB = Math.max(MARGIN, window.innerHeight - SIZE - MARGIN);
  return { right: Math.min(Math.max(MARGIN, p.right), maxR), bottom: Math.min(Math.max(MARGIN, p.bottom), maxB) };
}

/** Last few words: while speaking, the end of the sentence is what matters (Scribe truncates from the front). */
export function tail(text: string, max = 70): string {
  const t = text.trim();
  return t.length <= max ? t : "…" + t.slice(t.length - max + 1).replace(/^\S*\s/, "");
}

const MODES: { id: VoiceMode; label: string; icon: typeof Keyboard; hint: string }[] = [
  { id: "type", label: "Type", icon: Keyboard, hint: "Insert into the focused field" },
  { id: "note", label: "Note", icon: FileText, hint: "Save to Knowledge as a voice note" },
  { id: "ask", label: "Ask", icon: MessageCircleQuestion, hint: "Ask Kritvia a question" },
];

function Waveform({ level }: { level: number }) {
  const [hist, setHist] = useState<number[]>([0, 0, 0, 0, 0, 0, 0]);
  useEffect(() => setHist((h) => [...h.slice(1), level]), [level]);
  return (
    <div className="flex h-8 items-center gap-[3px]" aria-hidden>
      {hist.map((v, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-danger transition-[height] duration-100 motion-reduce:transition-none"
          style={{ height: `${Math.max(4, Math.round(v * 30))}px` }}
        />
      ))}
    </div>
  );
}

/** Floating dictation widget: hold the hotkey anywhere in Kritvia (or click) to dictate. */
export function VoiceBubble() {
  const v = useVoice();
  const { venture } = useAccess();
  const [pos, setPos] = useState<Pos>({ right: 24, bottom: 24 });
  const [hover, setHover] = useState(false);
  const drag = useRef<{ x: number; y: number; start: Pos; moved: boolean } | null>(null);

  useEffect(() => setPos(clamp(loadPos())), []);
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (e: RPointerEvent<HTMLButtonElement>) => {
    e.preventDefault(); // keep focus in the text field the user is dictating into
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: pos, moved: false };
  };
  const onPointerMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    setPos(clamp({ right: d.start.right - dx, bottom: d.start.bottom - dy }));
  };
  const onPointerUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      setPos((p) => {
        try {
          window.localStorage.setItem(POS_KEY, JSON.stringify(p));
        } catch {
          /* not remembered */
        }
        return p;
      });
    } else {
      v.toggle();
    }
  }, [v]);

  if (!v.available || !v.settings.widget_enabled) return null;

  if (v.snoozed) {
    return (
      <button
        type="button"
        onClick={v.unsnooze}
        className="fixed z-40 h-3 w-3 rounded-full bg-accent/70 shadow ring-2 ring-surface hover:scale-125"
        style={{ right: pos.right + SIZE / 2 - 6, bottom: pos.bottom + SIZE / 2 - 6 }}
        aria-label="Show the dictation widget"
        title="Show the dictation widget"
      />
    );
  }

  const key = hotkeyLabel(v.settings.hotkey);
  const recording = v.phase === "recording";
  const label =
    v.phase === "recording"
      ? `Listening… release ${key} to finish (${v.elapsed}s)`
      : v.phase === "transcribing"
        ? "Transcribing…"
        : v.message
          ? tail(v.message)
          : null;
  const ringColor =
    v.phase === "recording"
      ? "ring-danger"
      : v.phase === "transcribing"
        ? "ring-accent"
        : v.phase === "done"
          ? "ring-success"
          : v.phase === "error"
            ? "ring-danger"
            : "ring-border-strong";
  const icon =
    v.phase === "transcribing" ? (
      <Spinner />
    ) : v.phase === "done" ? (
      <Check className="h-5 w-5" />
    ) : v.phase === "error" ? (
      <AlertCircle className="h-5 w-5" />
    ) : (
      <Mic className="h-5 w-5" />
    );
  const modeInfo = MODES.find((m) => m.id === v.mode)!;

  return (
    // Hover or keyboard focus inside reveals the same controls (focus handlers below).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="fixed z-40 flex flex-col items-end gap-2"
      style={{ right: pos.right, bottom: pos.bottom }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false);
      }}
      data-voice-ignore
    >
      {v.learn ? (
        <div
          role="dialog"
          aria-label="Remember this correction?"
          className="glass-strong w-72 rounded-xl border p-3 text-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-subtle">Remember this?</div>
              <div className="mt-1 truncate">
                <span className="text-muted line-through decoration-danger/60">{v.learn.heard}</span>
                <span className="mx-1.5 text-subtle">→</span>
                <span className="font-semibold">{v.learn.correct}</span>
              </div>
            </div>
            <button type="button" onClick={v.dismissLearn} className="rounded p-0.5 text-subtle hover:text-fg" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => v.saveLearn("personal")}
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover"
            >
              Save for me
            </button>
            {venture?.access === "write" ? (
              <button
                type="button"
                onClick={() => v.saveLearn("shared")}
                className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2"
                title="Everyone in this venture, including meeting transcripts"
              >
                Save for the team
              </button>
            ) : null}
          </div>
        </div>
      ) : label ? (
        <div
          className="glass-strong max-w-[18rem] rounded-xl border px-3 py-1.5 text-[13px]"
          role="status"
          aria-live="polite"
        >
          {label}
          {v.phase === "done" && v.last?.text && v.mode === "type" ? (
            <button type="button" onClick={v.copyLast} className="ml-2 inline-flex align-middle text-subtle hover:text-fg" aria-label="Copy text">
              <Copy className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}

      {hover && !recording && v.phase !== "transcribing" && !v.learn ? (
        <div className="glass-strong flex items-center gap-1 rounded-xl border p-1" role="toolbar" aria-label="Dictation options">
          {MODES.map((m) => {
            const Icon = m.icon;
            const active = v.mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => v.setMode(m.id)}
                aria-pressed={active}
                title={m.hint}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md px-2 text-xs",
                  active ? "bg-accent-soft font-medium text-accent-soft-fg" : "text-muted hover:bg-surface-2",
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {m.label}
              </button>
            );
          })}
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          {venture ? (
            <Link
              href={`/v/${venture.venture_id}/voice?tab=settings`}
              className="flex h-7 w-7 items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg"
              title="Voice settings"
              aria-label="Voice settings"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => v.snooze(60)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-subtle hover:bg-surface-2 hover:text-fg"
            title="Hide for an hour"
            aria-label="Hide for an hour"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {recording ? <Waveform level={v.level} /> : null}
        <button
          type="button"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              v.toggle();
            }
          }}
          aria-label={recording ? "Stop and transcribe" : `Dictate (${modeInfo.label} mode). Hold ${key} or click. Drag to move.`}
          aria-pressed={recording}
          title={recording ? "Click to stop" : `Hold ${key} anywhere in Kritvia, or click — ${modeInfo.hint}`}
          className={cn(
            "relative flex cursor-grab touch-none items-center justify-center rounded-full shadow-[var(--shadow-lg)] ring-2 transition-colors select-none active:cursor-grabbing",
            ringColor,
            recording ? "bg-danger text-white" : "glass-strong text-fg hover:text-accent",
          )}
          style={{ width: SIZE, height: SIZE }}
        >
          {recording ? (
            <span
              className="absolute inset-0 rounded-full bg-danger/40 motion-safe:transition-transform"
              style={{ transform: `scale(${1 + v.level * 0.35})` }}
              aria-hidden
            />
          ) : null}
          <span className="relative">{icon}</span>
          {v.mode !== "type" && !recording ? (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-fg uppercase">
              {v.mode === "note" ? "N" : "?"}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
