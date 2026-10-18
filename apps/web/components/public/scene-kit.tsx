"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

/** Building blocks for the landing page's animated example windows (layers, agents, platform). */

/** Typewriter: reveals `text` over time once `start` is true. */
export function useTyped(
  text: string,
  { start = true, cps = 38, reduce = false }: { start?: boolean; cps?: number; reduce?: boolean },
) {
  const [n, setN] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (reduce) {
      setN(text.length);
      return;
    }
    if (!start) return;
    setN(0);
    const id = setInterval(() => setN((x) => (x >= text.length ? (clearInterval(id), x) : x + 1)), 1000 / cps);
    return () => clearInterval(id);
  }, [text, start, cps, reduce]);
  return { shown: text.slice(0, n), done: n >= text.length };
}

/** Becomes true `ms` after mount (immediately with reduced motion). */
export function useAfter(ms: number, reduce: boolean) {
  const [on, setOn] = useState(reduce);
  useEffect(() => {
    if (reduce) return;
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [ms, reduce]);
  return on;
}

/** Counts from 0 up to `to` over `ms` once `start` is true (eased; the final value with reduced motion). */
export function useCount(to: number, { start = true, ms = 900, reduce = false }: { start?: boolean; ms?: number; reduce?: boolean }) {
  const [v, setV] = useState(reduce ? to : 0);
  useEffect(() => {
    if (reduce) {
      setV(to);
      return;
    }
    if (!start) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, start, ms, reduce]);
  return v;
}

export const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** Lift-and-fade in, used for most cards in a scene. */
export const pop = {
  initial: { opacity: 0, y: 12, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
};

export const spring = { type: "spring", stiffness: 260, damping: 24 } as const;

/** A tiny spinner with a word ("reading", "checking") that turns into `children` after `delay` seconds. */
export function Resolving({
  delay,
  reduce,
  word = "reading",
  className = "min-w-[5.5rem]",
  children,
}: {
  delay: number;
  reduce: boolean;
  word?: string;
  className?: string;
  children: ReactNode;
}) {
  const done = useAfter(delay * 1000 + 500, reduce);
  return (
    <span className={`relative flex h-6 shrink-0 items-center justify-end ${className}`}>
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.span
            key="done"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 26 }}
          >
            {children}
          </motion.span>
        ) : (
          <motion.span key="spin" exit={{ opacity: 0 }} className="flex items-center gap-1 text-[11px] text-subtle">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" /> {word}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** "Draft · waiting for you" style label. */
export function Label({ icon: Icon, children }: { icon: React.ComponentType<{ className?: string }>; children: ReactNode }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-[10.5px] font-semibold tracking-wide uppercase opacity-80">
      <Icon className="h-3 w-3" /> {children}
    </span>
  );
}

/** A blinking caret while text is still typing. */
export function Caret({ on }: { on: boolean }) {
  return on ? <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-current" /> : null;
}
