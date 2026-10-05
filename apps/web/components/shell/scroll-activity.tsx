"use client";

import { useEffect } from "react";

const IDLE_MS = 800;

/**
 * Marks whatever is scrolling with data-scrolling for a moment, so its scrollbar thumb can
 * glow (see .kv-scroll in globals.css): the page itself on <html>, and any .kv-scroll box.
 * Also renders the top reading-progress hairline.
 */
export function ScrollActivity() {
  useEffect(() => {
    const timers = new Map<Element, number>();
    const mark = (el: Element) => {
      el.setAttribute("data-scrolling", "");
      window.clearTimeout(timers.get(el));
      timers.set(
        el,
        window.setTimeout(() => {
          el.removeAttribute("data-scrolling");
          timers.delete(el);
        }, IDLE_MS),
      );
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || t === document.documentElement || t === document.body) mark(document.documentElement);
      else if (t instanceof Element && t.classList.contains("kv-scroll")) mark(t);
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      for (const [el, id] of timers) {
        window.clearTimeout(id);
        el.removeAttribute("data-scrolling");
      }
    };
  }, []);
  return <div className="kv-progress" aria-hidden />;
}
