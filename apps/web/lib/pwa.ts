"use client";

/** Registers the service worker once the page is idle; harmless where unsupported. */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") return;
  const go = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  if ("requestIdleCallback" in window) (window as Window & { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(go);
  else setTimeout(go, 1500);
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function b64ToBytes(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Asks for permission and subscribes this browser. Throws with a plain message on refusal. */
export async function subscribeBrowser(publicKey: string): Promise<BrowserSubscription> {
  if (!pushSupported()) throw new Error("This browser cannot show notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed for this site.");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) as BufferSource });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("The browser gave an incomplete subscription.");
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

export async function currentSubscription(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

export async function unsubscribeBrowser(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  await sub.unsubscribe();
  return sub.endpoint;
}
