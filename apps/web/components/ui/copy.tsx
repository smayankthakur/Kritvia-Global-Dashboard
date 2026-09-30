"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";
import { cn } from "./cn";

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = value;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1800);
      }}
      icon={done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    >
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </Button>
  );
}

export function CopyField({ value, label, secret, className }: { value: string; label: string; secret?: boolean; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <p className="text-[13px] font-medium">{label}</p>
      <div className="flex items-stretch gap-2">
        <code
          className={cn(
            "min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs break-all",
            secret && "text-warning-fg",
          )}
        >
          {value}
        </code>
        <CopyButton value={value} label="Copy" className="h-auto" />
      </div>
    </div>
  );
}
