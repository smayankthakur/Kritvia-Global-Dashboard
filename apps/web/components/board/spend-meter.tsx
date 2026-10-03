"use client";

import { motion, useReducedMotion } from "motion/react";
import { budgetFraction, budgetTone, formatTokens, type Role } from "@/lib/board";
import { cn } from "@/components/ui/cn";

const BAR: Record<ReturnType<typeof budgetTone>, string> = {
  neutral: "bg-accent/70",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** This month's tokens against the budget: a bar that settles into place, red when used up. */
export function SpendMeter({ role, compact }: { role: Pick<Role, "monthly_tokens" | "used_tokens" | "paused">; compact?: boolean }) {
  const reduce = useReducedMotion();
  const fraction = budgetFraction(role);
  const tone = budgetTone(fraction);
  // With no budget the bar shows usage against the plan: a soft, open-ended bar.
  const width = fraction == null ? Math.min(role.used_tokens / 1_000_000, 1) * 100 : fraction * 100;
  const label =
    fraction == null
      ? `${formatTokens(role.used_tokens)} this month · no cap`
      : `${formatTokens(role.used_tokens)} of ${formatTokens(role.monthly_tokens)}`;
  return (
    <div className={cn("min-w-0", compact ? "space-y-1" : "space-y-1.5")}>
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        aria-label={label}
      >
        <motion.div
          className={cn("absolute inset-y-0 left-0 rounded-full", BAR[tone])}
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${Math.max(width, role.used_tokens > 0 ? 2 : 0)}%` }}
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 20, mass: 0.6 }}
        />
        {role.paused ? (
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-danger/30"
            animate={reduce ? undefined : { opacity: [0.2, 0.6, 0.2] }}
            transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
          />
        ) : null}
      </div>
      <div className={cn("flex items-center justify-between gap-2 text-[11.5px] tabular-nums text-subtle", compact && "text-[11px]")}>
        <span className="truncate">{label}</span>
        {fraction != null ? <span className={cn(tone === "danger" && "text-danger-fg", tone === "warning" && "text-warning-fg")}>{Math.round(fraction * 100)}%</span> : null}
      </div>
    </div>
  );
}
