"use client";

import { AnimatePresence, motion } from "motion/react";
import { BookOpen, Check, FileText, History, Mail, MessageCircle, Mic, Network, Search, ShieldCheck, Undo2, UserCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Caret, pop, spring, useAfter, useCount, useTyped } from "@/components/public/scene-kit";
import { Showcase, type ShowcaseItem } from "@/components/public/showcase";

const PLATFORM: ShowcaseItem[] = [
  {
    key: "memory",
    icon: BookOpen,
    tag: "Memory",
    title: "Memory with citations",
    text: "Upload documents or connect Drive; every answer says which page it came from.",
    window: "Kritvia · Ask",
    scene: (reduce) => <MemoryScene reduce={reduce} />,
  },
  {
    key: "map",
    icon: Network,
    tag: "Mind map",
    title: "Mind map",
    text: "See the people, companies and deals Kritvia has learned about and how they connect.",
    window: "Kritvia · Mind map",
    scene: (reduce) => <MapScene reduce={reduce} />,
  },
  {
    key: "voice",
    icon: Mic,
    tag: "Voice",
    title: "Voice in 22 languages",
    text: "Dictate notes in Hindi, Hinglish or English; Kritvia learns your names and terms.",
    window: "Kritvia · Voice",
    scene: (reduce) => <VoiceScene reduce={reduce} />,
  },
  {
    key: "trust",
    icon: ShieldCheck,
    tag: "Trust",
    title: "Earned autonomy",
    text: "An agent acts alone on one action only after a long run of approvals without edits — and you can take it back.",
    window: "Kritvia · Agent trust",
    scene: (reduce) => <TrustScene reduce={reduce} />,
  },
];

/** "Built on a memory of your business": the platform underneath the agents, window on the left. */
export function PlatformShowcase() {
  return <Showcase items={PLATFORM} label="Platform" detail="inline" reverse stepMs={8000} />;
}

/* ----------------------------------------------------------------------------- scenes -- */

const d = (reduce: boolean, s: number) => (reduce ? 0 : s);

