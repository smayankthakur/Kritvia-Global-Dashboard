import { Check, Inbox, PenLine, Sparkles, X } from "lucide-react";
import { cn } from "@/components/ui/cn";

/**
 * A static picture of an approval card, as the inbox shows one. Illustrative content (marked
 * "Example"), hidden from screen readers; the surrounding copy says what it shows.
 */
export function ApprovalPreview({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("relative select-none", className)}>
      <div className="absolute -inset-x-6 -top-6 -bottom-8 -z-10 rounded-[2rem] bg-[radial-gradient(closest-side,var(--accent-soft),transparent)] blur-2xl" />
      <div className="kv-stagger space-y-3">
        <div className="flex items-center justify-between glass rounded-2xl border px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Inbox className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <p className="text-[13px] font-semibold text-fg">Approval inbox</p>
              <p className="text-[11.5px] text-subtle">3 drafts waiting · Example</p>
            </div>
          </div>
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-fg">Needs you</span>
        </div>

        <div className="glass-strong rounded-2xl border">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[13px] font-semibold text-fg">Proposal: website redesign</p>
              <p className="truncate text-[11.5px] text-subtle">Lead triage · enquiry from your site form</p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger-fg">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              hot
            </span>
          </div>
          <div className="space-y-2.5 px-4 py-3 text-[12.5px] leading-relaxed text-muted">
            <p>
              Namaste Arjun ji, thanks for the brief. For a 12-page site with a lead form we quote{" "}
              <span className="font-semibold text-fg">₹1,15,000</span>, delivered in four weeks…
            </p>
            <p className="flex items-center gap-1.5 text-[11.5px] text-subtle">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              Priced from your rate card · cites 2 past projects
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2 px-4 py-2.5">
            <span className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted">
              <X className="h-3.5 w-3.5" /> Reject
            </span>
            <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-strong px-2.5 text-[12px] font-medium text-fg">
              <PenLine className="h-3.5 w-3.5" /> Edit
            </span>
            <span className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg shadow-card">
              <Check className="h-3.5 w-3.5" /> Approve &amp; send
            </span>
          </div>
        </div>

        <div className="glass ml-8 flex items-center gap-2.5 rounded-2xl border px-4 py-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success-soft text-success">
            <Check className="h-3.5 w-3.5" />
          </span>
          <p className="text-[12px] text-muted">
            <span className="font-medium text-fg">Reply to Swiggy vendor</span> approved without edits
          </p>
        </div>
      </div>
    </div>
  );
}
