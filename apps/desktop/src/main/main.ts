// Kritvia Voice — desktop companion.
//
// Hold the push-to-talk key in any app, speak, release: the audio goes to Kritvia's
// /voice/dictate (your engine, language, vocabulary and filters) and the text is pasted where
// your cursor is. A one-word fix right after the paste offers "Remember this?" (auto-learn).
// Note mode saves the dictation to the venture's knowledge base instead of typing it.

import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { ApiError, KritviaClient, normaliseServer, type Dictation, type Venture, type VoiceSettings } from "./api";
import { DEFAULT_HOTKEY, isSupportedHotkey, keycodeToCode, UK } from "./keys";
import { watchForCorrection, type HookLike, type KeyEventLike } from "./keystroke-watch";
import { pasteText } from "./paste";
import { PrefsStore, SecureTokenStore } from "./store";
import { hotkeyLabel, initialPtt, pttKeyDown, pttKeyUp, type Correction, type PttState } from "../shared";

// The native hook is loaded lazily so a missing/blocked addon degrades to click-to-dictate.
type Hook = HookLike & {
  on(ev: "keyup", fn: (e: KeyEventLike) => void): unknown;
  start(): void;
  stop(): void;
  keyTap(key: number, modifiers?: number[]): void;
};
let hook: Hook | null = null;

const BUBBLE_W = 380;
const BUBBLE_H = 230;
const ASSETS = path.join(__dirname, "..", "assets");

let prefs: PrefsStore;
let tokens: SecureTokenStore;
let client: KritviaClient | null = null;
let me: { email: string; full_name: string } | null = null;
let ventures: Venture[] = [];
let voice: VoiceSettings | null = null;
let tray: Tray | null = null;
let bubble: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let lastText = "";
let learnOffer: Correction | null = null;
let stopWatch: (() => void) | null = null;
let quitting = false;

type Phase = "idle" | "recording" | "transcribing" | "done" | "error";
let phase: Phase = "idle";
let message: string | null = null;
let session_ = 0;
let ptt: PttState = initialPtt;
let phaseTimer: NodeJS.Timeout | null = null;

// ------------------------------------------------------------------- helpers --
const hotkey = () => (voice?.hotkey && isSupportedHotkey(voice.hotkey) ? voice.hotkey : DEFAULT_HOTKEY);
const venture = () => ventures.find((v) => v.venture_id === prefs.data.ventureId) ?? ventures[0] ?? null;

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

function pushState() {
  const v = venture();
  bubble?.webContents.send("bubble:state", {
    phase,
    message,
    mode: prefs.data.mode,
    hotkey: hotkeyLabel(hotkey()),
    learn: learnOffer,
    canShare: v?.access === "write",
    signedIn: Boolean(client?.signedIn && me),
    venture: v?.venture_name ?? null,
  });
  refreshTray();
}

function settle(p: Phase, msg: string | null, ms: number) {
  phase = p;
  message = msg;
  pushState();
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = setTimeout(() => {
    phase = "idle";
    message = null;
    pushState();
  }, ms);
}

// ------------------------------------------------------------------ windows --
function secure(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
}

function defaultBubblePos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - BUBBLE_W - 8, y: wa.y + wa.height - BUBBLE_H - 8 };
}

function onSomeDisplay(p: { x: number; y: number }) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return p.x + BUBBLE_W / 2 >= a.x && p.x + BUBBLE_W / 2 <= a.x + a.width && p.y + BUBBLE_H / 2 >= a.y && p.y + BUBBLE_H / 2 <= a.y + a.height;
  });
}

