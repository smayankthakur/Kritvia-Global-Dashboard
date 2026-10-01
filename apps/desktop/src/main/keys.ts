// Key maps between the web's KeyboardEvent.code names (what the server stores as the hotkey)
// and libuiohook keycodes (what the global hook reports), plus a US-layout character map for
// reconstructing what the user types after a paste (auto-learn).
//
// libuiohook keycodes are stable across platforms (they're its own VC_* set). Values below are
// UiohookKey from uiohook-napi; kept literal so this module is testable without the native addon.

export const UK = {
  Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Escape: 1, Space: 57,
  PageUp: 3657, PageDown: 3665, End: 3663, Home: 3655,
  ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424,
  Insert: 3666, Delete: 3667,
  D0: 11, D1: 2, D2: 3, D3: 4, D4: 5, D5: 6, D6: 7, D7: 8, D8: 9, D9: 10,
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38, M: 50,
  N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  F13: 91, F14: 92, F15: 93, F16: 99, F17: 100, F18: 101, F19: 102, F20: 103, F21: 104, F22: 105, F23: 106, F24: 107,
  Semicolon: 39, Equal: 13, Comma: 51, Minus: 12, Period: 52, Slash: 53, Backquote: 41,
  BracketLeft: 26, Backslash: 43, BracketRight: 27, Quote: 40,
  Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640, Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676,
  ScrollLock: 70,
} as const;

/** KeyboardEvent.code -> uiohook keycode, for every key the hotkey picker allows. */
const CODE_TO_UIOHOOK: Record<string, number> = {
  ControlLeft: UK.Ctrl, ControlRight: UK.CtrlRight, AltLeft: UK.Alt, AltRight: UK.AltRight,
  ShiftLeft: UK.Shift, ShiftRight: UK.ShiftRight, MetaLeft: UK.Meta, MetaRight: UK.MetaRight,
  CapsLock: UK.CapsLock, ScrollLock: UK.ScrollLock, Insert: UK.Insert, Backquote: UK.Backquote,
  Home: UK.Home, End: UK.End, PageUp: UK.PageUp, PageDown: UK.PageDown,
};
for (let i = 1; i <= 24; i++) CODE_TO_UIOHOOK[`F${i}`] = UK[`F${i}` as keyof typeof UK];

const UIOHOOK_TO_CODE: Record<number, string> = Object.fromEntries(
  Object.entries(CODE_TO_UIOHOOK).map(([code, kc]) => [kc, code]),
);

export const DEFAULT_HOTKEY = "ControlRight";

/** The uiohook keycode for a stored hotkey; unknown codes fall back to Right Ctrl. */
export function hotkeyToKeycode(code: string): number {
  return CODE_TO_UIOHOOK[code] ?? UK.CtrlRight;
}

export function isSupportedHotkey(code: string): boolean {
  return code in CODE_TO_UIOHOOK;
}

/** A name for any keycode, in KeyboardEvent.code style where we know it. */
export function keycodeToCode(keycode: number): string {
  return UIOHOOK_TO_CODE[keycode] ?? `uiohook:${keycode}`;
}

// --- characters (US layout) for keystroke reconstruction ---------------------------------
const LETTERS: Record<number, string> = {};
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") LETTERS[UK[ch as keyof typeof UK]] = ch.toLowerCase();
const DIGITS: [number, string, string][] = [
  [UK.D1, "1", "!"], [UK.D2, "2", "@"], [UK.D3, "3", "#"], [UK.D4, "4", "$"], [UK.D5, "5", "%"],
  [UK.D6, "6", "^"], [UK.D7, "7", "&"], [UK.D8, "8", "*"], [UK.D9, "9", "("], [UK.D0, "0", ")"],
];
const PUNCT: [number, string, string][] = [
  [UK.Semicolon, ";", ":"], [UK.Equal, "=", "+"], [UK.Comma, ",", "<"], [UK.Minus, "-", "_"],
  [UK.Period, ".", ">"], [UK.Slash, "/", "?"], [UK.Backquote, "`", "~"], [UK.BracketLeft, "[", "{"],
  [UK.Backslash, "\\", "|"], [UK.BracketRight, "]", "}"], [UK.Quote, "'", '"'], [UK.Space, " ", " "],
];
const SYMBOLS = new Map<number, [string, string]>([...DIGITS, ...PUNCT].map(([k, a, b]) => [k, [a, b]]));

/** The character a key types on a US layout, or null for non-character keys. */
export function charFor(keycode: number, shift: boolean, capsLock = false): string | null {
  const l = LETTERS[keycode];
  if (l) return shift !== capsLock ? l.toUpperCase() : l;
  const s = SYMBOLS.get(keycode);
  return s ? (shift ? s[1] : s[0]) : null;
}

export const MODIFIER_KEYCODES = new Set<number>([UK.Ctrl, UK.CtrlRight, UK.Alt, UK.AltRight, UK.Shift, UK.ShiftRight, UK.Meta, UK.MetaRight]);
