import type { ReactNode } from "react";
import { cn } from "./cn";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-xs font-semibold tracking-wide text-accent uppercase">{eyebrow}</div> : null}
        <h1 className="text-[22px] leading-tight font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Notice({
  tone = "info",
  children,
  className,
  title,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  children: ReactNode;
  className?: string;
  title?: ReactNode;
}) {
  const tones = {
    info: "border-info/25 bg-info-soft text-info-fg",
    warning: "border-warning/30 bg-warning-soft text-warning-fg",
    danger: "border-danger/30 bg-danger-soft text-danger-fg",
    success: "border-success/30 bg-success-soft text-success-fg",
  };
  return (
    <div className={cn("animate-fade-in rounded-lg border px-3 py-2.5 text-sm", tones[tone], className)} role={tone === "danger" ? "alert" : undefined}>
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? "mt-0.5 opacity-90" : undefined}>{children}</div>
    </div>
  );
}

export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-subtle">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