function createBubble() {
  const pos = prefs.data.bubble && onSomeDisplay(prefs.data.bubble) ? prefs.data.bubble : defaultBubblePos();
  bubble = new BrowserWindow({
    ...pos,
    width: BUBBLE_W,
    height: BUBBLE_H,
    frame: false,
    transparent: true,
    resizable: false,
    focusable: false, // never steal focus from the app you are dictating into
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  secure(bubble);
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.setIgnoreMouseEvents(true, { forward: true }); // transparent parts click through
  void bubble.loadFile(path.join(__dirname, "renderer", "bubble.html"));
  bubble.webContents.on("did-finish-load", () => {
    pushState();
    updateBubbleVisibility();
  });
}

function updateBubbleVisibility() {
  if (!bubble) return;
  const show = prefs.data.showBubble && Boolean(me) && (voice?.widget_enabled ?? true);
  if (show && !bubble.isVisible()) bubble.showInactive();
  if (!show && bubble.isVisible()) bubble.hide();
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 480,
    height: 680,
    resizable: false,
    title: "Kritvia Voice",
    icon: path.join(ASSETS, "icon.png"),
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  secure(settingsWin);
  void settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWin.once("ready-to-show", () => settingsWin?.show());
}

// --------------------------------------------------------------------- tray --
function refreshTray() {
  if (!tray) return;
  const v = venture();
  const recording = phase === "recording";
  const items: MenuItemConstructorOptions[] = [
    { label: me ? `Signed in as ${me.full_name || me.email}` : "Not signed in", enabled: false },
    ...(ventures.length
      ? [{
          label: `Venture: ${v?.venture_name ?? "—"}`,
          submenu: ventures.map((x) => ({
            label: `${x.venture_name}${ventures.some((y) => y.org_name !== x.org_name) ? ` (${x.org_name})` : ""}`,
            type: "radio" as const,
            checked: x.venture_id === v?.venture_id,
            click: () => {
              prefs.update({ ventureId: x.venture_id });
              pushState();
            },
          })),
        }]
      : []),
    {
      label: "Mode",
      submenu: [
        { label: "Type where my cursor is", type: "radio", checked: prefs.data.mode === "type", click: () => setMode("type") },
        { label: "Save as a note in Kritvia", type: "radio", checked: prefs.data.mode === "note", click: () => setMode("note") },
      ],
    },
    { type: "separator" },
    { label: recording ? "Stop and transcribe" : `Dictate (or hold ${hotkeyLabel(hotkey())})`, enabled: Boolean(me), click: () => toggle() },
    { label: "Copy last transcription", enabled: Boolean(lastText), click: () => void clipboard.writeText(lastText) },
    {
      label: "Show floating widget",
      type: "checkbox",
      checked: prefs.data.showBubble,
      click: (i) => {
        prefs.update({ showBubble: i.checked });
        updateBubbleVisibility();
      },
    },
    { type: "separator" },
    { label: "Open Kritvia", enabled: Boolean(prefs.data.webUrl), click: () => void openWeb() },
    { label: "Settings…", click: openSettings },
    { type: "separator" },
    { label: "Quit Kritvia Voice", click: () => { quitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(recording ? "Kritvia Voice — listening…" : "Kritvia Voice");
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  if (process.platform === "darwin") img.setTemplateImage(true);
  tray = new Tray(img);
  tray.on("click", () => tray?.popUpContextMenu());
  refreshTray();
}

async function openWeb() {
  const url = prefs.data.webUrl;
  if (url && /^https?:\/\//.test(url)) await shell.openExternal(url);
}

function setMode(m: "type" | "note") {
  prefs.update({ mode: m });
  pushState();
}

// ----------------------------------------------------------------- dictation --
const pending = new Map<number, (r: { audio: Uint8Array | null; mime: string; durationMs: number; error?: string }) => void>();

function start() {
  if (!client || !me) {
    openSettings();
    return;
  }
  if (!venture()) return settle("error", "No venture to dictate into", 4000);
  if (phase === "recording") return;
  stopWatch?.();
  learnOffer = null;
  session_ += 1;
  if (phaseTimer) clearTimeout(phaseTimer);
  phase = "recording";
  message = null;
  pushState();
  bubble?.webContents.send("rec:start", { id: session_ });
}

function cancel() {
  if (phase !== "recording") return;
  bubble?.webContents.send("rec:cancel", { id: session_ });
  session_ += 1;
  phase = "idle";
  pushState();
}

async function stop() {
  if (phase !== "recording" || !bubble) return;
  const id = session_;
  const result = await new Promise<{ audio: Uint8Array | null; mime: string; durationMs: number; error?: string }>((resolve) => {
    pending.set(id, resolve);
    bubble!.webContents.send("rec:stop", { id });
    setTimeout(() => {
      if (pending.delete(id)) resolve({ audio: null, mime: "", durationMs: 0, error: "The microphone did not answer" });
    }, 5000);
  });
  if (id !== session_) return; // superseded
  if (result.error) return settle("error", result.error, 5000);
  if (!result.audio || result.audio.byteLength === 0) {
    phase = "idle";
    return pushState();
  }
  phase = "transcribing";
  pushState();
  const v = venture()!;
  const mode = prefs.data.mode;
  let out: Dictation;
  try {
    out = await client!.dictate(v.venture_id, result.audio, result.mime, result.durationMs, mode);
  } catch (e) {
    if (id !== session_) return;
    if (e instanceof ApiError && e.status === 401) {
      me = null;
      updateBubbleVisibility();
      openSettings();
    }
    return settle("error", e instanceof Error ? e.message : "Transcription failed", 5000);
  }
  if (id !== session_) return; // Scribe's stale-session guard: never paste into a newer recording
  if (out.status === "too_short") return settle("error", "Too short — hold the key while you speak", 2500);
  if (out.status === "no_speech") return settle("error", "No speech detected — try a little louder", 3000);
  lastText = out.text;
  if (out.fallback) notify("Kritvia Voice", `Your speech engine was unavailable — used ${out.engine} instead.`);
  if (mode === "note") {
    notify("Saved to Kritvia", out.text.length > 120 ? out.text.slice(0, 117) + "…" : out.text);
    return settle("done", "Saved as a voice note", 3000);
  }
  try {
    await pasteText(out.text, {
      saveClipboard,
      writeText: (t) => clipboard.writeText(t),
      readText: () => clipboard.readText(),
      sendPasteShortcut: () => hook?.keyTap(UK.V, [process.platform === "darwin" ? UK.Meta : UK.Ctrl]),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } catch (e) {
    console.error("paste failed", e);
    void clipboard.writeText(out.text);
    return settle("error", "Couldn't type it here — the text is on your clipboard", 4000);
  }
  settle("done", out.text, 2500);
  if (hook && (voice?.auto_learn ?? true) && prefs.data.autoLearn) {
    const pasted = out.text;
    setTimeout(() => {
      if (id !== session_ || !hook) return;
      stopWatch = watchForCorrection(hook, pasted, (c) => {
        learnOffer = c;
        pushState();
        setTimeout(() => {
          if (learnOffer === c) {
            learnOffer = null;
            pushState();
          }
        }, 15_000);
      }).stop;
    }, 120); // after our own synthetic Ctrl+V has passed through the hook
  }
}

/** Snapshot every clipboard format now (items from read() are live views, so copy the payloads). */
async function saveClipboard(): Promise<() => Promise<void>> {
  const copies: ClipboardItem[] = [];
  for (const item of await clipboard.read()) {
    const data: Record<string, Blob> = {};
    for (const type of item.types) {
      try {
        const v = await item.getType(type);
        if (v instanceof Blob) data[type] = v;
      } catch {
        /* format not readable: skip it */
      }
    }
    if (Object.keys(data).length) copies.push(new ClipboardItem(data));
  }
  return async () => {
    if (copies.length) await clipboard.write(copies);
    else clipboard.clear();
  };
}

/** stop() must never leave the widget stuck in "transcribing". */
function finishRecording() {
  stop().catch((e) => {
    console.error("dictation failed", e);
    settle("error", "Something went wrong — please try again", 4000);
  });
}

function toggle() {
  if (phase === "recording") finishRecording();
  else start();
}

// --------------------------------------------------------------- global hook --
function startHook() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("uiohook-napi") as { uIOhook: Hook };
    hook = mod.uIOhook;
  } catch (e) {
    console.error("global keyboard hook unavailable", e);
    notify("Kritvia Voice", "The global hotkey is unavailable on this system — use the widget or tray to dictate.");
    return;
  }
  const asLike = (e: KeyEventLike) => ({
    code: keycodeToCode(e.keycode),
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
  });
  hook.on("keydown", (e) => {
    const [next, ev] = pttKeyDown(ptt, asLike(e), hotkey());
    ptt = next;
    if (ev === "start") start();
    else if (ev === "cancel") cancel();
    if (e.keycode === UK.Escape && phase === "recording") cancel();
  });
  hook.on("keyup", (e) => {
    const [next, ev] = pttKeyUp(ptt, asLike(e), hotkey());
    ptt = next;
    if (ev === "stop") finishRecording();
  });
  hook.start();
}

// ---------------------------------------------------------------- session --
async function loadAccount() {
  if (!client) return;
  try {
    const [m, vs, s] = await Promise.all([client.me(), client.ventures(), client.voiceSettings()]);
    me = m;
    ventures = vs;
    voice = s;
    if (!venture()) prefs.update({ ventureId: vs[0]?.venture_id ?? null });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      me = null;
    } else {
      console.error("could not load account", e);
    }
  }
  updateBubbleVisibility();
  pushState();
  settingsWin?.webContents.send("settings:changed");
}

function makeClient(server: string) {
  client = new KritviaClient(server, tokens, fetch, `KritviaVoice/${app.getVersion()} (${process.platform})`);
}

function snapshot() {
  return {
    prefs: prefs.data,
    signedIn: Boolean(me),
    me,
    ventures,
    voice,
    hotkey: hotkeyLabel(hotkey()),
    hookAvailable: Boolean(hook),
    platform: process.platform,
    accessibility: process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    secureStorage: safeStorage.isEncryptionAvailable(),
    version: app.getVersion(),
  };
}

function registerIpc() {
  ipcMain.handle("settings:get", () => snapshot());
  ipcMain.handle("settings:refresh", async () => {
    await loadAccount();
    return snapshot();
  });
  ipcMain.handle("settings:login", async (_e, p: { server: string; webUrl?: string; email: string; password: string }) => {
    const server = normaliseServer(String(p.server ?? ""));
    const webUrl = p.webUrl ? normaliseServer(String(p.webUrl)) : "";
    if (client) await client.logout().catch(() => undefined);
    prefs.update({ server, webUrl });
    makeClient(server);
    await client!.login(String(p.email ?? "").trim(), String(p.password ?? ""));
    await loadAccount();
    return snapshot();
  });
  ipcMain.handle("settings:logout", async () => {
    await client?.logout();
    me = null;
    ventures = [];
    voice = null;
    updateBubbleVisibility();
    pushState();
    return snapshot();
  });
  ipcMain.handle("settings:update", (_e, patch: Partial<typeof prefs.data>) => {
    const allowed: Partial<typeof prefs.data> = {};
    if (typeof patch.ventureId === "string" && ventures.some((v) => v.venture_id === patch.ventureId)) allowed.ventureId = patch.ventureId;
    if (patch.mode === "type" || patch.mode === "note") allowed.mode = patch.mode;
    if (typeof patch.showBubble === "boolean") allowed.showBubble = patch.showBubble;
    if (typeof patch.autoLearn === "boolean") allowed.autoLearn = patch.autoLearn;
    if (typeof patch.launchAtLogin === "boolean") {
      allowed.launchAtLogin = patch.launchAtLogin;
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    }
    prefs.update(allowed);
    updateBubbleVisibility();
    pushState();
    return snapshot();
  });
  ipcMain.handle("settings:open-web", () => openWeb());

  // bubble
  ipcMain.on("bubble:interactive", (_e, on: boolean) => bubble?.setIgnoreMouseEvents(!on, { forward: true }));
  let dragFrom: { x: number; y: number } | null = null;
  ipcMain.on("bubble:drag-start", () => {
    if (!bubble) return;
    const [x, y] = bubble.getPosition();
    dragFrom = { x: x!, y: y! };
  });
  ipcMain.on("bubble:drag", (_e, d: { dx: number; dy: number }) => {
    if (bubble && dragFrom && Number.isFinite(d?.dx) && Number.isFinite(d?.dy)) {
      bubble.setPosition(Math.round(dragFrom.x + d.dx), Math.round(dragFrom.y + d.dy));
    }
  });
  ipcMain.on("bubble:drag-end", () => {
    if (!bubble) return;
    const [x, y] = bubble.getPosition();
    prefs.update({ bubble: { x: x!, y: y! } });
    dragFrom = null;
  });
  ipcMain.on("bubble:click", () => toggle());
  ipcMain.on("bubble:mode", (_e, m: string) => (m === "type" || m === "note") && setMode(m));
  ipcMain.on("bubble:hide", () => {
    prefs.update({ showBubble: false });
    updateBubbleVisibility();
    refreshTray();
    notify("Kritvia Voice", `Widget hidden. Hold ${hotkeyLabel(hotkey())} to dictate, or show it again from the tray.`);
  });
  ipcMain.on("learn:dismiss", () => {
    learnOffer = null;
    pushState();
  });
  ipcMain.on("learn:save", async (_e, scope: string) => {
    const c = learnOffer;
    const v = venture();
    learnOffer = null;
    pushState();
    if (!c || !v || !client) return;
    try {
      const r = await client.learn(v.venture_id, c.heard, c.correct, scope === "shared" ? "shared" : "personal");
      if (r.learned) settle("done", `Learned: ${c.heard} → ${c.correct}`, 2500);
    } catch (e) {
      settle("error", e instanceof Error ? e.message : "Could not save", 4000);
    }
  });
  ipcMain.on("rec:result", (e, r: { id: number; audio: ArrayBuffer | null; mime: string; durationMs: number; error?: string }) => {
    if (!bubble || e.sender !== bubble.webContents) return;
    const resolve = pending.get(r?.id);
    if (!resolve) return;
    pending.delete(r.id);
    resolve({
      audio: r.audio ? new Uint8Array(r.audio) : null,
      mime: typeof r.mime === "string" ? r.mime : "audio/webm",
      durationMs: Number(r.durationMs) || 0,
      error: r.error,
    });
  });
}

// --------------------------------------------------------------------- boot --
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSettings());
  app.setAppUserModelId("com.sitelytc.kritvia.voice");

  app.whenReady().then(async () => {
    if (process.platform === "darwin") app.dock?.hide();
    const dir = app.getPath("userData");
    prefs = new PrefsStore(dir);
    tokens = new SecureTokenStore(dir, safeStorage);

    // Microphone only for our own bubble page; nothing else may ask for anything.
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
      cb(permission === "media" && Boolean(bubble) && wc === bubble!.webContents));
    session.defaultSession.setPermissionCheckHandler((wc, permission) =>
      permission === "media" && Boolean(bubble) && wc === bubble!.webContents);

    if (process.platform === "darwin") {
      await systemPreferences.askForMediaAccess("microphone").catch(() => false);
      // Listening for the hotkey and pasting both need Accessibility permission; this prompts once.
      systemPreferences.isTrustedAccessibilityClient(true);
    }

    registerIpc();
    createTray();
    createBubble();
    startHook();
    if (prefs.data.server) {
      makeClient(prefs.data.server);
      if (client!.signedIn) await loadAccount();
    }
    if (!me) openSettings();
    // pick up hotkey / engine changes made in the web app
    setInterval(() => void (me && loadAccount()), 10 * 60_000);
  });

  app.on("window-all-closed", () => {
    /* tray app: keep running */
  });
  app.on("before-quit", () => {
    quitting = true;
    try {
      hook?.stop();
    } catch {
      /* already stopped */
    }
  });
  void quitting;
}
