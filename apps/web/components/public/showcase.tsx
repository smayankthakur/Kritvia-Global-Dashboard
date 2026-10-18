"use client";

import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export type ShowcaseItem = {
  key: string;
  icon: LucideIcon;
  /** Small caps line above the title ("Layer 1 · Capture", "Software studios"). */
  tag: string;
  title: string;
  /** The same story the scene tells, in words: read by screen readers and shown under the title. */
  text: string;
  /** Title in the example window's bar. */
  window: string;
  scene: (reduce: boolean) => ReactNode;
};

/**
 * Tabs on one side, a small animated example window on the other showing the picked item at work.
 * Advances by itself while on screen (pauses on hover or keyboard focus); a click or the arrow keys
 * pick an item. With reduced motion nothing advances or moves and each scene shows its finished state.
 * Scenes are illustrations with example data, hidden from screen readers; the panel has the text.
 *
 * detail="inline": the picked tab opens to show its text (wide screens), as in a feature list.
 * detail="below": the text sits under the window, for tabs whose title already tells the story.
 * reverse: the window goes on the left on wide screens, so neighbouring sections alternate.
 */
export function Showcase({
  items,
  label,
  stepMs = 7000,
  detail = "below",
  reverse = false,
  height = "h-[22rem] sm:h-[24rem]",
}: {
  items: ShowcaseItem[];
  label: string;
  stepMs?: number;
  detail?: "inline" | "below";
  reverse?: boolean;
  height?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { margin: "-20% 0px -20% 0px" });
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [round, setRound] = useState(0);
  const uid = useId().replace(/:/g, "");
  const running = inView && !paused && !reduce;

  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => setI((x) => (x + 1) % items.length), stepMs);
    return () => clearTimeout(t);
  }, [running, i, round, stepMs, items.length]);

  // Pause while the pointer or keyboard focus is inside.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => setPaused(true);
    const off = (e: Event) => {
      if (e.type === "focusout" && el.contains((e as FocusEvent).relatedTarget as Node)) return;
      setPaused(false);
    };
    el.addEventListener("pointerenter", on);
    el.addEventListener("pointerleave", off);
    el.addEventListener("focusin", on);
    el.addEventListener("focusout", off);
    return () => {
      el.removeEventListener("pointerenter", on);
      el.removeEventListener("pointerleave", off);
      el.removeEventListener("focusin", on);
      el.removeEventListener("focusout", off);
    };
  }, []);

  // A soft light that follows the pointer across the window (fine pointers, motion allowed).
  const win = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = win.current;
    if (!el || reduce || !window.matchMedia?.("(pointer: fine)").matches) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    el.addEventListener("pointermove", move);
    return () => el.removeEventListener("pointermove", move);
  }, [reduce]);

  // On phones the tabs are a sideways strip: keep the current one in view (the page doesn't move).
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    const tab = document.getElementById(`${uid}-tab-${i}`);
    if (el && tab && el.scrollWidth > el.clientWidth)
      el.scrollTo?.({
        left: el.scrollLeft + tab.getBoundingClientRect().left - el.getBoundingClientRect().left - 16,
        behavior: reduce ? "auto" : "smooth",
      });
  }, [i, uid, reduce]);

  const pick = (n: number) => {
    setI(n);
    setRound((r) => r + 1);
  };
  const L = items[i]!;

  const text = (cls: string) => (
    <AnimatePresence mode="wait" initial={false}>
      <motion.p
        key={L.key}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.25 }}
        className={cn("mt-4 text-[15px] leading-relaxed text-muted", cls)}
        aria-hidden
      >
        {L.text}
      </motion.p>
    </AnimatePresence>
  );

  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      className={cn(
        "grid gap-5",
        reverse ? "lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.85fr)]" : "lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.35fr)]",
      )}
    >
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        aria-orientation="vertical"
        className={cn(
          "-mx-4 flex snap-x scroll-px-4 items-start gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:items-stretch lg:justify-center lg:overflow-visible lg:px-0",
          reverse && "lg:order-2",
        )}
      >
        {items.map((l, n) => {
          const on = n === i;
          return (
            <button
              key={l.key}
              id={`${uid}-tab-${n}`}
              role="tab"
              type="button"
              aria-selected={on}
              aria-controls={`${uid}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => pick(n)}
              onKeyDown={(e) => {
                const d =
                  e.key === "ArrowDown" || e.key === "ArrowRight"
                    ? 1
                    : e.key === "ArrowUp" || e.key === "ArrowLeft"
                      ? -1
                      : 0;
                const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : d ? (n + d + items.length) % items.length : -1;
                if (to >= 0) {
                  e.preventDefault();
                  pick(to);
                  document.getElementById(`${uid}-tab-${to}`)?.focus();
                }
              }}
              className={cn(
                "group relative w-[17rem] shrink-0 snap-start rounded-2xl border p-4 text-left transition-[border-color,transform] duration-300 lg:w-auto",
                on ? "border-transparent" : "glass border-border hover:-translate-y-0.5 hover:border-border-strong motion-reduce:hover:translate-y-0",
              )}
            >
              {on ? (
                // One highlight that glides from tab to tab.
                <motion.span
                  layoutId={`${uid}-hl`}
                  aria-hidden
                  className="glass-strong absolute inset-0 overflow-hidden rounded-2xl border border-accent/40 shadow-card"
                  transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 34 }}
                >
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent/15">
                    <motion.span
                      key={`${i}-${round}-${running}`}
                      className="block h-full origin-left bg-accent"
                      initial={{ scaleX: running ? 0 : 1 }}
                      animate={{ scaleX: 1 }}
                      transition={{ duration: running ? stepMs / 1000 : 0, ease: "linear" }}
                    />
                  </span>
                </motion.span>
              ) : null}
              <span className="relative flex items-start gap-3">
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-[background-color,color,transform] duration-300",
                    on ? "scale-105 bg-accent text-accent-fg shadow-card" : "bg-accent-soft text-accent group-hover:scale-105",
                  )}
                >
                  <l.icon className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold tracking-wider text-subtle uppercase">{l.tag}</span>
                  <span className={cn("mt-0.5 block text-[15px] leading-snug font-semibold transition-colors", on ? "text-fg" : "text-muted")}>
                    {l.title}
                  </span>
                  {detail === "inline" ? (
                    <span
                      aria-hidden
                      className={cn(
                        "hidden transition-[grid-template-rows,opacity] duration-300 ease-out lg:grid",
                        on ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                      )}
                    >
                      <span className="overflow-hidden">
                        <span className="block pt-1.5 text-sm leading-relaxed text-muted">{l.text}</span>
                      </span>
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${i}`} className={cn("min-w-0", reverse && "lg:order-1")}>
        <p className="sr-only">{L.text}</p>
        <div
          ref={win}
          aria-hidden
          className="group/win glass-strong relative overflow-hidden rounded-2xl border shadow-[var(--shadow-pop)]"
        >
          {!reduce ? (
            <span className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-500 group-hover/win:opacity-100 [background:radial-gradient(18rem_circle_at_var(--mx,50%)_var(--my,0%),var(--accent-soft),transparent_70%)]" />
          ) : null}
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={L.window}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="ml-2 truncate text-xs font-medium text-subtle"
              >
                {L.window}
              </motion.span>
            </AnimatePresence>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success-fg">
              <span className="relative flex h-1.5 w-1.5">
                {!reduce ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" /> : null}
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              Example
            </span>
          </div>
          <div className={cn("relative", height)}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${L.key}-${round}`}
                className="absolute inset-0 p-4 sm:p-5"
                initial={{ opacity: 0, x: reverse ? -18 : 18, filter: "blur(6px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: reverse ? 18 : -18, filter: "blur(6px)" }}
                transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
              >
                {L.scene(reduce)}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        {text(detail === "inline" ? "lg:hidden" : "")}
      </div>
    </div>
  );
}
