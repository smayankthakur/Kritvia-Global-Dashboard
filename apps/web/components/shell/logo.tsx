import { cn } from "@/components/ui/cn";

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "Kritvia";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("h-7 w-7 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M10 8v16M10 16l9-8M13.5 13l6.5 11"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <div className="leading-tight">
        <div className="text-[15px] font-semibold tracking-tight text-fg">{APP_NAME}</div>
        <div className="text-[11px] text-subtle">AI Business OS</div>
      </div>
    </div>
  );
}
