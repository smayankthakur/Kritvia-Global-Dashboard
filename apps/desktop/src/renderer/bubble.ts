// Floating widget (sandboxed renderer). Records audio when the main process says so and shows
// state; everything else (auth, API, paste) happens in the main process.

interface State {
  phase: "idle" | "recording" | "transcribing" | "done" | "error";
  message: string | null;
  mode: "type" | "note";
  hotkey: string;
  learn: { heard: string; correct: string } | null;
  canShare: boolean;
  signedIn: boolean;
  venture: string | null;
}

const k = window.kritvia;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const orb = $<HTMLButtonElement>("orb");
const label = $("label");
const toolbar = $("toolbar");
const wave = $("wave");
const pulse = $("pulse");
let state: State | null = null;
let hovering = false;

// ---------------------------------------------------------------- display --
export function tail(text: string, max = 70): string {
  const t = text.trim();
  return t.length <= max ? t : "…" + t.slice(t.length - max + 1).replace(/^\S*\s/, "");
}

let elapsed = 0;
let elapsedTimer: number | null = null;

function render() {
  const s = state;
  if (!s) return;
  orb.className = s.phase === "idle" ? "" : s.phase;
  orb.setAttribute("aria-pressed", String(s.phase === "recording"));
  orb.setAttribute(
    "aria-label",
    s.phase === "recording" ? "Stop and transcribe" : `Dictate (${s.mode === "note" ? "note" : "type"} mode). Hold ${s.hotkey} or click. Drag to move.`,
  );
  orb.title = s.signedIn ? `Hold ${s.hotkey} in any app, or click${s.venture ? ` — ${s.venture}` : ""}` : "Sign in to Kritvia";
  $("mic").toggleAttribute("hidden", s.phase === "transcribing");
  $("spin").toggleAttribute("hidden", s.phase !== "transcribing");
  $("badge").toggleAttribute("hidden", s.mode !== "note" || s.phase === "recording");
  wave.hidden = s.phase !== "recording";

  const text =
    s.phase === "recording" ? `Listening… release ${s.hotkey} to finish (${elapsed}s)` : s.phase === "transcribing" ? "Transcribing…" : s.message ? tail(s.message) : "";
  label.textContent = text;
  label.hidden = !text || Boolean(s.learn);

  const learn = $("learn");
  learn.hidden = !s.learn;
  if (s.learn) {
    $("heard").textContent = s.learn.heard;
    $("correct").textContent = s.learn.correct;
    $("learn-team").hidden = !s.canShare;
  }
  toolbar.hidden = !(hovering && s.phase === "idle" && !s.learn && s.signedIn);
  for (const b of toolbar.querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === s.mode));
  }
}

k.on("bubble:state", (p) => {
  const prev = state?.phase;
  state = p as State;
  if (state.phase === "recording" && prev !== "recording") {
    elapsed = 0;
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = window.setInterval(() => {
      elapsed++;
      render();
    }, 1000);
  } else if (state.phase !== "recording" && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  render();
});

// ------------------------------------------------- click-through & hovering --
const stack = $("stack");
stack.addEventListener("mouseenter", () => {
  hovering = true;
  render();
});
stack.addEventListener("mouseleave", () => {
  hovering = false;
  render();
});
for (const el of document.querySelectorAll<HTMLElement>(".interactive, #toolbar, #learn")) {
  el.addEventListener("mouseenter", () => k.send("bubble:interactive", true));
  el.addEventListener("mouseleave", () => k.send("bubble:interactive", false));
}

// ------------------------------------------------------- drag vs. click --
let drag: { x: number; y: number; moved: boolean } | null = null;
orb.addEventListener("pointerdown", (e) => {
  orb.setPointerCapture(e.pointerId);
  drag = { x: e.screenX, y: e.screenY, moved: false };
  k.send("bubble:drag-start");
});
orb.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  drag.moved = true;
  k.send("bubble:drag", { dx, dy });
});
orb.addEventListener("pointerup", () => {
  if (!drag) return;
  if (drag.moved) k.send("bubble:drag-end");
  else k.send("bubble:click");
  drag = null;
});
orb.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    k.send("bubble:click");
  }
});
for (const b of toolbar.querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
  b.addEventListener("click", () => k.send("bubble:mode", b.dataset.mode));
}
$("hide").addEventListener("click", () => k.send("bubble:hide"));
$("learn-me").addEventListener("click", () => k.send("learn:save", "personal"));
$("learn-team").addEventListener("click", () => k.send("learn:save", "shared"));
$("learn-x").addEventListener("click", () => k.send("learn:dismiss"));

