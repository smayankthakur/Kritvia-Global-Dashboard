"use client";

import { useEffect, useRef } from "react";

export const LEAVE_MESSAGE = "You have unsaved changes. Leave without saving them?";

/** A click on a link that would take this tab to another page of the app (not a new tab, a download or a hash). */
export function isInAppNavigation(e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">, a: HTMLAnchorElement, here: string): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (a.target && a.target !== "_self") return false;
  if (a.hasAttribute("download")) return false;
  let url: URL;
  try {
    url = new URL(a.href, here);
  } catch {
    return false;
  }
  const cur = new URL(here);
  if (url.origin !== cur.origin) return false;
  // Same page, only a different #section: nothing is lost.
  return !(url.pathname === cur.pathname && url.search === cur.search);
}

/**
 * Warns before unsaved edits are lost: on closing or reloading the tab (the browser's own prompt) and on a
 * click on any in-app link (round 3, A2). `dirty` false removes both guards.
 */
export function useUnsavedChanges(dirty: boolean, message: string = LEAVE_MESSAGE) {
  const latest = useRef({ dirty, message });
  latest.current = { dirty, message };
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = "";
    };
    // Capture phase on the document runs before Next's <Link> handler, so a "stay" stops the navigation.
    const click = (e: MouseEvent) => {
      if (!latest.current.dirty) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || !isInAppNavigation(e, a, window.location.href)) return;
      if (!window.confirm(latest.current.message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}
