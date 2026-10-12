/**
 * "Connect WhatsApp" with Meta's Embedded Signup. Runs only on the WhatsApp connect page, whose
 * CSP admits Meta's hosts and whose COOP lets Meta's popup report back (lib/csp.ts, next.config.ts).
 *
 * The owner logs in with Facebook in Meta's window and picks (or adds) their business number there.
 * Meta then gives us two things, in either order: a short-lived code (FB.login's callback) and the
 * chosen WhatsApp account and number (a WA_EMBEDDED_SIGNUP message from the popup). Both go to the
 * API at once, because the code expires after 30 seconds.
 */

export type SignupConfig = { app_id: string; config_id: string; graph_version: string };
export type SignupResult = { code: string; wabaId: string; phoneNumberId: string | null; businessApp: boolean };

type FbLoginResponse = { authResponse?: { code?: string } | null; status?: string };
type FbSdk = {
  init: (o: Record<string, unknown>) => void;
  login: (cb: (r: FbLoginResponse) => void, o: Record<string, unknown>) => void;
};
declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

export type SessionEvent =
  | { kind: "finish"; wabaId: string; phoneNumberId: string | null; businessApp: boolean }
  | { kind: "cancel"; step: string | null; error: string | null };

/** Reads one message from Meta's signup window. Anything else (other origins, other messages) → null. */
export function parseSignupMessage(origin: string, data: unknown): SessionEvent | null {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (!(host === "facebook.com" || host.endsWith(".facebook.com"))) return null;
  let msg: unknown = data;
  if (typeof data === "string") {
    try {
      msg = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { type?: string; event?: string; data?: Record<string, unknown> };
  if (m.type !== "WA_EMBEDDED_SIGNUP") return null;
  const d = m.data ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
  if (m.event === "CANCEL" || m.event === "ERROR")
    return { kind: "cancel", step: str(d.current_step), error: str(d.error_message) };
  if (typeof m.event === "string" && m.event.startsWith("FINISH")) {
    const wabaId = str(d.waba_id) ?? (Array.isArray(d.waba_ids) ? str(d.waba_ids[0]) : null);
    if (!wabaId) return null;
    return { kind: "finish", wabaId, phoneNumberId: str(d.phone_number_id), businessApp: m.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" };
  }
  return null;
}

let sdk: Promise<void> | null = null;

/** Loads Facebook's SDK once. */
export function loadFacebookSdk(cfg: SignupConfig): Promise<void> {
  if (sdk) return sdk;
  sdk = new Promise<void>((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId: cfg.app_id, autoLogAppEvents: true, xfbml: false, version: cfg.graph_version });
      return resolve();
    }
    window.fbAsyncInit = () => {
      window.FB!.init({ appId: cfg.app_id, autoLogAppEvents: true, xfbml: false, version: cfg.graph_version });
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      sdk = null;
      reject(new Error("Couldn't reach Facebook. Check your internet connection and try again."));
    };
    document.body.appendChild(s);
  });
  return sdk;
}

/** Opens Meta's window and resolves when both the code and the chosen number are known. */
export function runSignup(cfg: SignupConfig, waitMs = 15000): Promise<SignupResult> {
  return new Promise<SignupResult>((resolve, reject) => {
    let code: string | null = null;
    let session: Extract<SessionEvent, { kind: "finish" }> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (fn: () => void) => {
      window.removeEventListener("message", onMessage);
      if (timer) clearTimeout(timer);
      fn();
    };
    const settle = () => {
      if (code && session) {
        const s = session;
        done(() => resolve({ code: code!, wabaId: s.wabaId, phoneNumberId: s.phoneNumberId, businessApp: s.businessApp }));
      } else if (code && !timer) {
        timer = setTimeout(
          () => done(() => reject(new Error("Facebook didn't tell us which number you chose. Please try again."))),
          waitMs,
        );
      }
    };
    const onMessage = (e: MessageEvent) => {
      const ev = parseSignupMessage(e.origin, e.data);
      if (!ev) return;
      if (ev.kind === "cancel") {
        done(() => reject(new Error(ev.error ? `Facebook reported a problem: ${ev.error}` : "The WhatsApp window was closed before finishing.")));
        return;
      }
      session = ev;
      settle();
    };
    window.addEventListener("message", onMessage);
    window.FB!.login(
      (r) => {
        if (r.authResponse?.code) {
          code = r.authResponse.code;
          settle();
        } else if (!session) {
          done(() => reject(new Error("The WhatsApp window was closed before finishing.")));
        }
      },
      { config_id: cfg.config_id, response_type: "code", override_default_response_type: true, extras: {} },
    );
  });
}
