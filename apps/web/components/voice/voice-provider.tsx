"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { extensionFor, insertText } from "@/lib/recorder";
import { initialPtt, pttKeyDown, pttKeyUp } from "@/lib/voice/hotkey";
import { detectCorrection, type Correction } from "@/lib/voice/learn";
import { useLevelRecorder, type AutoStopReason } from "@/lib/voice/recorder";
import { MicWizard } from "./mic-wizard";

export type VoiceSettings = Schemas["VoiceSettings"];
export type DictationResult = Schemas["DictationOut"];
export type VoiceMode = "type" | "note" | "ask";
export type Phase = "idle" | "recording" | "transcribing" | "done" | "error";

export const voiceSettingsKey = ["me", "voice-settings"] as const;
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  engine: "auto",
  language: "auto",
  remove_fillers: true,
  profanity_filter: false,
  auto_learn: false,
  hotkey: "ControlRight",
  widget_enabled: true,
};

type Editable = HTMLInputElement | HTMLTextAreaElement;
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", ""]);
const SNOOZE_KEY = "kv_voice_snooze_until";
const MODE_KEY = "kv_voice_mode";
/** Set once the person has been through "Set up your mic" (per browser, like Scribe's onboarding). */
const SETUP_KEY = "kv_voice_setup_v1";
const LEARN_PROMPT_MS = 15_000;
const LEARN_IDLE_MS = 1_500;
const LEARN_WATCH_MS = 30_000;

export function isEditable(el: Element | null): el is Editable {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preferences just aren't remembered */
  }
}

interface VoiceCtx {
  available: boolean;
  supported: boolean;
  phase: Phase;
  level: number;
  elapsed: number;
  message: string | null;
  last: DictationResult | null;
  mode: VoiceMode;
  setMode: (m: VoiceMode) => void;
  settings: VoiceSettings;
  /** Click/tap: start hands-free (finishes by itself after a pause) or stop. */
  toggle: () => void;
  start: (opts?: { handsFree?: boolean }) => void;
  /** True while a click-started recording is listening for the pause that ends it. */
  handsFree: boolean;
  /** Whether "Set up your mic" has been completed in this browser. */
  setupDone: boolean;
  openSetup: () => void;
  finishSetup: () => void;
  stop: () => void;
  cancel: () => void;
  learn: Correction | null;
  saveLearn: (scope?: "personal" | "shared") => void;
  dismissLearn: () => void;
  snoozed: boolean;
  snooze: (minutes: number) => void;
  unsnooze: () => void;
  /** AppShell registers how dictated questions are asked (opens the Ask dialog). */
  setAskHandler: (fn: ((q: string) => void) | null) => void;
  copyLast: () => void;
}

const Ctx = createContext<VoiceCtx | null>(null);

export function useVoice(): VoiceCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useVoice() outside VoiceProvider");
  return c;
}

