"use client";

import { motion } from "motion/react";
import {
  AlertTriangle,
  Briefcase,
  CalendarCheck,
  Check,
  ChefHat,
  FileCheck2,
  FolderOpen,
  Inbox,
  Landmark,
  ListTodo,
  Lock,
  Mail,
  MessageCircle,
  PenLine,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Caret, inr, Label, pop, Resolving, spring, useAfter, useCount, useTyped } from "@/components/public/scene-kit";
import { Showcase, type ShowcaseItem } from "@/components/public/showcase";

/** Only what is live today; the texts match what each agent does in the product. */
const AGENTS: ShowcaseItem[] = [
  {
    key: "inbox",
    icon: Inbox,
    tag: "Every business",
    title: "Inbox assistant",
    text: "Sorts every email and WhatsApp message, files it, pulls out tasks and drafts a reply in your voice from what it knows about your business.",
    window: "Kritvia · Inbox assistant",
    scene: (reduce) => <InboxScene reduce={reduce} />,
  },
  {
    key: "leads",
    icon: Users,
    tag: "Studios & agencies",
    title: "Lead triage & proposals",
    text: "Scores each enquiry, prices it from your rate card — never a made-up number — and drafts a proposal citing your past work, plus a call invite.",
    window: "Kritvia · Lead triage",
    scene: (reduce) => <LeadScene reduce={reduce} />,
  },
  {
    key: "loans",
    icon: Landmark,
    tag: "Finance",
    title: "Loan document checks",
    text: "Reads KYC, bank statements and salary slips on a private model, checks them against your checklist and drafts the follow-up for what's missing.",
    window: "Kritvia · Loan file",
    scene: (reduce) => <LoanScene reduce={reduce} />,
  },
  {
    key: "kitchen",
    icon: ChefHat,
    tag: "Cloud kitchens",
    title: "Nightly kitchen plan",
    text: "Forecasts tomorrow's demand per dish from your Swiggy and Zomato reports, converts it to ingredients and drafts vendor purchase orders.",
    window: "Kritvia · Kitchen plan",
    scene: (reduce) => <KitchenScene reduce={reduce} />,
  },
];

/** "Agents you can switch on today": each agent doing one real job, in an example window. */
export function AgentsShowcase() {
  return <Showcase items={AGENTS} label="Agents" detail="inline" stepMs={8000} />;
}

/* ----------------------------------------------------------------------------- scenes -- */

const d = (reduce: boolean, s: number) => (reduce ? 0 : s);

function InboxScene({ reduce }: { reduce: boolean }) {
  const reply = "Hi Rohan, the revised drawings will be with you by Thursday, and Saturday 11 am works for the site visit. Shall I confirm it?";
  const typing = useAfter(3300, reduce);
  const { shown, done } = useTyped(reply, { start: typing, reduce, cps: 46 });
  const tasks: [LucideIcon, string, string][] = [
    [FolderOpen, "Send revised kitchen drawings", "Thu"],
    [CalendarCheck, "Site visit, Mehta residence", "Sat 11:00"],
  ];
  return (
    <div className="flex h-full flex-col gap-2.5">
      <motion.div {...pop} transition={{ ...spring, delay: d(reduce, 0.15) }} className="rounded-xl border border-border bg-surface-strong px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Mail className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] text-subtle">Rohan Mehta · Email</span>
            <span className="block truncate text-[13px] font-medium text-fg">Revised drawings + site visit?</span>
          </span>
          <Resolving delay={d(reduce, 0.6)} reduce={reduce} className="min-w-[4.5rem]">
            <span className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-medium text-info-fg">Client</span>
          </Resolving>
        </div>
        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-muted">
          Could you send the revised kitchen drawings by Thursday? Also, can someone visit the site on Saturday morning?
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: d(reduce, 1.3) }}
        className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-subtle"
      >
        <Briefcase className="h-3.5 w-3.5 text-accent" /> Filed under
        <span className="rounded-md border border-border bg-surface-strong px-1.5 py-0.5 font-medium text-fg">Mehta residence · kitchen</span>
      </motion.div>

      <div className="space-y-1.5">
        {tasks.map(([Icon, t, when], k) => (
          <motion.div
            key={t}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...spring, delay: d(reduce, 1.8 + k * 0.45) }}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-strong px-3 py-1.5"
          >
            <ListTodo className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{t}</span>
            <span className="inline-flex items-center gap-1 text-[11px] text-subtle">
              <Icon className="h-3 w-3" /> {when}
            </span>
          </motion.div>
        ))}
      </div>

      <motion.div
        {...pop}
        transition={{ ...spring, delay: d(reduce, 3.1) }}
        className="mt-auto rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-[12.5px] leading-relaxed text-accent-fg shadow-card"
      >
        <Label icon={PenLine}>Reply in your voice · waiting for you</Label>
        {shown}
        <Caret on={typing && !done} />
      </motion.div>
    </div>
  );
}

