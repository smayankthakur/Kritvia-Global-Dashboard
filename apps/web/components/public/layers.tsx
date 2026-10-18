"use client";

import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
} from "motion/react";
import {
  BrainCircuit,
  CalendarCheck,
  Check,
  CheckCheck,
  Clock,
  Globe,
  Inbox,
  Mail,
  MessageCircle,
  PenLine,
  Quote,
  Send,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";

const STEP_MS = 7000;

const LAYERS: {
  key: string;
  icon: LucideIcon;
  tag: string;
  title: string;
  text: string;
  window: string;
}[] = [
  {
    key: "capture",
    icon: Inbox,
    tag: "Layer 1 · Capture",
    title: "Every message lands in one inbox, sorted.",
    text: "WhatsApp, email, Telegram and your website's form arrive in one place. Kritvia reads each one and files it: enquiry, payment, booking or stock.",
    window: "Kritvia · Inbox",
  },
  {
    key: "remember",
    icon: BrainCircuit,
    tag: "Layer 2 · Remember",
    title: "A memory of your business, with sources.",
    text: "Customers, jobs, prices and promises become a map of how things connect. Every fact links back to the message or document it came from.",
    window: "Kritvia · Memory",
  },
  {
    key: "draft",
    icon: PenLine,
    tag: "Layer 3 · Draft",
    title: "Agents draft in your voice.",
    text: "Replies, proposals, invoices and follow-ups in Hindi, Hinglish or English, priced from your rate card, never a made-up number.",
    window: "Kritvia · Draft",
  },
  {
    key: "act",
    icon: ShieldCheck,
    tag: "Layer 4 · Approve & act",
    title: "You say yes. Then it does the work.",
    text: "Nothing is sent, paid or changed until you approve. Then it sends, books and sets the reminder, and tells you what it did.",
    window: "Kritvia · Approvals",
  },
];

/**
 * "Four layers": tabs on the left, a small animated window on the right showing that layer at work.
 * Advances by itself while on screen (pauses on hover or focus); a click picks a layer. With reduced
 * motion it doesn't advance and each scene shows its finished state. Scenes are illustrations
 * (example data), hidden from screen readers; each tab panel has the same story in text.
 */
export function Layers() {
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
    const t = setTimeout(() => setI((x) => (x + 1) % LAYERS.length), STEP_MS);
    return () => clearTimeout(t);
  }, [running, i, round]);

  // Pause while the pointer or keyboard focus is inside.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = () => setPaused(true);
    const off = (e: Event) => {
      if (
        e.type === "focusout" &&
        el.contains((e as FocusEvent).relatedTarget as Node)
      )
        return;
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

  // On phones the tabs are a sideways strip: keep the current one in view (the page doesn't move).
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    const tab = document.getElementById(`${uid}-tab-${i}`);
    if (el && tab && el.scrollWidth > el.clientWidth)
      el.scrollTo({
        left:
          el.scrollLeft +
          tab.getBoundingClientRect().left -
          el.getBoundingClientRect().left -
          16,
        behavior: reduce ? "auto" : "smooth",
      });
  }, [i, uid, reduce]);

  const pick = (n: number) => {
    setI(n);
    setRound((r) => r + 1);
  };
  const L = LAYERS[i]!;

  return (
    <div
      ref={root}
      role="group"
      aria-label="Kritvia's four layers"
      className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.35fr)]"
    >
      <div
        ref={list}
        role="tablist"
        aria-label="Layers"
        aria-orientation="vertical"
        className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
      >
        {LAYERS.map((l, n) => {
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
                if (d) {
                  e.preventDefault();
                  const nn = (n + d + LAYERS.length) % LAYERS.length;
                  pick(nn);
                  document.getElementById(`${uid}-tab-${nn}`)?.focus();
                }
              }}
              className={cn(
                "group relative w-[17rem] shrink-0 overflow-hidden rounded-2xl border p-4 text-left transition-[background-color,border-color,box-shadow,transform] duration-300 lg:w-auto",
                on
                  ? "glass-strong border-accent/40 shadow-card"
                  : "glass border-border hover:-translate-y-0.5 hover:border-border-strong",
              )}
            >
              <span className="flex items-start gap-3">
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors duration-300",
                    on
                      ? "bg-accent text-accent-fg"
                      : "bg-accent-soft text-accent",
                  )}
                >
                  <l.icon className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold tracking-wider text-subtle uppercase">
                    {l.tag}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 block text-[15px] leading-snug font-semibold",
                      on ? "text-fg" : "text-muted",
                    )}
                  >
                    {l.title}
                  </span>
                </span>
              </span>
              {on ? (
                <span
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-accent/15"
                  aria-hidden
                >
                  <motion.span
                    key={`${i}-${round}-${running}`}
                    className="block h-full origin-left bg-accent"
                    initial={{ scaleX: running ? 0 : 1 }}
                    animate={{ scaleX: 1 }}
                    transition={{
                      duration: running ? STEP_MS / 1000 : 0,
                      ease: "linear",
                    }}
                  />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        id={`${uid}-panel`}
        role="tabpanel"
        aria-labelledby={`${uid}-tab-${i}`}
        className="min-w-0"
      >
        <p className="sr-only">{L.text}</p>
        <div
          aria-hidden
          className="glass-strong relative overflow-hidden rounded-2xl border shadow-[var(--shadow-pop)]"
        >
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
                className="ml-2 text-xs font-medium text-subtle"
              >
                {L.window}
              </motion.span>
            </AnimatePresence>
            <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success-fg">
              <span className="relative flex h-1.5 w-1.5">
                {!reduce ? (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                ) : null}
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              Example
            </span>
          </div>
          <div className="relative h-[22rem] sm:h-[24rem]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${L.key}-${round}`}
                className="absolute inset-0 p-4 sm:p-5"
                initial={{ opacity: 0, x: 18, filter: "blur(6px)" }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, x: -18, filter: "blur(6px)" }}
                transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
              >
                {L.key === "capture" ? <Capture reduce={reduce} /> : null}
                {L.key === "remember" ? <Remember reduce={reduce} /> : null}
                {L.key === "draft" ? <Draft reduce={reduce} /> : null}
                {L.key === "act" ? <Act reduce={reduce} /> : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={L.key}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="mt-4 text-[15px] leading-relaxed text-muted"
            aria-hidden
          >
            {L.text}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- scenes -- */

/** Typewriter: reveals `text` over time once `start` is true. */
function useTyped(
  text: string,
  {
    start = true,
    cps = 38,
    reduce = false,
  }: { start?: boolean; cps?: number; reduce?: boolean },
) {
  const [n, setN] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (reduce) {
      setN(text.length);
      return;
    }
    if (!start) return;
    setN(0);
    const id = setInterval(
      () => setN((x) => (x >= text.length ? (clearInterval(id), x) : x + 1)),
      1000 / cps,
    );
    return () => clearInterval(id);
  }, [text, start, cps, reduce]);
  return { shown: text.slice(0, n), done: n >= text.length };
}

