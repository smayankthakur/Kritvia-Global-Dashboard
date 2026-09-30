"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderState = "idle" | "recording" | "stopping";

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

export function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/** Microphone recording with MediaRecorder. `stop()` resolves with the recorded audio. */
export function useRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const resolver = useRef<((b: Blob | null) => void) | null>(null);

  const supported =
    typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

  const cleanup = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    if (!supported) {
      setError("Recording is not supported in this browser");
      return false;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const mime = pickMime();
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        const blob = chunks.current.length ? new Blob(chunks.current, { type: r.mimeType || mime || "audio/webm" }) : null;
        cleanup();
        setState("idle");
        resolver.current?.(blob);
        resolver.current = null;
      };
      rec.current = r;
      r.start(1000);
      setElapsed(0);
      const t0 = Date.now();
      timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
      setState("recording");
      return true;
    } catch (e) {
      cleanup();
      setError(e instanceof Error && e.name === "NotAllowedError" ? "Microphone permission was denied" : "Could not start the microphone");
      setState("idle");
      return false;
    }
  }, [supported, cleanup]);

  const stop = useCallback((): Promise<Blob | null> => {
    const r = rec.current;
    if (!r || r.state === "inactive") return Promise.resolve(null);
    setState("stopping");
    return new Promise((resolve) => {
      resolver.current = resolve;
      r.stop();
    });
  }, []);

  return { state, elapsed, error, supported, start, stop };
}

/** Insert text into an input/textarea so React's onChange fires. */
export function insertText(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const sep = before && !/\s$/.test(before) ? " " : "";
  const next = before + sep + text + after;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const pos = (before + sep + text).length;
  try {
    el.setSelectionRange(pos, pos);
  } catch {
    /* some input types do not support selection */
  }
  el.focus();
}
