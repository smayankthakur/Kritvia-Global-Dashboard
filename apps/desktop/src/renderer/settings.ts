// Settings / sign-in window (sandboxed renderer).
interface Snapshot {
  prefs: { server: string; webUrl: string; ventureId: string | null; mode: "type" | "note"; showBubble: boolean; autoLearn: boolean; launchAtLogin: boolean };
  signedIn: boolean;
  me: { email: string; full_name: string } | null;
  ventures: { venture_id: string; venture_name: string; org_name: string }[];
  voice: { engine: string; language: string } | null;
  hotkey: string;
  hookAvailable: boolean;
  platform: string;
  accessibility: boolean;
  secureStorage: boolean;
  version: string;
}
const k = window.kritvia;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function render(s: Snapshot) {
  $("login").hidden = s.signedIn;
  $("account").hidden = !s.signedIn;
  $<HTMLInputElement>("server").value ||= s.prefs.server;
  $<HTMLInputElement>("web").value ||= s.prefs.webUrl;
  $("version").textContent = `Version ${s.version}`;
  if (!s.signedIn) return;
  $("who").textContent = s.me ? `${s.me.full_name || s.me.email}` : "";
  $("server-label").textContent = `${s.me?.email ?? ""} · ${s.prefs.server}`;
  const sel = $<HTMLSelectElement>("venture");
  const multiOrg = new Set(s.ventures.map((v) => v.org_name)).size > 1;
  sel.replaceChildren(
    ...s.ventures.map((v) => {
      const o = document.createElement("option");
      o.value = v.venture_id;
      o.textContent = multiOrg ? `${v.venture_name} — ${v.org_name}` : v.venture_name;
      o.selected = v.venture_id === s.prefs.ventureId;
      return o;
    }),
  );
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) r.checked = r.value === s.prefs.mode;
  $("hotkey").textContent = s.hotkey;
  $("engine").textContent = s.voice ? `Engine: ${s.voice.engine} · Language: ${s.voice.language}` : "";
  $<HTMLInputElement>("show-bubble").checked = s.prefs.showBubble;
  $<HTMLInputElement>("auto-learn").checked = s.prefs.autoLearn;
  $<HTMLInputElement>("login-item").checked = s.prefs.launchAtLogin;
  $("open-web").hidden = !s.prefs.webUrl;
  const warnings: string[] = [];
  if (!s.hookAvailable) warnings.push("The global hotkey is unavailable on this system (on Linux it needs an X11 session). Click the widget to dictate.");
  if (s.platform === "darwin" && !s.accessibility)
    warnings.push("Allow Kritvia Voice in System Settings → Privacy & Security → Accessibility (for the hotkey and pasting), then restart it.");
  if (!s.secureStorage) warnings.push("Your system has no secure storage, so you will need to sign in again after restarting.");
  $("warn").hidden = !warnings.length;
  $("warn").textContent = warnings.join(" ");
}

async function load() {
  render(await k.invoke<Snapshot>("settings:get"));
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("login-btn");
  const err = $("login-error");
  btn.disabled = true;
  err.hidden = true;
  try {
    const s = await k.invoke<Snapshot>("settings:login", {
      server: $<HTMLInputElement>("server").value,
      webUrl: $<HTMLInputElement>("web").value,
      email: $<HTMLInputElement>("email").value,
      password: $<HTMLInputElement>("password").value,
    });
    $<HTMLInputElement>("password").value = "";
    render(s);
  } catch (ex) {
    err.textContent = errorText(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});
$("logout").addEventListener("click", async () => render(await k.invoke<Snapshot>("settings:logout")));
$("open-web").addEventListener("click", () => void k.invoke("settings:open-web"));
$("venture").addEventListener("change", async (e) =>
  render(await k.invoke<Snapshot>("settings:update", { ventureId: (e.target as HTMLSelectElement).value })));
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
  r.addEventListener("change", async () => render(await k.invoke<Snapshot>("settings:update", { mode: r.value })));
}
const toggles: [string, string][] = [["show-bubble", "showBubble"], ["auto-learn", "autoLearn"], ["login-item", "launchAtLogin"]];
for (const [id, key] of toggles) {
  $<HTMLInputElement>(id).addEventListener("change", async (e) =>
    render(await k.invoke<Snapshot>("settings:update", { [key]: (e.target as HTMLInputElement).checked })));
}
k.on("settings:changed", () => void load());
window.addEventListener("focus", () => void k.invoke<Snapshot>("settings:refresh").then(render).catch(() => undefined));
void load();
export {};