export function useVoiceSettings() {
  return useQuery({ queryKey: voiceSettingsKey, queryFn: () => unwrap(api.GET("/me/voice-settings")), staleTime: 5 * 60_000 });
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { venture } = useAccess();
  const toast = useToast();
  const qc = useQueryClient();
  const settingsQ = useVoiceSettings();
  const settings = settingsQ.data ?? DEFAULT_VOICE_SETTINGS;

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [last, setLast] = useState<DictationResult | null>(null);
  const [mode, setModeState] = useState<VoiceMode>("type");
  const [learn, setLearn] = useState<Correction | null>(null);
  const [snoozeUntil, setSnoozeUntil] = useState<number>(0);
  const [handsFree, setHandsFree] = useState(false);
  const [setupDone, setSetupDone] = useState(true);
  const [setupOpen, setSetupOpen] = useState(false);
  const target = useRef<Editable | null>(null);
  const askHandler = useRef<((q: string) => void) | null>(null);
  const phaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const learnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchCleanup = useRef<(() => void) | null>(null);
  const session = useRef(0);
  const autoStopRef = useRef<(reason: AutoStopReason) => void>(() => undefined);
  const rec = useLevelRecorder((reason) => autoStopRef.current(reason));

  useEffect(() => {
    const m = readStore(MODE_KEY);
    if (m === "type" || m === "note" || m === "ask") setModeState(m);
    const s = Number(readStore(SNOOZE_KEY) ?? 0);
    if (s > Date.now()) setSnoozeUntil(s);
    setSetupDone(readStore(SETUP_KEY) === "1");
  }, []);

  const openSetup = useCallback(() => setSetupOpen(true), []);
  const finishSetup = useCallback(() => {
    writeStore(SETUP_KEY, "1");
    setSetupDone(true);
    setSetupOpen(false);
  }, []);

  const setMode = useCallback((m: VoiceMode) => {
    setModeState(m);
    writeStore(MODE_KEY, m);
  }, []);

  // remember the last text field that had focus: that's where dictation goes
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const el = e.target as Element | null;
      if (isEditable(el) && !el.closest("[data-voice-ignore]")) target.current = el;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  const settle = useCallback((p: Phase, msg: string | null, ms: number) => {
    setPhase(p);
    setMessage(msg);
    if (phaseTimer.current) clearTimeout(phaseTimer.current);
    phaseTimer.current = setTimeout(() => {
      setPhase("idle");
      setMessage(null);
    }, ms);
  }, []);

  const dismissLearn = useCallback(() => {
    if (learnTimer.current) clearTimeout(learnTimer.current);
    setLearn(null);
  }, []);

  const presentLearn = useCallback(
    (c: Correction) => {
      if (learnTimer.current) clearTimeout(learnTimer.current);
      setLearn(c);
      learnTimer.current = setTimeout(() => setLearn(null), LEARN_PROMPT_MS);
    },
    [],
  );

  /** After inserting, watch the field: a one-word fix of what we typed becomes a learn prompt. */
  const watchForCorrection = useCallback(
    (el: Editable, inserted: string, before: string, after: string) => {
      watchCleanup.current?.();
      let idle: ReturnType<typeof setTimeout> | null = null;
      const check = () => {
        const c = detectCorrection(inserted, el.value, before, after);
        if (c) {
          presentLearn(c);
          stopWatching();
        }
      };
      const onInput = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(check, LEARN_IDLE_MS);
      };
      const onBlur = () => {
        check();
        stopWatching();
      };
      const limit = setTimeout(() => stopWatching(), LEARN_WATCH_MS);
      function stopWatching() {
        if (idle) clearTimeout(idle);
        clearTimeout(limit);
        el.removeEventListener("input", onInput);
        el.removeEventListener("blur", onBlur);
        watchCleanup.current = null;
      }
      el.addEventListener("input", onInput);
      el.addEventListener("blur", onBlur);
      watchCleanup.current = stopWatching;
    },
    [presentLearn],
  );

  useEffect(() => () => watchCleanup.current?.(), []);

  const learnMut = useMutation({
    mutationFn: ({ c, scope }: { c: Correction; scope: "personal" | "shared" }) =>
      unwrap(
        api.POST("/ventures/{venture_id}/vocabulary/learn", {
          params: { path: { venture_id: venture!.venture_id } },
          body: { heard: c.heard, correct: c.correct, scope, save: true },
        }),
      ),
    onSuccess: (r) => {
      if (r.learned) toast.success("Added to your vocabulary", `“${r.heard}” → “${r.correct}”`);
      void qc.invalidateQueries({ queryKey: ["vocabulary"] });
    },
    onError: (e) => toast.error("Could not save the word", errorMessage(e)),
  });

  const saveLearn = useCallback(
    (scope: "personal" | "shared" = "personal") => {
      if (learn && venture) learnMut.mutate({ c: learn, scope });
      dismissLearn();
    },
    [learn, venture, learnMut, dismissLearn],
  );

  const deliver = useCallback(
    async (out: DictationResult, usedMode: VoiceMode) => {
      setLast(out);
      if (out.status === "too_short") return settle("error", "Too short — hold the key while you speak", 2500);
      if (out.status === "no_speech") return settle("error", "No speech detected — try speaking a bit louder", 3000);
      if (out.fallback) toast.info(`${settings.engine === "sarvam" ? "Sarvam" : "Your engine"} was unavailable`, `Transcribed with ${out.engine} instead.`);
      if (usedMode === "note") {
        void qc.invalidateQueries({ queryKey: ["documents"] });
        return settle("done", "Saved to Knowledge as a voice note", 3000);
      }
      if (usedMode === "ask") {
        if (askHandler.current) askHandler.current(out.text);
        return settle("done", out.text, 2500);
      }
      const el = target.current && document.contains(target.current) ? target.current : null;
      if (el) {
        const { before, after } = insertText(el, out.text);
        if (settings.auto_learn) watchForCorrection(el, out.text, before, after);
        return settle("done", out.text, 2500);
      }
      // No text box had focus: keep the words on the clipboard and say so plainly.
      await navigator.clipboard?.writeText(out.text).catch(() => undefined);
      return settle("done", `No text box selected — copied, paste with Ctrl+V: ${out.text}`, 6000);
    },
    [settle, toast, settings.engine, settings.auto_learn, qc, watchForCorrection],
  );

  const transcribe = useCallback(
    async (blob: Blob, durationMs: number, usedMode: VoiceMode, id: number) => {
      if (!venture) return;
      setPhase("transcribing");
      setMessage(null);
      try {
        const file = new File([blob], `voice.${extensionFor(blob.type)}`, { type: blob.type });
        const out = await unwrap(
          api.POST("/ventures/{venture_id}/voice/dictate", {
            params: { path: { venture_id: venture.venture_id } },
            body: multipart<Schemas["Body_dictate_endpoint_ventures__venture_id__voice_dictate_post"]>({
              file,
              sensitive: false,
              mode: usedMode,
              surface: "web",
              duration_ms: Math.round(durationMs),
              engine: null,
              language: null,
            }),
          }),
        );
        if (id !== session.current) return; // a newer recording started; don't clobber it (Scribe's stale-session guard)
        await deliver(out, usedMode);
      } catch (e) {
        if (id !== session.current) return;
        settle("error", errorMessage(e), 5000);
      }
    },
    [venture, deliver, settle],
  );

  const start = useCallback(
    (opts?: { handsFree?: boolean }) => {
      if (!venture || rec.recording) return;
      session.current += 1;
      if (phaseTimer.current) clearTimeout(phaseTimer.current);
      setPhase("recording");
      setMessage(null);
      setHandsFree(Boolean(opts?.handsFree));
      void rec.start({ handsFree: opts?.handsFree }).then((err) => {
        if (err) settle("error", err, 5000);
      });
    },
    [venture, rec, settle],
  );

  const stop = useCallback(() => {
    if (!rec.recording) return;
    const id = session.current;
    const usedMode = mode;
    void rec.stop().then((r) => {
      if (!r) {
        if (id === session.current) setPhase("idle");
        return;
      }
      void transcribe(r.blob, r.durationMs, usedMode, id);
    });
  }, [rec, mode, transcribe]);

  const cancel = useCallback(() => {
    session.current += 1;
    void rec.cancel();
    setPhase("idle");
    setMessage(null);
  }, [rec]);

  autoStopRef.current = (reason) => {
    if (reason !== "nothing-heard") return stop();
    session.current += 1;
    void rec.cancel();
    settle("error", "Didn't hear anything — check your mic isn't muted, or run Set up your mic in Voice settings", 6000);
  };

  const toggle = useCallback(() => (rec.recording ? stop() : start({ handsFree: true })), [rec.recording, start, stop]);

  // push-to-talk hotkey (works anywhere in the app; the desktop companion covers other apps)
  const ptt = useRef(initialPtt);
  useEffect(() => {
    if (!venture) return;
    const hotkey = settings.hotkey;
    const down = (e: KeyboardEvent) => {
      if (document.body.dataset.voiceCapture) return;
      const [next, ev] = pttKeyDown(ptt.current, e, hotkey);
      ptt.current = next;
      if (ev === "start") start({ handsFree: false });
      else if (ev === "cancel") cancel();
      if (e.key === "Escape" && rec.recording) cancel();
    };
    const up = (e: KeyboardEvent) => {
      const [next, ev] = pttKeyUp(ptt.current, e, hotkey);
      ptt.current = next;
      if (ev === "stop") stop();
    };
    const blur = () => {
      if (ptt.current.held) {
        ptt.current = initialPtt;
        stop();
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, [venture, settings.hotkey, start, stop, cancel, rec.recording]);

  const snooze = useCallback((minutes: number) => {
    const until = Date.now() + minutes * 60_000;
    setSnoozeUntil(until);
    writeStore(SNOOZE_KEY, String(until));
  }, []);
  const unsnooze = useCallback(() => {
    setSnoozeUntil(0);
    writeStore(SNOOZE_KEY, null);
  }, []);
  useEffect(() => {
    if (!snoozeUntil) return;
    const t = setTimeout(() => setSnoozeUntil(0), Math.max(0, snoozeUntil - Date.now()));
    return () => clearTimeout(t);
  }, [snoozeUntil]);

  const setAskHandler = useCallback((fn: ((q: string) => void) | null) => {
    askHandler.current = fn;
  }, []);

  const copyLast = useCallback(() => {
    if (last?.text) void navigator.clipboard?.writeText(last.text).then(() => toast.success("Copied"));
  }, [last, toast]);

  const value = useMemo<VoiceCtx>(
    () => ({
      available: Boolean(venture),
      supported: rec.supported,
      phase: rec.recording ? "recording" : phase,
      level: rec.level,
      elapsed: rec.elapsed,
      message,
      last,
      mode,
      setMode,
      settings,
      toggle,
      start,
      handsFree,
      setupDone,
      openSetup,
      finishSetup,
      stop,
      cancel,
      learn,
      saveLearn,
      dismissLearn,
      snoozed: snoozeUntil > Date.now(),
      snooze,
      unsnooze,
      setAskHandler,
      copyLast,
    }),
    [venture, rec.supported, rec.recording, rec.level, rec.elapsed, phase, message, last, mode, setMode, settings, toggle,
      start, handsFree, setupDone, openSetup, finishSetup, stop, cancel, learn, saveLearn, dismissLearn, snoozeUntil,
      snooze, unsnooze, setAskHandler, copyLast],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      {venture ? <MicWizard open={setupOpen} onClose={() => setSetupOpen(false)} /> : null}
    </Ctx.Provider>
  );
}
