"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { initialVad, vadStep, type VadState } from "./vad";

export const MAX_RECORDING_MS = 5 * 60 * 1000;
/** People release the key ~100–250 ms after the last syllable; keep recording a moment longer (Scribe). */
export const TAIL_GRACE_MS = 200;

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

/** Why a recording ended by itself: the 5-minute cap, a pause after speech (hands-free), or silence. */
export type AutoStopReason = "limit" | "pause" | "nothing-heard";

export interface Recording {
  blob: Blob;
  durationMs: number;
}

/**
 * Microphone recorder with a live input level (0..1) for the widget's waveform.
 * `stop()` resolves with the audio; `cancel()` discards it.
 */
export function useLevelRecorder(onAutoStop?: (reason: AutoStopReason) => void) {
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const resolver = useRef<((r: Recording | null) => void) | null>(null);
  const discard = useRef(false);
  const vad = useRef<VadState | null>(null);
  const measureRef = useRef<(() => number) | null>(null);
  const vadTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStop = useRef(onAutoStop);
  autoStop.current = onAutoStop;

  const supported =
    typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

  const cleanup = useCallback(() => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (vadTimer.current) clearInterval(vadTimer.current);
    vadTimer.current = null;
    vad.current = null;
    measureRef.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
    setLevel(0);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  /** `handsFree`: finish by itself after the person pauses (click-started dictation). */
  const start = useCallback(async (opts?: { handsFree?: boolean }): Promise<string | null> => {
    if (!supported) return "Recording is not supported in this browser";
    if (rec.current && rec.current.state !== "inactive") return null;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      stream.current = s;
      const mime = pickMime();
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      discard.current = false;
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        const durationMs = Date.now() - startedAt.current;
        const blob =
          !discard.current && chunks.current.length
            ? new Blob(chunks.current, { type: r.mimeType || mime || "audio/webm" })
            : null;
        cleanup();
        setRecording(false);
        resolver.current?.(blob ? { blob, durationMs } : null);
        resolver.current = null;
      };
      rec.current = r;

      // input level for the waveform
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          audioCtx.current = ctx;
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          ctx.createMediaStreamSource(s).connect(analyser);
          const buf = new Uint8Array(analyser.fftSize);
          const measure = () => {
            analyser.getByteTimeDomainData(buf);
            let sum = 0;
            for (const v of buf) sum += ((v - 128) / 128) ** 2;
            return Math.min(1, Math.sqrt(sum / buf.length) * 3);
          };
          let last = 0;
          const tick = (t: number) => {
            if (t - last > 80) {
              // ~12 updates a second is plenty for a meter and keeps React renders cheap
              last = t;
              setLevel(Math.round(measure() * 20) / 20);
            }
            raf.current = requestAnimationFrame(tick);
          };
          raf.current = requestAnimationFrame(tick);
          // The pause detector runs on a timer, not animation frames: browsers pause those in a
          // background tab, and a hands-free dictation must still finish there.
          if (opts?.handsFree) {
            vad.current = initialVad;
            measureRef.current = measure;
          }
        }
      } catch {
        /* the level meter is cosmetic */
      }

      r.start(500);
      startedAt.current = Date.now();
      setElapsed(0);
      timer.current = setInterval(() => {
        const ms = Date.now() - startedAt.current;
        setElapsed(Math.floor(ms / 1000));
        if (ms >= MAX_RECORDING_MS) autoStop.current?.("limit");
      }, 250);
      if (vad.current && measureRef.current) {
        const measure = measureRef.current;
        let prev = Date.now();
        vadTimer.current = setInterval(() => {
          if (!vad.current) return;
          const now = Date.now();
          const [next, ev] = vadStep(vad.current, measure(), now - prev);
          prev = now;
          vad.current = next;
          if (ev) {
            vad.current = null; // fire once
            autoStop.current?.(ev === "finish" ? "pause" : "nothing-heard");
          }
        }, 100);
      }
      setRecording(true);
      return null;
    } catch (e) {
      cleanup();
      setRecording(false);
      return e instanceof Error && e.name === "NotAllowedError"
        ? "Microphone permission was denied — allow it in the browser's site settings"
        : "Could not start the microphone";
    }
  }, [supported, cleanup]);

  const finish = useCallback((drop: boolean, graceMs: number): Promise<Recording | null> => {
    const r = rec.current;
    if (!r || r.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      resolver.current = resolve;
      discard.current = drop;
      const halt = () => {
        if (r.state !== "inactive") r.stop();
      };
      if (graceMs > 0) setTimeout(halt, graceMs);
      else halt();
    });
  }, []);

  const stop = useCallback(() => finish(false, TAIL_GRACE_MS), [finish]);
  const cancel = useCallback(() => finish(true, 0).then(() => undefined), [finish]);

  return { supported, recording, level, elapsed, start, stop, cancel };
}
