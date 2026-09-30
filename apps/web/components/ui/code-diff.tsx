import type { DiffLine } from "@/lib/diff";
import { cn } from "./cn";

/** Line-level diff with +/- gutters. Screen readers get "added"/"removed" prefixes. */
export function CodeDiff({ lines, className, label }: { lines: DiffLine[]; className?: string; label?: string }) {
  return (
    <div
      className={cn("overflow-x-auto rounded-md border border-border font-mono text-[12.5px] leading-5", className)}
      role="group"
      aria-label={label ?? "Changes"}
    >
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "flex min-w-fit",
            l.type === "add" && "bg-diff-add",
            l.type === "del" && "bg-diff-del",
          )}
        >
          <span
            className={cn(
              "w-6 shrink-0 text-center select-none",
              l.type === "add" ? "text-success" : l.type === "del" ? "text-danger" : "text-subtle",
            )}
            aria-hidden
          >
            {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
          </span>
          <span className="sr-only">{l.type === "add" ? "added: " : l.type === "del" ? "removed: " : ""}</span>
          <span className={cn("pr-3 whitespace-pre-wrap", l.type === "del" && "line-through decoration-danger/40")}>
            {l.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Before/after for scalar values (dates, arrays, numbers). */
export function ValueDiff({ before, after }: { before: string; after: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border font-mono text-[12.5px] leading-5">
      <div className="flex bg-diff-del">
        <span className="w-6 shrink-0 text-center text-danger" aria-hidden>
          −
        </span>
        <span className="sr-only">before: </span>
        <span className="pr-3 break-all whitespace-pre-wrap">{before || "(empty)"}</span>
      </div>
      <div className="flex bg-diff-add">
        <span className="w-6 shrink-0 text-center text-success" aria-hidden>
          +
        </span>
        <span className="sr-only">after: </span>
        <span className="pr-3 break-all whitespace-pre-wrap">{after || "(empty)"}</span>
      </div>
    </div>
  );
}