/** A small ring that fills to `value` out of 100. */
function ScoreRing({ value, start, reduce }: { value: number; start: boolean; reduce: boolean }) {
  const n = useCount(value, { start, reduce, ms: 1100 });
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative flex h-[84px] w-[84px] shrink-0 items-center justify-center">
      <svg viewBox="0 0 72 72" className="absolute inset-0 -rotate-90">
        <circle cx="36" cy="36" r={r} fill="none" strokeWidth="6" className="stroke-accent/15" />
        <motion.circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          className="stroke-danger"
          strokeDasharray={c}
          initial={{ strokeDashoffset: reduce ? c * (1 - value / 100) : c }}
          animate={{ strokeDashoffset: start ? c * (1 - value / 100) : c }}
          transition={{ duration: reduce ? 0 : 1.1, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </svg>
      <span className="text-center leading-none">
        <span className="block text-xl font-bold text-fg tabular-nums">{n}</span>
        <span className="text-[10px] font-semibold tracking-wide text-danger-fg uppercase">hot</span>
      </span>
    </span>
  );
}

function LeadScene({ reduce }: { reduce: boolean }) {
  const lines: [string, number][] = [
    ["8 pages × ₹6,500", 52000],
    ["Lead form + CRM sync", 8000],
    ["WhatsApp chat button", 4500],
  ];
  const total = lines.reduce((s, [, v]) => s + v, 0);
  const scoring = useAfter(900, reduce);
  const totalling = useAfter(3300, reduce);
  const sum = useCount(total, { start: totalling, reduce, ms: 900 });
  return (
    <div className="flex h-full flex-col gap-3">
      <motion.div {...pop} transition={{ ...spring, delay: d(reduce, 0.1) }} className="flex items-start gap-3 rounded-xl border border-border bg-surface-strong px-3 py-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
          <MessageCircle className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[11.5px] text-subtle">Kavya Textiles · Website form</span>
          <span className="block text-[13px] leading-snug text-fg">New website, about 8 pages, with an enquiry form and WhatsApp button. Want to launch before Diwali.</span>
        </span>
      </motion.div>

      <div className="flex items-center gap-3">
        <ScoreRing value={86} start={scoring} reduce={reduce} />
        <div className="min-w-0 flex-1 space-y-1">
          {lines.map(([label, v], k) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: d(reduce, 1.7 + k * 0.4) }}
              className="flex items-baseline justify-between gap-2 border-b border-dashed border-border pb-1 text-[12px]"
            >
              <span className="truncate text-muted">{label}</span>
              <span className="font-medium text-fg tabular-nums">{inr(v)}</span>
            </motion.div>
          ))}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: totalling ? 1 : 0 }}
            className="flex items-baseline justify-between gap-2 pt-0.5 text-[13px]"
          >
            <span className="font-semibold text-fg">Proposal total</span>
            <span className="font-bold text-fg tabular-nums">
              {inr(sum)} <span className="text-[10.5px] font-normal text-subtle">+ GST</span>
            </span>
          </motion.div>
        </div>
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: scoring ? 1 : 0 }}
        transition={{ delay: d(reduce, 0.5) }}
        className="text-[11.5px] text-subtle"
      >
        Budget fits, clear scope, wants to start this month · every price from your rate card
      </motion.p>

      <div className="mt-auto flex flex-wrap gap-2">
        {(
          [
            [FileCheck2, "Proposal cites 2 past projects"],
            [CalendarCheck, "Call invite · Tue 4 pm"],
          ] as [LucideIcon, string][]
        ).map(([Icon, t], k) => (
          <motion.span
            key={t}
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ ...spring, delay: d(reduce, 4.4 + k * 0.25) }}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-strong px-2.5 py-1 text-[11.5px] text-muted"
          >
            <Icon className="h-3.5 w-3.5 text-accent" /> {t}
          </motion.span>
        ))}
      </div>
    </div>
  );
}

