/**
 * Hands-free finish for click-started dictation (the hold-to-talk hotkey never uses it).
 *
 * A click starts recording; once the person has spoken and then paused, the recording finishes
 * by itself and the text appears — no second click needed. If nothing is heard at all, it stops
 * and says so instead of listening forever. Fed the 0..1 input level ~12 times a second.
 */
export interface VadState {
  /** ms of input at speech level so far */
  speechMs: number;
  /** ms of continuous quiet since the last speech */
  quietMs: number;
  /** ms since recording started */
  totalMs: number;
}

export type VadEvent = "finish" | "nothing-heard" | null;

export const VAD = {
  /** level at or above which we count speech */
  speech: 0.15,
  /** level below which it is quiet (between the two keeps the current state: hysteresis) */
  quiet: 0.08,
  /** speech needed before a pause can finish the recording (a cough or click is not speech) */
  minSpeechMs: 300,
  /** pause that ends a hands-free dictation */
  pauseMs: 1600,
  /** give up when nothing has been heard for this long */
  nothingMs: 10_000,
} as const;

export const initialVad: VadState = { speechMs: 0, quietMs: 0, totalMs: 0 };

export function vadStep(s: VadState, level: number, dtMs: number): [VadState, VadEvent] {
  const totalMs = s.totalMs + dtMs;
  let { speechMs, quietMs } = s;
  if (level >= VAD.speech) {
    speechMs += dtMs;
    quietMs = 0;
  } else if (level < VAD.quiet) {
    quietMs += dtMs;
  }
  const next = { speechMs, quietMs, totalMs };
  if (speechMs >= VAD.minSpeechMs && quietMs >= VAD.pauseMs) return [next, "finish"];
  if (speechMs < VAD.minSpeechMs && totalMs >= VAD.nothingMs) return [next, "nothing-heard"];
  return [next, null];
}