/** A numbered citation marker that pops in. */
function Cite({ n, on }: { n: number; on: boolean }) {
  return (
    <motion.sup
      initial={false}
      animate={on ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
      transition={{ type: "spring", stiffness: 500, damping: 22 }}
      className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-accent px-1 align-super text-[9.5px] font-bold text-accent-fg"
    >
      {n}
    </motion.sup>
  );
}

function MemoryScene({ reduce }: { reduce: boolean }) {
  const q = "What did we quote Acme Foods last time?";
  const { shown, done } = useTyped(q, { start: true, reduce, cps: 30 });
  const thinking = useAfter(1500, reduce);
  const answer = useAfter(2300, reduce);
  const c1 = useAfter(2900, reduce);
  const c2 = useAfter(3600, reduce);
  const c3 = useAfter(4300, reduce);
  const sources: { n: number; icon: LucideIcon; title: string; where: string; on: boolean }[] = [
    { n: 1, icon: FileText, title: "Proposal_AcmeFoods.pdf", where: "Page 3 · Pricing", on: c1 },
    { n: 2, icon: Mail, title: "Gmail · Advance received", where: "14 Feb · accounts@acmefoods", on: c2 },
    { n: 3, icon: MessageCircle, title: "WhatsApp · Ravi, Acme Foods", where: "20 Feb · “10 March is fine”", on: c3 },
  ];
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-strong px-3 py-2.5 text-[13px] text-fg">
        <Search className="h-4 w-4 shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate">
          {shown}
          <Caret on={!done} />
        </span>
      </div>
      <div className="relative min-h-[5.5rem]">
        <AnimatePresence mode="wait" initial={false}>
          {answer ? (
            <motion.div key="a" {...pop} transition={spring} className="rounded-2xl rounded-tl-sm border border-border bg-surface-strong px-3.5 py-3 text-[13px] leading-relaxed text-fg">
              <span className="mb-1 flex items-center gap-1 text-[10.5px] font-semibold tracking-wide text-accent uppercase">
                <BookOpen className="h-3 w-3" /> From your documents
              </span>
              ₹1,20,000 for the packaging redesign, 30% upfront
              <Cite n={1} on={c1} />. They paid the advance on 14 Feb
              <Cite n={2} on={c2} /> and agreed to delivery on 10 March
              <Cite n={3} on={c3} />.
            </motion.div>
          ) : thinking ? (
            <motion.div key="t" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2 px-1 py-2 text-[12px] text-subtle">
              <span className="flex gap-1">
                {[0, 1, 2].map((k) => (
                  <motion.span
                    key={k}
                    className="h-1.5 w-1.5 rounded-full bg-accent"
                    animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                    transition={{ duration: 0.9, repeat: Infinity, delay: k * 0.15 }}
                  />
                ))}
              </span>
              Searching your documents, email and chats
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="space-y-1.5">
        {sources.map((s) => (
          <motion.div
            key={s.n}
            initial={{ opacity: 0, x: -10 }}
            animate={s.on ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
            transition={spring}
            className="relative flex items-center gap-2.5 rounded-xl border border-accent/25 bg-surface-strong px-3 py-1.5"
          >
            {s.on && !reduce ? (
              <motion.span
                className="absolute inset-0 rounded-xl ring-2 ring-accent"
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 1.2, ease: "easeOut" }}
              />
            ) : null}
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent text-[10px] font-bold text-accent-fg">{s.n}</span>
            <s.icon className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg">{s.title}</span>
            <span className="hidden truncate text-[11px] text-subtle sm:block">{s.where}</span>
          </motion.div>
        ))}
      </div>
      <motion.p
        initial={{ opacity: 0 }}
        animate={c3 ? { opacity: 1 } : { opacity: 0 }}
        transition={{ delay: d(reduce, 0.5) }}
        className="mt-auto text-[11.5px] text-subtle"
      >
        Each number opens the page or message it came from.
      </motion.p>
    </div>
  );
}

function MapScene({ reduce }: { reduce: boolean }) {
  const people = useAfter(700, reduce);
  type P = { id: string; x: number; y: number; name: string; team: "blue" | "orange" };
  const ppl: P[] = [
    { id: "pr", x: 22, y: 30, name: "Priya", team: "blue" },
    { id: "ar", x: 40, y: 62, name: "Arjun", team: "blue" },
    { id: "ne", x: 68, y: 26, name: "Neha", team: "orange" },
    { id: "ro", x: 80, y: 64, name: "Rohit", team: "orange" },
  ];
  const projects = [
    { id: "acme", x: 30, y: 88, name: "Acme website" },
    { id: "kavya", x: 66, y: 90, name: "Kavya store" },
  ];
  // [a, b, strength] — strength sets the line width (shared tasks + handoffs).
  const links: [string, string, number][] = [
    ["pr", "ar", 3],
    ["ne", "ro", 2],
    ["ar", "ne", 1.2],
    ["pr", "acme", 0.8],
    ["ar", "acme", 0.8],
    ["ar", "kavya", 0.8],
    ["ro", "kavya", 0.8],
  ];
  const at = (id: string) => [...ppl, ...projects].find((n) => n.id === id)!;
  const pair = useAfter(3200, reduce);
  return (
    <div className="flex h-full flex-col">
      <div className="relative mx-auto flex w-fit rounded-lg border border-border bg-surface-strong p-0.5 text-[11.5px] font-medium">
        {["Knowledge", "People & projects"].map((t, k) => {
          const on = people ? k === 1 : k === 0;
          return (
            <span key={t} className={cn("relative px-2.5 py-1 transition-colors duration-300", on ? "text-accent-fg" : "text-muted")}>
              {on ? (
                <motion.span layoutId="kv-map-tab" className="absolute inset-0 rounded-md bg-accent" transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 32 }} />
              ) : null}
              <span className="relative">{t}</span>
            </span>
          );
        })}
      </div>
      <div className="relative mt-2 flex-1">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
          {links.map(([a, b, w], k) => (
            <motion.line
              key={`${a}-${b}`}
              x1={at(a).x}
              y1={at(a).y}
              x2={at(b).x}
              y2={at(b).y}
              stroke="currentColor"
              className={w > 1 ? "text-accent/70" : "text-border-strong"}
              strokeWidth={w * 0.5}
              strokeLinecap="round"
              strokeDasharray={w > 1 ? undefined : "1.2 1.2"}
              initial={{ pathLength: reduce ? 1 : 0, opacity: reduce ? 1 : 0 }}
              animate={people ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
              transition={{ delay: d(reduce, 0.6 + k * 0.18), duration: 0.6, ease: "easeOut" }}
            />
          ))}
        </svg>
        {ppl.map((p, k) => (
          <motion.div
            key={p.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            initial={{ opacity: 0, scale: reduce ? 1 : 0.4 }}
            animate={people ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.4 }}
            transition={{ ...spring, stiffness: 320, delay: d(reduce, 0.1 + k * 0.12) }}
          >
            <span className="flex flex-col items-center gap-1">
              <span
                className="relative flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white ring-2 ring-[var(--surface-solid)] shadow-card"
                style={{ background: `var(--team-${p.team})` }}
              >
                {pair && (p.id === "pr" || p.id === "ar") && !reduce ? (
                  <motion.span
                    className="absolute inset-0 rounded-full"
                    style={{ background: `var(--team-${p.team})` }}
                    animate={{ scale: [1, 1.8], opacity: [0.5, 0] }}
                    transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                  />
                ) : null}
                <span className="relative">{p.name[0]}</span>
              </span>
              <span className="rounded bg-surface-strong/90 px-1.5 text-[10.5px] font-medium text-fg">{p.name}</span>
            </span>
          </motion.div>
        ))}
        {projects.map((p, k) => (
          <motion.span
            key={p.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-surface-strong px-2 py-0.5 text-[10.5px] font-semibold whitespace-nowrap text-muted shadow-card"
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            initial={{ opacity: 0, y: reduce ? 0 : 6 }}
            animate={people ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
            transition={{ delay: d(reduce, 1.6 + k * 0.2) }}
          >
            {p.name}
          </motion.span>
        ))}
      </div>
      <div className="mt-2 h-[2.75rem]">
        <AnimatePresence>
          {pair ? (
            <motion.div
              {...pop}
              transition={spring}
              className="mx-auto flex w-fit max-w-full items-center gap-2 rounded-xl border border-border bg-surface-solid px-3 py-2 shadow-[var(--shadow-pop)]"
            >
              <span className="text-[12px] font-semibold whitespace-nowrap text-fg">Priya ↔ Arjun</span>
              <span className="truncate text-[11px] text-muted">6 shared tasks · 2 handoffs</span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="mt-1 flex items-center justify-center gap-4 text-[11px] text-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--team-blue)" }} /> Design
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--team-orange)" }} /> Sales
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-accent/70" /> works with
        </span>
      </div>
    </div>
  );
}

/** Bars that move like a voice while `on`; flat and still otherwise. */
function Wave({ on, reduce }: { on: boolean; reduce: boolean }) {
  const bars = [0.5, 0.8, 0.4, 1, 0.65, 0.9, 0.45, 0.75, 0.55, 0.95, 0.5, 0.7, 0.4, 0.85, 0.6];
  return (
    <span className="flex h-8 items-center gap-[3px]">
      {bars.map((h, k) => (
        <motion.span
          key={k}
          className="w-[3px] rounded-full bg-accent"
          style={{ height: 32 }}
          initial={{ scaleY: 0.15 }}
          animate={on && !reduce ? { scaleY: [0.15, h, 0.25, h * 0.7, 0.15] } : { scaleY: 0.15 }}
          transition={on && !reduce ? { duration: 1.1, repeat: Infinity, delay: k * 0.06, ease: "easeInOut" } : { duration: 0.3 }}
        />
      ))}
    </span>
  );
}

function VoiceScene({ reduce }: { reduce: boolean }) {
  const words = "Kal Sharma ji ko ₹45,000 ka quote bhejna hai, aur Neha ko Saturday site visit ke liye bolo.";
  const listening = !useAfter(3600, reduce);
  const { shown, done } = useTyped(words, { start: true, reduce, cps: 26 });
  const tasks = useAfter(4000, reduce);
  const langs = ["हिन्दी", "Hinglish", "English", "தமிழ்", "বাংলা", "मराठी", "ગુજરાતી", "తెలుగు"];
  // Highlight names Kritvia has learned, once they're fully typed.
  const names = ["Sharma ji", "Neha"];
  const parts = shown.split(new RegExp(`(${names.join("|")})`));
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
          {listening && !reduce
            ? [0, 1].map((k) => (
                <motion.span
                  key={k}
                  className="absolute inset-0 rounded-full bg-accent"
                  animate={{ scale: [1, 1.9], opacity: [0.35, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, delay: k * 0.8, ease: "easeOut" }}
                />
              ))
            : null}
          <span className={cn("relative flex h-11 w-11 items-center justify-center rounded-full shadow-card transition-colors duration-300", listening ? "bg-accent text-accent-fg" : "bg-success text-white")}>
            {listening ? <Mic className="h-5 w-5" /> : <Check className="h-5 w-5" />}
          </span>
        </span>
        <Wave on={listening} reduce={reduce} />
        <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent">Hinglish</span>
      </div>
      <p className="min-h-[3.5rem] rounded-xl border border-border bg-surface-strong px-3 py-2.5 text-[13px] leading-relaxed text-fg">
        {parts.map((t, k) =>
          names.includes(t) ? (
            <span key={k} className="rounded bg-accent-soft px-0.5 font-medium text-accent underline decoration-accent/40 decoration-dotted underline-offset-2">
              {t}
            </span>
          ) : (
            <span key={k}>{t}</span>
          ),
        )}
        <Caret on={!done} />
      </p>
      <div className="space-y-1.5">
        {(
          [
            [UserCheck, "Send ₹45,000 quote to Sharma ji", "Tomorrow"],
            [UserCheck, "Ask Neha about the site visit", "Sat"],
          ] as [LucideIcon, string, string][]
        ).map(([Icon, t, when], k) => (
          <motion.div
            key={t}
            initial={{ opacity: 0, x: -10 }}
            animate={tasks ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
            transition={{ ...spring, delay: d(reduce, k * 0.35) }}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-strong px-3 py-1.5"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{t}</span>
            <span className="text-[11px] text-subtle">{when}</span>
          </motion.div>
        ))}
      </div>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={tasks ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
        transition={{ delay: d(reduce, 0.8) }}
        className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-subtle"
      >
        Your words it knows:
        {["Sharma ji", "Neha", "Kavya Textiles", "site visit"].map((w) => (
          <span key={w} className="rounded-md bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
            {w}
          </span>
        ))}
      </motion.div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {langs.map((l, k) => (
          <motion.span
            key={l}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: d(reduce, 0.2 + k * 0.06) }}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px]",
              l === "Hinglish" ? "border-accent/40 bg-accent-soft font-medium text-accent" : "border-border bg-surface-strong text-muted",
            )}
          >
            {l}
          </motion.span>
        ))}
        <span className="text-[11px] text-subtle">+ 14 more</span>
      </div>
    </div>
  );
}

