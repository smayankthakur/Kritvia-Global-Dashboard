import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KritviaClient, normaliseServer } from "../src/main/api";
import { charFor, hotkeyToKeycode, keycodeToCode, UK } from "../src/main/keys";
import { IDLE_MS, KeystrokeBuffer, watchForCorrection, type KeyEventLike } from "../src/main/keystroke-watch";
import { pasteText } from "../src/main/paste";
import { PrefsStore, SecureTokenStore } from "../src/main/store";
import { initialPtt, pttKeyDown, pttKeyUp } from "../src/shared";

const key = (keycode: number, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  keycode, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods,
});
const typeWord = (b: KeystrokeBuffer, w: string) => {
  for (const ch of w) {
    const upper = ch !== ch.toLowerCase();
    b.key(key(UK[ch.toUpperCase() as keyof typeof UK] as number, { shiftKey: upper }));
  }
};

describe("keys", () => {
  it("maps the stored hotkey to the hook's keycode and back", () => {
    expect(hotkeyToKeycode("ControlRight")).toBe(UK.CtrlRight);
    expect(hotkeyToKeycode("F8")).toBe(UK.F8);
    expect(hotkeyToKeycode("SomethingOdd")).toBe(UK.CtrlRight);
    expect(keycodeToCode(UK.AltRight)).toBe("AltRight");
  });
  it("knows US-layout characters", () => {
    expect(charFor(UK.A, false)).toBe("a");
    expect(charFor(UK.A, true)).toBe("A");
    expect(charFor(UK.D1, true)).toBe("!");
    expect(charFor(UK.Space, false)).toBe(" ");
    expect(charFor(UK.F5, false)).toBeNull();
  });
  it("push-to-talk works with hook events translated to codes", () => {
    let s = initialPtt;
    let ev;
    [s, ev] = pttKeyDown(s, { code: keycodeToCode(UK.CtrlRight), ctrlKey: true }, "ControlRight");
    expect(ev).toBe("start");
    [s, ev] = pttKeyUp(s, { code: keycodeToCode(UK.CtrlRight) }, "ControlRight");
    expect(ev).toBe("stop");
  });
});

