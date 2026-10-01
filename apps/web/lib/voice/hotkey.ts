// Push-to-talk: hold one key to record, release to transcribe (Scribe's interaction).
// Pressing any other key while it is held means the user is typing a shortcut (Ctrl+C with
// Right-Ctrl as the hotkey), so the recording is cancelled, not transcribed.

export type PttEvent = "start" | "stop" | "cancel" | null;

export interface PttState {
  held: boolean;
  /** another key went down while the hotkey was held */
  chorded: boolean;
}

export const initialPtt: PttState = { held: false, chorded: false };

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

export interface KeyLike {
  code: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** Other modifiers already down when the hotkey is pressed = a chord (Cmd+Shift+4), not dictation. */
function otherModifiersDown(e: KeyLike, hotkey: string): boolean {
  const own = (k: string) => hotkey.startsWith(k);
  return (
    (Boolean(e.ctrlKey) && !own("Control")) ||
    (Boolean(e.altKey) && !own("Alt")) ||
    (Boolean(e.metaKey) && !own("Meta")) ||
    (Boolean(e.shiftKey) && !own("Shift"))
  );
}

export function pttKeyDown(state: PttState, e: KeyLike, hotkey: string): [PttState, PttEvent] {
  if (e.code === hotkey) {
    if (state.held || e.repeat) return [state, null];
    if (otherModifiersDown(e, hotkey)) return [{ held: false, chorded: false }, null];
    return [{ held: true, chorded: false }, "start"];
  }
  if (state.held && !state.chorded) return [{ held: true, chorded: true }, "cancel"];
  return [state, null];
}

export function pttKeyUp(state: PttState, e: KeyLike, hotkey: string): [PttState, PttEvent] {
  if (e.code !== hotkey || !state.held) return [state, null];
  return [initialPtt, state.chorded ? null : "stop"];
}

/** Human label for a KeyboardEvent.code. */
export function hotkeyLabel(code: string): string {
  const map: Record<string, string> = {
    ControlRight: "Right Ctrl",
    ControlLeft: "Left Ctrl",
    AltRight: "Right Alt",
    AltLeft: "Left Alt",
    ShiftRight: "Right Shift",
    ShiftLeft: "Left Shift",
    MetaRight: "Right ⌘/Win",
    MetaLeft: "Left ⌘/Win",
    Backquote: "`",
    CapsLock: "Caps Lock",
    ScrollLock: "Scroll Lock",
    Pause: "Pause",
    Insert: "Insert",
  };
  if (map[code]) return map[code];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** Keys that would break normal typing if held for dictation are refused. */
export function isAllowedHotkey(code: string): boolean {
  if (!/^[A-Za-z0-9]{2,24}$/.test(code)) return false;
  if (code.startsWith("Key") || code.startsWith("Digit")) return false;
  return !["Space", "Enter", "Tab", "Backspace", "Escape", "Delete"].includes(code);
}