// --------------------------------------------------------------- recording --
const TAIL_GRACE_MS = 200; // people release the key a moment after the last syllable
const bars = Array.from({ length: 7 }, () => {
  const i = document.createElement("i");
  wave.appendChild(i);
  return i;
});
const levels = bars.map(() => 0);

interface Rec {
  id: number;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  ctx: AudioContext | null;
  chunks: Blob[];
  startedAt: number;
  error: string | null;
  raf: number | null;
  ready: Promise<void>;
}
let rec: Rec | null = null;

function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function release(r: Rec) {
  if (r.raf) cancelAnimationFrame(r.raf);
  r.stream?.getTracks().forEach((t) => t.stop());
  void r.ctx?.close().catch(() => undefined);
  pulse.style.transform = "scale(1)";
  bars.forEach((b) => (b.style.height = "4px"));
}

k.on("rec:start", (p) => {
  const id = (p as { id: number }).id;
  if (rec) release(rec);
  const r: Rec = { id, recorder: null, stream: null, ctx: null, chunks: [], startedAt: Date.now(), error: null, raf: null, ready: Promise.resolve() };
  rec = r;
  r.ready = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (rec !== r) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      r.stream = stream;
      const mime = pickMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
      mr.start(250);
      r.recorder = mr;
      r.startedAt = Date.now();
      const ctx = new AudioContext();
      r.ctx = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let last = 0;
      const tick = (t: number) => {
        if (t - last > 80) {
          last = t;
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += ((v - 128) / 128) ** 2;
          const lvl = Math.min(1, Math.sqrt(sum / buf.length) * 3);
          levels.shift();
          levels.push(lvl);
          bars.forEach((b, i) => (b.style.height = `${Math.max(4, Math.round(levels[i]! * 30))}px`));
          pulse.style.transform = `scale(${1 + lvl * 0.35})`;
        }
        r.raf = requestAnimationFrame(tick);
      };
      r.raf = requestAnimationFrame(tick);
    } catch (e) {
      r.error =
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone access is blocked — allow Kritvia Voice in your system's privacy settings"
          : "Could not start the microphone";
    }
  })();
});

k.on("rec:cancel", () => {
  if (!rec) return;
  const r = rec;
  rec = null;
  void r.ready.then(() => {
    if (r.recorder && r.recorder.state !== "inactive") r.recorder.stop();
    release(r);
  });
});

k.on("rec:stop", (p) => {
  const id = (p as { id: number }).id;
  const r = rec;
  if (!r || r.id !== id) {
    k.send("rec:result", { id, audio: null, mime: "", durationMs: 0 });
    return;
  }
  void r.ready.then(() =>
    setTimeout(() => {
      rec = null;
      if (r.error || !r.recorder) {
        release(r);
        k.send("rec:result", { id, audio: null, mime: "", durationMs: 0, error: r.error ?? "Could not start the microphone" });
        return;
      }
      const mr = r.recorder;
      mr.onstop = async () => {
        const durationMs = Date.now() - r.startedAt;
        release(r);
        const blob = new Blob(r.chunks, { type: mr.mimeType || "audio/webm" });
        const audio = blob.size ? await blob.arrayBuffer() : null;
        k.send("rec:result", { id, audio, mime: blob.type, durationMs });
      };
      mr.stop();
    }, TAIL_GRACE_MS),
  );
});
