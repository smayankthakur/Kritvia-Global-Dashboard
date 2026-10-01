// Kritvia API client for the desktop companion (runs in the main process only — the renderer
// never sees a token). Same auth as the web app: a short-lived access token in memory and a
// rotating refresh token kept encrypted by the OS (Electron safeStorage). Refreshes are
// single-flight, because presenting a used refresh token revokes the whole session.

export interface TokenStore {
  load(): string | null;
  save(refreshToken: string | null): void;
}

export interface Venture {
  venture_id: string;
  venture_name: string;
  org_name: string;
  access: "read" | "write";
  kind: string;
}

export interface VoiceSettings {
  engine: "auto" | "sarvam" | "whisper" | "local";
  language: string;
  remove_fillers: boolean;
  profanity_filter: boolean;
  auto_learn: boolean;
  hotkey: string;
  widget_enabled: boolean;
}

export interface Dictation {
  text: string;
  language: string | null;
  engine: string;
  deployment: string;
  words: number;
  vocabulary_applied: number;
  fallback: boolean;
  status: "ok" | "too_short" | "no_speech";
  note_document_id: string | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Only HTTPS servers, except this machine (development). Credentials never go over plain HTTP. */
export function normaliseServer(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("Use an https:// address for your Kritvia API");
  if (u.username || u.password) throw new Error("The address must not contain credentials");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

async function detail(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { detail?: unknown };
    if (typeof b.detail === "string") return b.detail;
  } catch {
    /* not JSON */
  }
  return res.status === 401 ? "Your session has expired — sign in again" : `Request failed (${res.status})`;
}

export class KritviaClient {
  private access: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(
    public server: string,
    private store: TokenStore,
    private fetcher: FetchLike = fetch,
    private userAgent = "KritviaVoice/1.0",
  ) {}

  get signedIn(): boolean {
    return Boolean(this.access || this.store.load());
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.fetcher(`${this.server}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": this.userAgent },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new ApiError(res.status, res.status === 401 ? "Wrong email or password" : await detail(res));
    const t = (await res.json()) as { access_token: string; refresh_token: string };
    this.access = t.access_token;
    this.store.save(t.refresh_token);
  }

  async logout(): Promise<void> {
    const rt = this.store.load();
    this.access = null;
    this.store.save(null);
    if (rt) {
      await this.fetcher(`${this.server}/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      }).catch(() => undefined);
    }
  }

  private refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const rt = this.store.load();
        if (!rt) return false;
        const res = await this.fetcher(`${this.server}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": this.userAgent },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (res.status === 401) {
          this.store.save(null);
          this.access = null;
          return false;
        }
        if (!res.ok) throw new ApiError(res.status, await detail(res));
        const t = (await res.json()) as { access_token: string; refresh_token: string };
        this.access = t.access_token;
        this.store.save(t.refresh_token);
        return true;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.access && !(await this.refresh())) throw new ApiError(401, "Sign in to Kritvia");
    const send = () =>
      this.fetcher(`${this.server}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.access}`, "user-agent": this.userAgent },
      });
    let res = await send();
    if (res.status === 401 && (await this.refresh())) res = await send();
    if (res.status === 401) throw new ApiError(401, "Sign in to Kritvia");
    if (!res.ok) throw new ApiError(res.status, await detail(res));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  me() {
    return this.request<{ id: string; email: string; full_name: string }>("/auth/me");
  }

  async ventures(): Promise<Venture[]> {
    const a = await this.request<{ ventures: Venture[] }>("/me/access");
    return a.ventures;
  }

  voiceSettings() {
    return this.request<VoiceSettings>("/me/voice-settings");
  }

  dictate(ventureId: string, audio: Uint8Array, mime: string, durationMs: number, mode: "type" | "note") {
    const fd = new FormData();
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
    fd.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), `dictation.${ext}`);
    fd.append("mode", mode);
    fd.append("surface", "desktop");
    fd.append("duration_ms", String(Math.round(durationMs)));
    return this.request<Dictation>(`/ventures/${encodeURIComponent(ventureId)}/voice/dictate`, { method: "POST", body: fd });
  }

  learn(ventureId: string, heard: string, correct: string, scope: "personal" | "shared") {
    return this.request<{ learned: boolean; heard: string | null; correct: string | null }>(
      `/ventures/${encodeURIComponent(ventureId)}/vocabulary/learn`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ heard, correct, scope, save: true }) },
    );
  }
}
