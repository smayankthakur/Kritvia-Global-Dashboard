"use client";

import { FileUp, X } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";
import { formatBytes } from "@/lib/format";
import { cn } from "./cn";

/** Drag-and-drop or click-to-browse file picker (keyboard accessible via the hidden input). */
export function FileDrop({
  files,
  onChange,
  multiple,
  accept,
  maxFiles,
  label = "Choose files",
  hint,
  className,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  multiple?: boolean;
  accept?: string;
  maxFiles?: number;
  label?: string;
  hint?: string;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const add = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    const next = multiple ? [...files, ...incoming] : incoming.slice(0, 1);
    onChange(maxFiles ? next.slice(0, maxFiles) : next);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) add(e.dataTransfer.files);
  };

  return (
    <div className={className}>
      {/* Drag-and-drop is a mouse extra: the label opens the file input, which works from the keyboard. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <label
        htmlFor={`fd-${id}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
          over ? "border-accent bg-accent-soft/50" : "border-border hover:border-border-strong hover:bg-surface-2/60",
          disabled && "pointer-events-none opacity-60",
        )}
      >
        <FileUp className="h-5 w-5 text-subtle" aria-hidden />
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-subtle">{hint ?? "Drag and drop, or click to browse"}</span>
        <input
          ref={input}
          id={`fd-${id}`}
          type="file"
          className="sr-only"
          multiple={multiple}
          accept={accept}
          disabled={disabled}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
      </label>
      {files.length ? (
        <ul className="mt-2 space-y-1" aria-label="Selected files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-subtle">{formatBytes(f.size)}</span>
              <button
                type="button"
                className="rounded p-0.5 text-subtle hover:text-fg"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
