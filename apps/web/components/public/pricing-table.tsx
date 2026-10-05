"use client";

import { Building2, Check, Clock, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { ENTERPRISE, priceFor, rupees, tokensLabel, type Period, type PlanCard } from "@/lib/pricing";

/** Marks a feature that is announced but not available yet; never counted as included. */
function SoonBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted uppercase">
      Coming soon <span className="sr-only">(not available yet, and not part of what you pay for until released)</span>
    </span>
  );
}

/** Monthly / yearly switch. Yearly is two months free. */
export function PeriodToggle({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div role="radiogroup" aria-label="Billing period" className="glass inline-flex items-center gap-1 rounded-full border p-1 text-sm">
      {(["monthly", "annual"] as const).map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          onClick={() => onChange(p)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-4 font-medium transition-[background-color,color,box-shadow] duration-200",
            value === p ? "bg-accent text-accent-fg shadow-card" : "text-muted hover:text-fg",
          )}
        >
          {p === "monthly" ? "Pay monthly" : "Pay yearly"}
          {p === "annual" ? (
            <span className={cn("rounded-full px-1.5 text-[11px] font-semibold", value === p ? "bg-white/25" : "bg-success-soft text-success-fg")}>
              2 months free
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * The four plans side by side (Growth highlighted), each leading with what it does for the
 * business; AI tokens are listed last, as "included". Enterprise sits underneath.
 */
export function PricingTable({
  plans,
  current,
  action,
  initialPeriod = "monthly",
  enterpriseAction,
}: {
  plans: PlanCard[];
  current?: string;
  action: (plan: PlanCard, period: Period) => ReactNode;
  initialPeriod?: Period;
  enterpriseAction?: ReactNode;
}) {
  const [period, setPeriod] = useState<Period>(initialPeriod);
  return (
    <div>
      <div className="flex justify-center">
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>
      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((p) => {
          const price = priceFor(p, period);
          const isCurrent = current === p.code;
          return (
            <div
              key={p.code}
              className={cn(
                "kv-lift glass glass-sheen relative flex flex-col rounded-2xl border p-6",
                p.featured && "border-accent ring-1 ring-accent",
                isCurrent && !p.featured && "ring-2 ring-accent/60",
              )}
            >
              {p.featured ? (
                <span className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-[linear-gradient(180deg,var(--accent),var(--accent-2))] px-2.5 py-0.5 text-xs font-semibold text-accent-fg shadow-card">
                  <Sparkles className="h-3 w-3" aria-hidden /> Recommended
                </span>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-semibold text-fg">{p.name}</h3>
                {isCurrent ? <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-soft-fg">Current</span> : null}
              </div>
              <p className="mt-1 text-sm text-muted">{p.tagline}</p>
              <p className="mt-4 text-3xl font-bold tracking-tight text-fg tabular-nums">
                {price.big}
                {p.price_inr ? <span className="ml-1 text-sm font-normal text-subtle">/month</span> : null}
              </p>
              <p className="mt-0.5 text-xs text-subtle">{price.note}</p>
              <ul className="mt-5 flex-1 space-y-2.5 text-sm text-muted">
                {p.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                    {h}
                  </li>
                ))}
                {p.coming_soon?.length ? (
                  <li className="border-t border-border pt-2.5">
                    <SoonBadge />
                    <ul className="mt-2 space-y-1.5" aria-label={`Coming soon to ${p.name}`}>
                      {p.coming_soon.map((h) => (
                        <li key={h} className="flex gap-2 text-subtle">
                          <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                          {h}
                        </li>
                      ))}
                    </ul>
                  </li>
                ) : null}
                <li className="flex gap-2 border-t border-border pt-2.5 text-subtle">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                  {tokensLabel(p.monthly_tokens)} AI tokens a month included
                </li>
              </ul>
              <div className="mt-6">{action(p, period)}</div>
            </div>
          );
        })}
      </div>
      <div className="glass glass-sheen mt-4 flex flex-col gap-4 rounded-2xl border p-6 md:flex-row md:items-center md:justify-between">
        <div className="flex gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Building2 className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h3 className="text-lg font-semibold text-fg">
              {ENTERPRISE.name} <span className="ml-1 text-sm font-normal text-subtle">from {rupees(ENTERPRISE.from_inr)}/month</span>
            </h3>
            <p className="mt-0.5 text-sm text-muted">{ENTERPRISE.tagline}</p>
            <p className="mt-2 text-xs text-subtle">{ENTERPRISE.highlights.join(" · ")}</p>
            <p className="mt-1 text-xs text-subtle">
              Coming soon: {ENTERPRISE.coming_soon.join(" · ")}
            </p>
          </div>
        </div>
        <div className="shrink-0">
          {enterpriseAction ?? (
            <a href={ENTERPRISE.contact} className="inline-flex h-10 items-center rounded-md border border-border bg-surface-strong px-5 text-sm font-medium text-fg shadow-card transition-colors hover:border-border-strong">
              Talk to us
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** The pricing section on public pages: every paid plan starts with a free account. */
export function PublicPricing({ plans }: { plans: PlanCard[] }) {
  return (
    <PricingTable
      plans={plans}
      action={(p) => (
        <a
          href={`/register?plan=${p.code}`}
          className={cn(
            "inline-flex h-10 w-full items-center justify-center rounded-md text-sm font-medium transition-[filter,background-color,border-color] duration-150",
            p.featured
              ? "bg-[linear-gradient(180deg,var(--accent),var(--accent-2))] text-accent-fg shadow-card hover:brightness-110"
              : "border border-border bg-surface-strong text-fg shadow-card hover:border-border-strong",
          )}
        >
          {p.price_inr ? `Start with ${p.name}` : "Start free"}
        </a>
      )}
    />
  );
}
