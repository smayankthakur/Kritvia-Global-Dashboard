import type { ReactNode } from "react";
import { cn } from "./cn";

export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "danger" | "warning" | "success";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs leading-snug font-medium text-subtle">{label}</dt>
      <dd
        className={cn(
          "mt-1 animate-fade-up text-xl font-semibold tabular-nums tracking-tight",
          tone === "danger" && "text-danger",
          tone === "warning" && "text-warning",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </dd>
      {hint ? <dd className="mt-0.5 truncate text-xs text-subtle">{hint}</dd> : null}
    </div>
  );
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-2 gap-4 sm:grid-cols-4", className)}>{children}</dl>;
}