function LoanScene({ reduce }: { reduce: boolean }) {
  const docs: { name: string; ok: boolean; note: string }[] = [
    { name: "PAN card", ok: true, note: "Name matches" },
    { name: "Aadhaar", ok: true, note: "Address matches" },
    { name: "Salary slips · 3 months", ok: true, note: "₹68,400 net" },
    { name: "Bank statement · 6 months", ok: false, note: "Only 4 months" },
    { name: "ITR · 2 years", ok: true, note: "Filed" },
  ];
  const follow = "Suresh ji, please share your bank statements for May and June so we can complete your file.";
  const typing = useAfter(4300, reduce);
  const { shown, done } = useTyped(follow, { start: typing, reduce, cps: 44 });
  return (
    <div className="flex h-full flex-col gap-2">
      <motion.div {...pop} transition={{ ...spring, delay: d(reduce, 0.1) }} className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold text-fg">Home loan · Suresh Yadav</span>
          <span className="block text-[11px] text-subtle">Checked against your checklist</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-strong px-2 py-0.5 text-[10.5px] font-medium text-muted ring-1 ring-border">
          <Lock className="h-3 w-3 text-success" /> Private model · Mumbai
        </span>
      </motion.div>
      <div className="relative space-y-1.5">
        {docs.map((doc, k) => (
          <motion.div
            key={doc.name}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...spring, delay: d(reduce, 0.3 + k * 0.12) }}
            className={cn(
              "flex items-center gap-2.5 rounded-lg border px-3 py-1.5 transition-colors duration-500",
              "border-border bg-surface-strong",
            )}
          >
            <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-subtle" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{doc.name}</span>
            <Resolving delay={d(reduce, 0.9 + k * 0.55)} reduce={reduce} word="checking" className="min-w-[6.5rem]">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium whitespace-nowrap",
                  doc.ok ? "bg-success-soft text-success-fg" : "bg-warning-soft text-warning-fg",
                )}
              >
                {doc.ok ? <Check className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />} {doc.note}
              </span>
            </Resolving>
          </motion.div>
        ))}
      </div>
      <motion.div
        {...pop}
        transition={{ ...spring, delay: d(reduce, 4.1) }}
        className="mt-auto rounded-2xl rounded-tr-sm bg-accent px-3 py-2 text-[12.5px] leading-relaxed text-accent-fg shadow-card"
      >
        <Label icon={PenLine}>Follow-up for what&apos;s missing · waiting for you</Label>
        {shown}
        <Caret on={typing && !done} />
      </motion.div>
    </div>
  );
}

function Bar({ label, value, max, k, reduce }: { label: string; value: number; max: number; k: number; reduce: boolean }) {
  const delay = d(reduce, 0.5 + k * 0.18);
  const start = useAfter(delay * 1000, reduce);
  const n = useCount(value, { start, reduce, ms: 800 });
  return (
    <div className="grid grid-cols-[7.5rem_1fr_2rem] items-center gap-2 text-[12px] sm:grid-cols-[9rem_1fr_2rem]">
      <span className="truncate text-muted">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-accent/10">
        <motion.span
          className="block h-full rounded-full bg-accent"
          initial={{ width: reduce ? `${(value / max) * 100}%` : "0%" }}
          animate={{ width: `${(value / max) * 100}%` }}
          transition={{ delay, duration: reduce ? 0 : 0.8, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </span>
      <span className="text-right font-semibold text-fg tabular-nums">{n}</span>
    </div>
  );
}

function KitchenScene({ reduce }: { reduce: boolean }) {
  const dishes: [string, number][] = [
    ["Paneer butter masala", 42],
    ["Dal makhani", 36],
    ["Veg biryani", 28],
    ["Chole bhature", 22],
  ];
  const ingredients = ["Paneer 8.4 kg", "Basmati 5.6 kg", "Urad dal 3.6 kg", "Cream 2 L"];
  const pos: [string, string][] = [
    ["Fresh Dairy", "Paneer 9 kg · Cream 2 L"],
    ["Sharma Traders", "Basmati 6 kg · Urad dal 4 kg"],
  ];
  return (
    <div className="flex h-full flex-col gap-3">
      <motion.div {...pop} transition={{ ...spring, delay: d(reduce, 0.1) }} className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-fg">Tomorrow · plates per dish</span>
          <span className="block truncate text-[11px] text-subtle">From your Swiggy and Zomato reports</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-strong px-2 py-0.5 text-[10.5px] font-medium text-muted ring-1 ring-border">
          <ChefHat className="h-3 w-3 text-accent" /> 11:40 pm
        </span>
      </motion.div>
      <div className="space-y-2">
        {dishes.map(([label, v], k) => (
          <Bar key={label} label={label} value={v} max={dishes[0]![1]} k={k} reduce={reduce} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ingredients.map((t, k) => (
          <motion.span
            key={t}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ ...spring, delay: d(reduce, 2.2 + k * 0.15) }}
            className="rounded-md border border-border bg-surface-strong px-2 py-0.5 text-[11.5px] text-fg"
          >
            {t}
          </motion.span>
        ))}
      </div>
      <div className="mt-auto space-y-1.5">
        {pos.map(([vendor, what], k) => (
          <motion.div
            key={vendor}
            {...pop}
            transition={{ ...spring, delay: d(reduce, 3.4 + k * 0.45) }}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-strong px-3 py-2"
          >
            <ShoppingCart className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium text-fg">PO · {vendor}</span>
              <span className="block truncate text-[11px] text-subtle">{what}</span>
            </span>
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[10.5px] font-semibold whitespace-nowrap text-warning-fg uppercase">
              Draft
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
