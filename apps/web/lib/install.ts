"use client";

/**
 * "Install Kritvia" (add to home screen). Chrome, Edge and Samsung Internet fire
 * `beforeinstallprompt` once, early, so it is caught here as soon as the app loads and kept
 * until a button asks for it. iPhone/iPad Safari has no prompt: people use Share → Add to Home Screen.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function listenForInstall(): void {
  if (typeof window === "undefined" || (window as Window & { __kvInstall?: boolean }).__kvInstall) return;
  (window as Window & { __kvInstall?: boolean }).__kvInstall = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    listeners.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((f) => f());
  });
}

export function onInstallChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function canPromptInstall(): boolean {
  return deferred !== null;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  listeners.forEach((f) => f());
  return choice.outcome === "accepted";
}

export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIos(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document);
}

export function isMobile(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/.test(ua);
}