describe("keystroke reconstruction (auto-learn)", () => {
  it("replacing the last word is a correction", () => {
    const b = new KeystrokeBuffer("send it to wisper");
    for (let i = 0; i < "wisper".length; i++) b.key(key(UK.Backspace));
    typeWord(b, "VSPR");
    expect(b.text).toBe("send it to VSPR");
    expect(b.correction()).toEqual({ heard: "wisper", correct: "VSPR" });
  });
  it("editing in the middle with arrow keys", () => {
    const b = new KeystrokeBuffer("call kritvia now");
    for (let i = 0; i < 4; i++) b.key(key(UK.ArrowLeft));          // before " now"
    for (let i = 0; i < 7; i++) b.key(key(UK.Backspace));          // delete "kritvia"
    typeWord(b, "Kritvia");
    expect(b.text).toBe("call Kritvia now");
    expect(b.correction()).toEqual({ heard: "kritvia", correct: "Kritvia" });
  });
  it("shortcuts, selections and unknown keys abandon", () => {
    const b = new KeystrokeBuffer("hello");
    expect(b.key(key(UK.Z, { ctrlKey: true }))).toBe("abandon");
    expect(b.correction()).toBeNull();
    expect(new KeystrokeBuffer("x").key(key(UK.ArrowLeft, { shiftKey: true }))).toBe("abandon");
    expect(new KeystrokeBuffer("x").key(key(UK.ArrowUp))).toBe("abandon");
  });
  it("typing more after the paste is not a correction", () => {
    const b = new KeystrokeBuffer("hello");
    b.key(key(UK.Space));
    typeWord(b, "there");
    expect(b.correction()).toBeNull();
  });
  it("the watcher reports once after the user goes idle, then unhooks", () => {
    vi.useFakeTimers();
    const handlers: Record<string, ((e?: KeyEventLike) => void)[]> = { keydown: [], mousedown: [] };
    const hook = {
      on: (ev: string, fn: (e?: KeyEventLike) => void) => handlers[ev]!.push(fn),
      off: (ev: string, fn: (e?: KeyEventLike) => void) => (handlers[ev] = handlers[ev]!.filter((f) => f !== fn)),
    };
    const found = vi.fn();
    watchForCorrection(hook as never, "ask wisper", found);
    const press = (k: KeyEventLike) => handlers.keydown!.forEach((f) => f(k));
    for (let i = 0; i < 6; i++) press(key(UK.Backspace));
    for (const ch of "VSPR") press(key(UK[ch as keyof typeof UK] as number, { shiftKey: true }));
    vi.advanceTimersByTime(IDLE_MS + 10);
    expect(found).toHaveBeenCalledWith({ heard: "wisper", correct: "VSPR" });
    expect(handlers.keydown).toHaveLength(0);
    expect(handlers.mousedown).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe("clipboard-safe paste", () => {
  function fakeClipboard(initial: string[]) {
    let items: string[] = [...initial];
    const deps = {
      get items() {
        return items;
      },
      saveClipboard: vi.fn(async () => {
        const copy = [...items];
        return async () => void (items = copy);
      }),
      writeText: vi.fn(async (t: string) => void (items = [t])),
      readText: vi.fn(async () => items[0] ?? ""),
      sendPasteShortcut: vi.fn(),
      sleep: async () => undefined,
    };
    return deps;
  }
  it("pastes and then restores what was copied before", async () => {
    const cb = fakeClipboard(["<b>copied</b>", "copied"]);
    await pasteText("dictated", cb);
    expect(cb.writeText).toHaveBeenCalledWith("dictated");
    expect(cb.sendPasteShortcut).toHaveBeenCalledOnce();
    expect(cb.items).toEqual(["<b>copied</b>", "copied"]);
  });
  it("does not overwrite something the user copied in the meantime", async () => {
    const cb = fakeClipboard(["old"]);
    cb.sendPasteShortcut.mockImplementation(() => void cb.writeText("new copy"));
    await pasteText("dictated", cb);
    expect(cb.items).toEqual(["new copy"]);
  });
  it("a clipboard that never answers does not hang dictation", async () => {
    const cb = fakeClipboard(["old"]);
    cb.saveClipboard.mockImplementation(() => new Promise(() => undefined));
    const t0 = Date.now();
    await pasteText("dictated", cb);
    expect(cb.sendPasteShortcut).toHaveBeenCalledOnce();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("API client", () => {
  const memStore = () => {
    let t: string | null = null;
    return { load: () => t, save: (v: string | null) => void (t = v) };
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("only talks to https servers (or this machine)", () => {
    expect(normaliseServer("api.example.com/")).toBe("https://api.example.com");
    expect(normaliseServer("http://localhost:8000")).toBe("http://localhost:8000");
    expect(() => normaliseServer("http://api.example.com")).toThrow(/https/);
    expect(() => normaliseServer("https://u:p@api.example.com")).toThrow();
  });

  it("refreshes once for concurrent 401s and rotates the stored token", async () => {
    const store = memStore();
    store.save("rt-1");
    let refreshes = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes++;
        expect(JSON.parse(String(init!.body)).refresh_token).toBe("rt-1");
        return json(200, { access_token: "at-2", refresh_token: "rt-2" });
      }
      const auth = (init!.headers as Record<string, string>).authorization;
      return auth === "Bearer at-2" ? json(200, { id: "u", email: "a@b.c", full_name: "A" }) : json(401, { detail: "expired" });
    });
    const c = new KritviaClient("https://api.example.com", store, fetcher as never);
    const [a, b] = await Promise.all([c.me(), c.me()]);
    expect(a.email).toBe("a@b.c");
    expect(b.email).toBe("a@b.c");
    expect(refreshes).toBe(1);
    expect(store.load()).toBe("rt-2");
  });

  it("a rejected refresh signs out", async () => {
    const store = memStore();
    store.save("stale");
    const c = new KritviaClient("https://api.example.com", store, (async () => json(401, { detail: "reused" })) as never);
    await expect(c.me()).rejects.toThrow(/Sign in/);
    expect(store.load()).toBeNull();
  });

  it("sends dictation as multipart with the desktop surface", async () => {
    const store = memStore();
    let body: FormData | null = null;
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/login")) return json(200, { access_token: "at", refresh_token: "rt" });
      body = init!.body as FormData;
      return json(200, { text: "hi", status: "ok" });
    };
    const c = new KritviaClient("https://api.example.com", store, fetcher as never);
    await c.login("a@b.c", "pw");
    await c.dictate("v1", new Uint8Array([1, 2, 3]), "audio/webm;codecs=opus", 1234.4, "note");
    expect(body!.get("surface")).toBe("desktop");
    expect(body!.get("mode")).toBe("note");
    expect(body!.get("duration_ms")).toBe("1234");
    expect((body!.get("file") as File).name).toBe("dictation.webm");
  });
});

describe("local storage", () => {
  it("keeps the refresh token encrypted, or only in memory without OS encryption", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kv-"));
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from([...s].reverse().join("")),
      decryptString: (b: Buffer) => [...b.toString()].reverse().join(""),
    };
    new SecureTokenStore(dir, crypto).save("secret-token");
    expect(fs.readFileSync(path.join(dir, "session.bin"), "utf8")).not.toContain("secret-token");
    expect(new SecureTokenStore(dir, crypto).load()).toBe("secret-token");

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "kv-"));
    const none = { ...crypto, isEncryptionAvailable: () => false };
    const s = new SecureTokenStore(dir2, none);
    s.save("t");
    expect(s.load()).toBe("t");
    expect(fs.existsSync(path.join(dir2, "session.bin"))).toBe(false);

    const p = new PrefsStore(dir);
    p.update({ mode: "note" });
    expect(new PrefsStore(dir).data.mode).toBe("note");
  });
});
