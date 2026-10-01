// Type text into whatever app has focus: put it on the clipboard, send the paste shortcut,
// then put back everything the user had copied before — every format, not just text
// (Scribe v2.0.103: dictation must not clobber the clipboard).

export type Restore = () => Promise<void>;

export interface PasteDeps {
  /** Copy the current clipboard contents (all formats) and return a function that puts them back. */
  saveClipboard(): Promise<Restore>;
  writeText(t: string): Promise<void>;
  readText(): Promise<string>;
  /** sends Ctrl+V (Cmd+V on macOS) to the focused app */
  sendPasteShortcut(): void;
  sleep(ms: number): Promise<void>;
}

export const RESTORE_AFTER_MS = 450;

/** Never lets a clipboard quirk hang dictation: each step gives up after `ms`. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export async function pasteText(text: string, deps: PasteDeps): Promise<void> {
  const restore = await within<Restore | null>(deps.saveClipboard(), 1500, null);
  await deps.writeText(text);
  await deps.sleep(40); // let the clipboard settle before the target app reads it
  deps.sendPasteShortcut();
  await deps.sleep(RESTORE_AFTER_MS); // the target app reads the clipboard asynchronously
  if ((await within(deps.readText(), 1000, "")) !== text) return; // the user copied something new: keep it
  if (restore) await within(restore(), 1500, undefined);
}