function TrustScene({ reduce }: { reduce: boolean }) {
  const NEED = 30;
  const n = useCount(NEED, { start: true, reduce, ms: 2400 });
  const earned = n >= NEED;
  const switched = useAfter(3600, reduce);
  const acted = useAfter(4600, reduce);
  return (
    <div className="flex h-full flex-col gap-3">
      <motion.div {...pop} transition={{ ...spring, delay: d(reduce, 0.05) }} className="rounded-xl border border-border bg-surface-strong px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-fg">Payment reminders</span>
            <span className="block truncate text-[11px] text-subtle">Inbox assistant · send reminder</span>
          </span>
          <AnimatePresence>
            {earned ? (
              <motion.span
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 20 }}
                className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success-fg"
              >
                <ShieldCheck className="h-3 w-3" /> Earned
              </motion.span>
            ) : null}
          </AnimatePresence>
        </div>
        <div className="mt-3 grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1">
          {Array.from({ length: NEED }, (_, k) => (
            <span
              key={k}
              className={cn("h-2.5 rounded-sm transition-colors duration-200", k < n ? "bg-success" : "bg-accent/10")}
            />
          ))}
        </div>
        <p className="mt-2 flex items-baseline justify-between text-[11.5px] text-subtle">
          <span>
            <span className="font-semibold text-fg tabular-nums">{n}</span> of {NEED} approvals in a row without edits
          </span>
          <span className="hidden sm:inline">An edit starts the count again</span>
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={earned ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
        transition={spring}
        className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-strong px-3.5 py-2.5"
      >
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium text-fg">Send on its own</span>
          <span className="block text-[11px] text-subtle">Only this action · you switch it on</span>
        </span>
        <span className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors duration-300", switched ? "bg-success" : "bg-border-strong")}>
          <motion.span
            className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-card"
            initial={false}
            animate={{ x: switched ? 20 : 0 }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 30 }}
          />
        </span>
      </motion.div>

      <div className="space-y-1.5">
        {(
          [
            [Check, "Reminder sent to Acme Foods · on its own"],
            [History, "Written to the audit log"],
          ] as [LucideIcon, string][]
        ).map(([Icon, t], k) => (
          <motion.div
            key={t}
            initial={{ opacity: 0, x: -10 }}
            animate={acted ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
            transition={{ ...spring, delay: d(reduce, k * 0.35) }}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-strong px-3 py-1.5"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-success" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{t}</span>
          </motion.div>
        ))}
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={acted ? { opacity: 1 } : { opacity: 0 }}
        transition={{ delay: d(reduce, 0.8) }}
        className="mt-auto flex items-center gap-1.5 text-[11.5px] text-subtle"
      >
        <Undo2 className="h-3.5 w-3.5 text-accent" /> Switch it off any time; it goes back to asking you first.
      </motion.p>
    </div>
  );
}

