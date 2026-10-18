"use client";

import { motion } from "motion/react";
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
import { cn } from "@/components/ui/cn";
import { pop, Resolving, useAfter, useTyped } from "@/components/public/scene-kit";
import { Showcase, type ShowcaseItem } from "@/components/public/showcase";

const LAYERS: ShowcaseItem[] = [
  {
    key: "capture",
    icon: Inbox,
    tag: "Layer 1 · Capture",
    title: "Every message lands in one inbox, sorted.",
    text: "WhatsApp, email, Telegram and your website's form arrive in one place. Kritvia reads each one and files it: enquiry, payment, booking or stock.",
    window: "Kritvia · Inbox",
    scene: (reduce) => <Capture reduce={reduce} />,
  },
  {
    key: "remember",
    icon: BrainCircuit,
    tag: "Layer 2 · Remember",
    title: "A memory of your business, with sources.",
    text: "Customers, jobs, prices and promises become a map of how things connect. Every fact links back to the message or document it came from.",
    window: "Kritvia · Memory",
    scene: (reduce) => <Remember reduce={reduce} />,
  },
  {
    key: "draft",
    icon: PenLine,
    tag: "Layer 3 · Draft",
    title: "Agents draft in your voice.",
    text: "Replies, proposals, invoices and follow-ups in Hindi, Hinglish or English, priced from your rate card, never a made-up number.",
    window: "Kritvia · Draft",
    scene: (reduce) => <Draft reduce={reduce} />,
  },
  {
    key: "act",
    icon: ShieldCheck,
    tag: "Layer 4 · Approve & act",
    title: "You say yes. Then it does the work.",
    text: "Nothing is sent, paid or changed until you approve. Then it sends, books and sets the reminder, and tells you what it did.",
    window: "Kritvia · Approvals",
    scene: (reduce) => <Act reduce={reduce} />,
  },
];

/** "One app, four layers": each layer of Kritvia at work in a small example window. */
export function Layers() {
  return <Showcase items={LAYERS} label="Kritvia's four layers" />;
}

/* ----------------------------------------------------------------------------- scenes -- */

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
          <Resolving delay={reduce ? 0 : 0.25 + k * 0.9 + 0.55} reduce={reduce}>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
                m.tone,
              )}
            >
              {m.chip}
            </span>
          </Resolving>
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
