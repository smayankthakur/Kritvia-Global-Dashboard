"use client";

import { motion, useReducedMotion } from "motion/react";
import {
  BookOpen,
  CalendarDays,
  CreditCard,
  FileSpreadsheet,
  FolderOpen,
  Globe,
  Hash,
  Mail,
  MessageCircle,
  Plug,
  Send,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/** Fades and lifts its children into place the first time they scroll into view. */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      data-reveal
      className={className}
      initial={reduce ? false : { opacity: 0, y: 18, filter: "blur(4px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ duration: 0.55, delay, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Children appear one after another as the group scrolls into view. */
export function RevealGroup({
  children,
  className,
  as = "div",
}: {
  children: ReactNode[];
  className?: string;
  as?: "div" | "ol" | "ul";
}) {
  const reduce = useReducedMotion();
  const Tag = as === "ol" ? motion.ol : as === "ul" ? motion.ul : motion.div;
  const Item = as === "div" ? motion.div : motion.li;
  return (
    <Tag
      data-reveal
      className={className}
      initial={reduce ? false : "hidden"}
      whileInView="show"
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
      variants={{ show: { transition: { staggerChildren: 0.08 } } }}
    >
      {children.map((c, i) => (
        <Item
          key={i}
          data-reveal
          variants={{
            hidden: { opacity: 0, y: 16, scale: 0.98 },
            show: {
              opacity: 1,
              y: 0,
              scale: 1,
              transition: { duration: 0.5, ease: [0.2, 0.8, 0.2, 1] },
            },
          }}
          className="h-full"
        >
          {c}
        </Item>
      ))}
    </Tag>
  );
}

/** Without JavaScript nothing would ever scroll "into view": show everything as it is. */
export function RevealFallback() {
  return (
    <noscript>
      <style>
        {
          "[data-reveal]{opacity:1!important;transform:none!important;filter:none!important}"
        }
      </style>
    </noscript>
  );
}

/** Only what Kritvia connects to today. Plain names (no third-party logos). */
const CONNECTS: [LucideIcon, string][] = [
  [Mail, "Gmail"],
  [CalendarDays, "Google Calendar"],
  [FolderOpen, "Google Drive"],
  [MessageCircle, "WhatsApp Business"],
  [Send, "Telegram"],
  [Hash, "Slack"],
  [Globe, "Your website's forms"],
  [FileSpreadsheet, "Tally exports"],
  [CreditCard, "Razorpay & UPI"],
  [Star, "Google reviews"],
  [BookOpen, "Your documents"],
  [Plug, "Any MCP server"],
];

/** An endless, slow strip of what Kritvia connects to; pauses on hover; static with reduced motion. */
export function ConnectsMarquee({ className }: { className?: string }) {
  const row = (hidden: boolean) => (
    <ul
      className="flex shrink-0 items-center gap-3 pr-3"
      aria-hidden={hidden || undefined}
    >
      {CONNECTS.map(([Icon, name]) => (
        <li
          key={name}
          className="glass flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] text-muted"
        >
          <Icon className="h-3.5 w-3.5 text-accent" aria-hidden />
          {name}
        </li>
      ))}
    </ul>
  );
  return (
    <div
      className={cn(
        "group relative flex overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]",
        className,
      )}
    >
      <div className="kv-marquee flex group-hover:[animation-play-state:paused]">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
