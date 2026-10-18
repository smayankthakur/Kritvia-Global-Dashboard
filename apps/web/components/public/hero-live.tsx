"use client";

import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
} from "motion/react";
import {
  Check,
  CheckCheck,
  Inbox,
  MessageCircle,
  PenLine,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";

/** Timeline (ms) of one loop: message arrives → draft appears → cursor approves → sent → reset. */
const PHASES = [0, 900, 2000, 4300, 5100, 5700, 10500];

/**
 * The hero picture, alive: a WhatsApp enquiry arrives, the draft proposal fills in, a cursor
 * approves it and it goes out. Example content, hidden from screen readers (the copy beside it says
 * the same). Loops only while on screen; with reduced motion it shows the finished state, still.
 */
export function HeroLive({ className }: { className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.3 });
  const [phase, setPhase] = useState(reduce ? 5 : 0);
  const [loop, setLoop] = useState(0);

  useEffect(() => {
    if (reduce) {
      setPhase(5);
      return;
    }
    if (!inView) return;
    const ts = PHASES.slice(1).map((ms, k) =>
      setTimeout(() => {
        if (k === PHASES.length - 2) {
          setPhase(0);
          setLoop((l) => l + 1);
        } else setPhase(k + 1);
      }, ms),
    );
    return () => ts.forEach(clearTimeout);
  }, [inView, loop, reduce]);

  const waiting = phase >= 5 ? 2 : phase >= 1 ? 3 : 2;
  const sent = phase >= 4;

  return (
    <div
      ref={root}
      aria-hidden
      className={cn("relative select-none", className)}
    >
      <div className="absolute -inset-x-2 -top-6 -bottom-8 -z-10 rounded-[2rem] bg-[radial-gradient(closest-side,var(--accent-soft),transparent)] blur-2xl sm:-inset-x-6" />
      <motion.div
        className="space-y-3"
        animate={reduce ? undefined : { y: [0, -6, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      >
        <div className="glass flex items-center justify-between rounded-2xl border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Inbox className="h-4 w-4" />
              <AnimatePresence>
                {phase >= 1 && phase < 5 ? (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    exit={{ scale: 0 }}
                    className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-danger ring-2 ring-[var(--surface-solid)]"
                  />
                ) : null}
              </AnimatePresence>
            </span>
            <div className="leading-tight">
              <p className="text-[13px] font-semibold text-fg">
                Approval inbox
              </p>
              <p className="text-[11.5px] text-subtle">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={waiting}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="inline-block tabular-nums"
                  >
                    {waiting}
                  </motion.span>
                </AnimatePresence>{" "}
                drafts waiting · Example
              </p>
            </div>
          </div>
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-fg">
            Needs you
          </span>
        </div>

        <div className="relative h-[19.5rem]">
          <AnimatePresence>
            {phase >= 1 && phase < 2 ? (
              <motion.div
                key={`msg-${loop}`}
                initial={{ opacity: 0, x: 40, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.97 }}
                transition={{ type: "spring", stiffness: 260, damping: 22 }}
                className="glass-strong absolute inset-x-0 top-0 flex items-start gap-3 rounded-2xl border px-4 py-3"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                  <MessageCircle className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-[11.5px] text-subtle">
                    New on WhatsApp · Arjun Mehta
                  </p>
                  <p className="text-[13px] text-fg">
                    Website redesign ka quote bhej dijiye — 12 pages, lead form
                    chahiye.
                  </p>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {phase >= 2 ? (
              <motion.div
                key={`card-${loop}`}
                initial={{ opacity: 0, y: 24, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 220, damping: 24 }}
                className="glass-strong absolute inset-x-0 top-0 rounded-2xl border"
              >
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0 leading-tight">
                    <p className="truncate text-[13px] font-semibold text-fg">
                      Proposal: website redesign
                    </p>
                    <p className="truncate text-[11.5px] text-subtle">
                      Lead triage · Arjun Mehta on WhatsApp
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger-fg">
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                    hot
                  </span>
                </div>
                <div className="space-y-2.5 px-4 py-3 text-[12.5px] leading-relaxed text-muted">
                  <Lines reduce={reduce} />
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: reduce ? 0 : 1.4 }}
                    className="flex items-center gap-1.5 text-[11.5px] text-subtle"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-accent" />
                    Priced from your rate card · cites 2 past projects
                  </motion.p>
                </div>
                <div className="relative flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-2.5">
                  <span className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted">
                    <X className="h-3.5 w-3.5" /> Reject
                  </span>
                  <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-strong px-2.5 text-[12px] font-medium text-fg">
                    <PenLine className="h-3.5 w-3.5" /> Edit
                  </span>
                  <motion.span
                    animate={
                      phase === 4 ? { scale: [1, 0.9, 1.04, 1] } : { scale: 1 }
                    }
                    transition={{ duration: 0.45 }}
                    className={cn(
                      "relative inline-flex h-7 items-center gap-1 overflow-hidden rounded-md px-2.5 text-[12px] font-medium shadow-card transition-colors duration-300",
                      sent
                        ? "bg-success text-white"
                        : "bg-accent text-accent-fg",
                    )}
                  >
                    {sent ? (
                      <CheckCheck className="h-3.5 w-3.5" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    {sent ? "Sent" : "Approve & send"}
                    {phase === 4 ? (
                      <motion.span
                        className="absolute inset-0 rounded-md bg-white/50"
                        initial={{ scale: 0, opacity: 0.8 }}
                        animate={{ scale: 2.2, opacity: 0 }}
                        transition={{ duration: 0.6 }}
                      />
                    ) : null}
                  </motion.span>
                  {!reduce && phase >= 3 && phase < 5 ? (
                    <motion.svg
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      className="pointer-events-none absolute drop-shadow-md"
                      initial={{ right: -10, bottom: -60, opacity: 0 }}
                      animate={{ right: 36, bottom: 2, opacity: 1 }}
                      transition={{ duration: 0.8, ease: [0.3, 0.7, 0.2, 1] }}
                    >
                      <path
                        d="M5 3l14 8-6 2-3 6z"
                        fill="var(--fg)"
                        stroke="var(--surface-solid)"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                    </motion.svg>
                  ) : null}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {phase >= 5 ? (
              <motion.div
                key={`done-${loop}`}
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 22 }}
                className="glass absolute inset-x-0 bottom-0 ml-8 flex items-center gap-2.5 rounded-2xl border px-4 py-2.5"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success-soft text-success">
                  <Send className="h-3.5 w-3.5" />
                </span>
                <p className="text-[12px] text-muted">
                  <span className="font-medium text-fg">
                    Sent to Arjun on WhatsApp
                  </span>{" "}
                  · follow-up set for 3 days
                </p>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

/** The proposal text, filling in line by line. */
function Lines({ reduce }: { reduce: boolean }) {
  const parts = [
    "Namaste Arjun ji, thanks for the brief. For a 12-page site with a lead form we quote ",
    "₹1,15,000",
    ", delivered in four weeks, with two rounds of changes…",
  ];
  return (
    <p>
      {parts.map((t, k) => (
        <motion.span
          key={k}
          initial={{ opacity: reduce ? 1 : 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: reduce ? 0 : 0.25 + k * 0.35, duration: 0.4 }}
          className={k === 1 ? "font-semibold text-fg" : undefined}
        >
          {t}
        </motion.span>
      ))}
    </p>
  );
}
