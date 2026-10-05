import type { ReactNode } from "react";
import { cn } from "./cn";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  accent: "bg-accent-soft text-accent-soft-fg border-transparent",
  success: "bg-success-soft text-success-fg border-transparent",
  warning: "bg-warning-soft text-warning-fg border-transparent",
  danger: "bg-danger-soft text-danger-fg border-transparent",
  info: "bg-info-soft text-info-fg border-transparent",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  dot,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11.5px] font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  // runs
  queued: "neutral",
  running: "info",
  waiting: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  // approvals
  pending: "warning",
  approved: "success",
  edited: "info",
  rejected: "danger",
  expired: "neutral",
  executed: "success",
  auto_executed: "success",
  // leads / proposals
  new: "accent",
  contacted: "neutral",
  replied: "success",
  qualified: "info",
  proposal: "warning",
  won: "success",
  lost: "neutral",
  archived: "neutral",
  draft: "neutral",
  sent: "info",
  accepted: "success",
  superseded: "neutral",
  hot: "danger",
  warm: "warning",
  cold: "info",
  // documents / loans / compliance
  ready: "success",
  processing: "info",
  error: "danger",
  complete: "success",
  incomplete: "warning",
  verifying: "info",
  in_progress: "info",
  open: "warning",
  contained: "info",
  closed: "success",
  done: "success",
  dropped: "neutral",
  active: "success",
  withdrawn: "neutral",
  classified: "info",
  collecting: "info",
  needs_info: "warning",
  submitted: "accent",
  received: "neutral",
  pending_review: "warning",
  extracted: "info",
  verified: "success",
  low: "neutral",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return "neutral";
  return STATUS_TONES[status] ?? "neutral";
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return <span className="text-subtle">—</span>;
  return (
    <Badge tone={statusTone(status)} dot className={className}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