/** Becomes true `ms` after mount (immediately with reduced motion). */
function useAfter(ms: number, reduce: boolean) {
  const [on, setOn] = useState(reduce);
  useEffect(() => {
    if (reduce) return;
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [ms, reduce]);
  return on;
}

const pop = {
  initial: { opacity: 0, y: 12, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
};

function Capture({ reduce }: { reduce: boolean }) {
  const items: {
    icon: LucideIcon;
    from: string;
    text: string;
    chip: string;
    tone: string;
  }[] = [
    {
      icon: MessageCircle,
      from: "Ravi Kumar · WhatsApp",
      text: "Sofa cleaning ka rate kya hai? 3-seater hai.",
      chip: "Enquiry · hot",
      tone: "bg-danger-soft text-danger-fg",
    },
    {
      icon: Mail,
      from: "Acme Foods · Email",
      text: "Has invoice INV/26-27/0041 been received?",
      chip: "Payment",
      tone: "bg-success-soft text-success-fg",
    },
    {
      icon: Globe,
      from: "Neha · Website form",
      text: "Kitchen deep clean this Saturday, 2BHK.",
      chip: "Booking",
      tone: "bg-info-soft text-info-fg",
    },
    {
      icon: Send,
      from: "Fresh Dairy · Telegram",
      text: "20 kg paneer delivered, bill attached.",
      chip: "Stock",
      tone: "bg-warning-soft text-warning-fg",
    },
  ];
  return (
    <div className="flex h-full flex-col gap-2.5">
      {items.map((m, k) => (
        <motion.div
          key={m.from}
          {...pop}
          transition={{
            delay: reduce ? 0 : 0.25 + k * 0.9,
            type: "spring",
            stiffness: 260,
            damping: 24,
          }}
          className="flex items-center gap-3 rounded-xl border border-border bg-surface-strong px-3 py-2.5"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <m.icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] text-subtle">
              {m.from}
            </span>
            <span className="block truncate text-[13px] text-fg">{m.text}</span>
          </span>
          <Sorted delay={reduce ? 0 : 0.25 + k * 0.9 + 0.55} reduce={reduce}>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
                m.tone,
              )}
            >
              {m.chip}
            </span>
          </Sorted>
        </motion.div>
      ))}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: reduce ? 0 : 4.2 }}
        className="mt-auto flex items-center gap-1.5 text-xs text-subtle"
      >
        <Sparkles className="h-3.5 w-3.5 text-accent" /> 4 new · 1 lead added ·
        1 booking request · tasks pulled out
      </motion.p>
    </div>
  );
}

