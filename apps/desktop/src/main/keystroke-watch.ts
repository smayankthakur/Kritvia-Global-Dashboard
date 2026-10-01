// After pasting dictated text into another app, watch the next few keystrokes to see whether
// the user corrected a word (auto-learn). Ported from AIT-Scribe's KeystrokeCaptureWatcher
// (MIT, (c) AI Thinkers LLC): a virtual copy of the pasted text with a cursor at its end is
// edited by each observed key. Anything we can't follow exactly (shortcuts, up/down, a mouse
// click, a non-US character) abandons the watch — a wrong "correction" is worse than none.

import { detectCorrection, type Correction } from "../shared";
import { charFor, MODIFIER_KEYCODES, UK } from "./keys";

export interface KeyEventLike {
  keycode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export const WATCH_MS = 8_000;   // keystrokes are held in memory at most this long
export const IDLE_MS = 1_500;

export class KeystrokeBuffer {
  private buf: string;
  private cursor: number;
  abandoned = false;

  constructor(readonly pasted: string) {
    this.buf = pasted;
    this.cursor = pasted.length;
  }

  get text(): string {
    return this.buf;
  }

  /** Apply one key; returns "diff" when the user signalled they're done (Enter/Tab). */
  key(e: KeyEventLike): "continue" | "diff" | "abandon" {
    if (this.abandoned) return "abandon";
    if (MODIFIER_KEYCODES.has(e.keycode)) return "continue";
    if (e.ctrlKey || e.altKey || e.metaKey) return this.abandon();
    switch (e.keycode) {
      case UK.Enter:
      case UK.Tab:
        return "diff";
      case UK.Backspace:
        if (this.cursor > 0) {
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
          this.cursor--;
        }
        return "continue";
      case UK.Delete:
        this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
        return "continue";
      case UK.ArrowLeft:
        if (e.shiftKey) return this.abandon(); // selection: too hard to follow
        this.cursor = Math.max(0, this.cursor - 1);
        return "continue";
      case UK.ArrowRight:
        if (e.shiftKey) return this.abandon();
        this.cursor = Math.min(this.buf.length, this.cursor + 1);
        return "continue";
      case UK.CapsLock:
        return this.abandon();
    }
    const ch = charFor(e.keycode, e.shiftKey);
    if (ch === null) return this.abandon(); // Up/Down/Home/Esc/F-keys/IME…
    this.buf = this.buf.slice(0, this.cursor) + ch + this.buf.slice(this.cursor);
    this.cursor++;
    return "continue";
  }

  private abandon(): "abandon" {
    this.abandoned = true;
    this.buf = "";
    return "abandon";
  }

  /** A learnable correction of the pasted text, if the edits amount to one. */
  correction(): Correction | null {
    if (this.abandoned) return null;
    return detectCorrection(this.pasted, this.buf, "", "");
  }
}

export interface HookLike {
  on(ev: "keydown", fn: (e: KeyEventLike) => void): unknown;
  on(ev: "mousedown", fn: () => void): unknown;
  off(ev: "keydown", fn: (e: KeyEventLike) => void): unknown;
  off(ev: "mousedown", fn: () => void): unknown;
}

/** Watches the global hook for a correction of `pasted`; calls onCorrection at most once. */
export function watchForCorrection(hook: HookLike, pasted: string, onCorrection: (c: Correction) => void,
                                   timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }) {
  const buf = new KeystrokeBuffer(pasted);
  let idle: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  const finish = (check: boolean) => {
    if (done) return;
    done = true;
    if (idle) timers.clear(idle);
    timers.clear(limit);
    hook.off("keydown", onKey);
    hook.off("mousedown", onMouse);
    const c = check ? buf.correction() : null;
    if (c) onCorrection(c);
  };
  const onKey = (e: KeyEventLike) => {
    const r = buf.key(e);
    if (r === "abandon") return finish(false);
    if (r === "diff") return finish(true);
    if (idle) timers.clear(idle);
    idle = timers.set(() => finish(true), IDLE_MS);
  };
  const onMouse = () => finish(false); // clicking elsewhere moves the caret: we can no longer follow
  const limit = timers.set(() => finish(true), WATCH_MS);
  hook.on("keydown", onKey);
  hook.on("mousedown", onMouse);
  return { stop: () => finish(false), buffer: buf };
}