/** A tiny "reading…" spinner that turns into the label. */
function Sorted({
  delay,
  reduce,
  children,
}: {
  delay: number;
  reduce: boolean;
  children: ReactNode;
}) {
  const done = useAfter(delay * 1000 + 500, reduce);
  return (
    <span className="relative flex h-6 min-w-[5.5rem] shrink-0 items-center justify-end">
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.span
            key="chip"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 26 }}
          >
            {children}
          </motion.span>
        ) : (
          <motion.span
            key="spin"
            exit={{ opacity: 0 }}
            className="flex items-center gap-1 text-[11px] text-subtle"
          >
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />{" "}
            reading
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function Remember({ reduce }: { reduce: boolean }) {
  const nodes: {
    id: string;
    x: number;
    y: number;
    label: string;
    kind: "person" | "service" | "money" | "job" | "team";
  }[] = [
    { id: "ravi", x: 50, y: 46, label: "Ravi Kumar", kind: "person" },
    { id: "sofa", x: 20, y: 22, label: "Sofa cleaning", kind: "service" },
    { id: "price", x: 15, y: 70, label: "₹899 · rate card", kind: "money" },
    { id: "job", x: 80, y: 20, label: "Job · 12 Mar", kind: "job" },
    { id: "priya", x: 84, y: 66, label: "Priya (team)", kind: "team" },
    { id: "addr", x: 52, y: 86, label: "Dwarka Sec 12", kind: "job" },
  ];
  const links: [string, string][] = [
    ["ravi", "sofa"],
    ["sofa", "price"],
    ["ravi", "job"],
    ["job", "priya"],
    ["ravi", "addr"],
    ["ravi", "priya"],
  ];
  const color: Record<string, string> = {
    person: "var(--team-blue)",
    service: "var(--team-aqua)",
    money: "var(--team-yellow)",
    job: "var(--team-violet)",
    team: "var(--team-orange)",
  };
  const at = (id: string) => nodes.find((n) => n.id === id)!;
  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          {links.map(([a, b], k) => (
            <motion.line
              key={`${a}-${b}`}
              x1={at(a).x}
              y1={at(a).y}
              x2={at(b).x}
              y2={at(b).y}
              stroke="currentColor"
              className="text-border-strong"
              strokeWidth={0.4}
              initial={{ pathLength: reduce ? 1 : 0, opacity: reduce ? 1 : 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{
                delay: reduce ? 0 : 0.5 + k * 0.28,
                duration: 0.6,
                ease: "easeOut",
              }}
            />
          ))}
        </svg>
        {nodes.map((n, k) => (
          <motion.div
            key={n.id}
            className="absolute -translate-x-1/2 -translate-y-2"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
            initial={{ opacity: 0, scale: reduce ? 1 : 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              delay: reduce ? 0 : k * 0.18,
              type: "spring",
              stiffness: 300,
              damping: 20,
            }}
          >
            <span className="flex flex-col items-center gap-1">
              <span className="relative flex h-4 w-4 items-center justify-center">
                {n.id === "ravi" && !reduce ? (
                  <motion.span
                    className="absolute inset-0 rounded-full"
                    style={{ background: color[n.kind] }}
                    animate={{ scale: [1, 2.4], opacity: [0.45, 0] }}
                    transition={{
                      duration: 1.8,
                      repeat: Infinity,
                      ease: "easeOut",
                    }}
                  />
                ) : null}
                <span
                  className="relative h-3.5 w-3.5 rounded-full ring-2 ring-[var(--surface-solid)]"
                  style={{ background: color[n.kind] }}
                />
              </span>
              <span className="rounded-md bg-surface-strong/90 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-fg shadow-card">
                {n.label}
              </span>
            </span>
          </motion.div>
        ))}
      </div>
      <motion.div
        {...pop}
        transition={{
          delay: reduce ? 0 : 2.4,
          type: "spring",
          stiffness: 240,
          damping: 24,
        }}
        className="mt-3 rounded-xl border border-border bg-surface-strong px-3 py-2.5"
      >
        <p className="flex items-start gap-2 text-[13px] text-fg">
          <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          Ravi booked a 3-seater sofa clean in March; Priya did the job.
        </p>
        <p className="mt-1 pl-5 text-[11.5px] text-accent">
          From WhatsApp, 12 Mar · open the message ›
        </p>
      </motion.div>
    </div>
  );
}

function Draft({ reduce }: { reduce: boolean }) {
  const reply =
    "Namaste Ravi ji! 3-seater sofa shampoo cleaning ₹899 hai. Saturday 11 baje ka slot khaali hai. Kya main book kar doon?";
  const started = useAfter(700, reduce);
  const { shown, done } = useTyped(reply, { start: started, reduce, cps: 34 });
  return (
    <div className="flex h-full flex-col gap-3">
      <motion.div
        {...pop}
        transition={{ delay: reduce ? 0 : 0.1 }}
        className="max-w-[85%] self-start rounded-2xl rounded-tl-sm border border-border bg-surface-strong px-3 py-2 text-[13px] text-fg"
      >
        Sofa cleaning ka rate kya hai? 3-seater hai.
        <span className="mt-0.5 block text-[10.5px] text-subtle">
          Ravi Kumar · WhatsApp
        </span>
      </motion.div>
      <motion.div
        {...pop}
        transition={{ delay: reduce ? 0 : 0.45 }}
        className="max-w-[88%] self-end rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-[13px] leading-relaxed text-accent-fg shadow-card"
      >
        <span className="mb-1 flex items-center gap-1 text-[10.5px] font-semibold tracking-wide uppercase opacity-80">
          <PenLine className="h-3 w-3" /> Draft · waiting for you
        </span>
        {shown}
        {!done ? (
          <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-0.5 animate-pulse bg-current" />
        ) : null}
      </motion.div>
      <div className="mt-auto flex flex-wrap gap-2">
        {[
          [Sparkles, "Priced from your rate card"],
          [CalendarCheck, "Slot from your calendar"],
          [MessageCircle, "Hinglish, like the customer"],
        ].map(([Icon, t], k) => {
          const I = Icon as LucideIcon;
          return (
            <motion.span
              key={t as string}
              initial={{ opacity: 0, y: 8 }}
              animate={done ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
              transition={{ delay: reduce ? 0 : 0.15 + k * 0.15 }}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-strong px-2.5 py-1 text-[11.5px] text-muted"
            >
              <I className="h-3.5 w-3.5 text-accent" /> {t as string}
            </motion.span>
          );
        })}
      </div>
    </div>
  );
}

function Act({ reduce }: { reduce: boolean }) {
  const pressed = useAfter(1500, reduce);
  const steps: {
    icon: LucideIcon;
    text: string;
    state: "Done" | "Scheduled" | "Asks first";
  }[] = [
    { icon: Send, text: "Send the WhatsApp reply to Ravi", state: "Done" },
    {
      icon: CalendarCheck,
      text: "Book Saturday 11:00 · sofa cleaning",
      state: "Done",
    },
    {
      icon: Clock,
      text: "Reminder to Ravi on Friday, 6 pm",
      state: "Scheduled",
    },
    { icon: PenLine, text: "Invoice after the job", state: "Asks first" },
  ];
  const tone = {
    Done: "bg-success-soft text-success-fg",
    Scheduled: "bg-info-soft text-info-fg",
    "Asks first": "bg-warning-soft text-warning-fg",
  };
  return (
    <div className="flex h-full flex-col gap-2.5">
      <motion.div
        {...pop}
        transition={{ delay: reduce ? 0 : 0.1 }}
        className="rounded-xl border border-border bg-surface-strong"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold text-fg">
            Reply to Ravi Kumar
          </span>
          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10.5px] font-medium text-danger-fg">
            hot lead
          </span>
        </div>
        <p className="px-3 py-2 text-[12.5px] text-muted">
          ₹899 · Saturday 11:00 · Hinglish
        </p>
        <div className="flex justify-end gap-2 border-t border-border bg-surface-2 px-3 py-2">
          <span className="rounded-md px-2 py-1 text-[11.5px] text-muted">
            Edit
          </span>
          <motion.span
            animate={pressed ? { scale: [1, 0.92, 1] } : { scale: 1 }}
            transition={{ duration: 0.35 }}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11.5px] font-medium shadow-card transition-colors duration-300",
              pressed ? "bg-success text-white" : "bg-accent text-accent-fg",
            )}
          >
            {pressed ? (
              <CheckCheck className="h-3.5 w-3.5" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {pressed ? "Approved" : "Approve & send"}
          </motion.span>
        </div>
      </motion.div>
      {steps.map((st, k) => (
        <motion.div
          key={st.text}
          initial={{ opacity: 0, x: -10 }}
          animate={pressed ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
          transition={{
            delay: reduce ? 0 : 0.35 + k * 0.45,
            type: "spring",
            stiffness: 260,
            damping: 24,
          }}
          className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-strong px-3 py-2"
        >
          <st.icon className="h-4 w-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
            {st.text}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10.5px] font-semibold whitespace-nowrap uppercase",
              tone[st.state],
            )}
          >
            {st.state}
          </span>
        </motion.div>
      ))}
    </div>
  );
}
