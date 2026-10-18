"use client";

import { AnimatePresence, motion } from "motion/react";
import { Clock3, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "./cn";
import { controlClass, useFieldProps } from "./field";

/** "09:05" → [9, 5]; anything else → null. */
export function parseTime(
  v: string | null | undefined,
): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? [h, mi] : null;
}

export const pad = (n: number) => String(n).padStart(2, "0");

/** 13:05 → "1:05 pm"; 00:00 → "12:00 am". */
export function twelveHour(h: number, m: number): string {
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "am" : "pm"}`;
}

/** The minutes offered: every `step` minutes, plus the current one if it falls between. */
export function minuteOptions(step: number, current?: number | null): number[] {
  const s = Math.min(Math.max(Math.round(step), 1), 30);
  const out: number[] = [];
  for (let m = 0; m < 60; m += s) out.push(m);
  if (current !== undefined && current !== null && !out.includes(current))
    out.push(current);
  return out.sort((a, b) => a - b);
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DEFAULT_PRESETS = ["09:00", "10:00", "13:00", "18:00"];

type Col = "h" | "m";

/**
 * A time picker that matches the app instead of the browser's own popup: a field showing the time
 * (and the 12-hour reading), and an animated panel with quick picks and two scrolling columns.
 * Keyboard: Enter/Space/↓ opens; ↑↓ change the hour or minute, ←→ switch column, Home/End,
 * Enter or Esc closes. The value is "HH:MM" (24-hour), like <input type="time">.
 */
export function TimeField({
  value,
  onChange,
  disabled,
  step = 5,
  presets = DEFAULT_PRESETS,
  clearable = false,
  placeholder = "Pick a time",
  className,
  id: idProp,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Minutes between choices in the minute column (default 5). */
  step?: number;
  presets?: string[];
  clearable?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  required?: boolean;
}) {
  const f = useFieldProps({
    id: idProp,
    "aria-describedby": describedBy,
    required,
  });
  const uid = useId().replace(/:/g, "");
  const parsed = parseTime(value);
  const [open, setOpen] = useState(false);
  const [col, setCol] = useState<Col>("h");
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const h = parsed?.[0] ?? null;
  const m = parsed?.[1] ?? null;
  const minutes = useMemo(() => minuteOptions(step, m), [step, m]);

  const set = useCallback(
    (hh: number, mm: number) => {
      onChange(`${pad(hh)}:${pad(mm)}`);
    },
    [onChange],
  );

  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  }, []);

  // Open above the field when there's no room below.
  useLayoutEffect(() => {
    if (!open || !wrap.current) return;
    const r = wrap.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setUp(below < 340 && r.top > below);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node))
        close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  const openPanel = () => {
    if (disabled) return;
    setCol("h");
    setOpen(true);
  };

  const move = (c: Col, delta: number | "first" | "last") => {
    const hh = h ?? 9;
    const mm = m ?? 0;
    if (c === "h") {
      const n =
        delta === "first" ? 0 : delta === "last" ? 23 : (hh + delta + 24) % 24;
      set(n, mm);
    } else {
      const i = Math.max(0, minutes.indexOf(mm));
      const n =
        delta === "first"
          ? 0
          : delta === "last"
            ? minutes.length - 1
            : (i + delta + minutes.length) % minutes.length;
      set(hh, minutes[n]!);
    }
  };

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => void> = {
      ArrowUp: () => move(col, -1),
      ArrowDown: () => move(col, 1),
      PageUp: () => move(col, col === "h" ? -6 : -3),
      PageDown: () => move(col, col === "h" ? 6 : 3),
      Home: () => move(col, "first"),
      End: () => move(col, "last"),
      ArrowLeft: () => setCol("h"),
      ArrowRight: () => setCol("m"),
      Enter: () => close(),
      Escape: () => close(),
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  };

  useEffect(() => {
    if (open)
      panel.current?.querySelector<HTMLElement>(`[data-col="${col}"]`)?.focus();
  }, [col, open]);

  return (
    <div ref={wrap} className={cn("relative", className)}>
      <button
        ref={trigger}
        type="button"
        id={f.id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-describedby={f["aria-describedby"]}
        data-invalid={f["aria-invalid"] ? "true" : undefined}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openPanel();
          }
        }}
        className={cn(
          controlClass,
          "group flex h-9 items-center justify-between gap-2 text-left",
          open && "border-accent ring-2 ring-ring/30",
          "data-[invalid=true]:border-danger",
        )}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          {parsed ? (
            <>
              <span className="font-medium text-fg tabular-nums">
                {pad(parsed[0])}:{pad(parsed[1])}
              </span>
              <span className="truncate text-xs text-subtle">
                {twelveHour(parsed[0], parsed[1])}
              </span>
            </>
          ) : (
            <span className="text-subtle">{placeholder}</span>
          )}
        </span>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 26 }}
          className="shrink-0 text-subtle transition-colors group-hover:text-accent"
          aria-hidden
        >
          <Clock3 className="h-4 w-4" />
        </motion.span>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            ref={panel}
            role="dialog"
            aria-label={ariaLabel ? `${ariaLabel}: pick a time` : "Pick a time"}
            onKeyDown={onPanelKey}
            initial={{ opacity: 0, y: up ? 6 : -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{
              opacity: 0,
              y: up ? 4 : -4,
              scale: 0.97,
              transition: { duration: 0.12 },
            }}
            transition={{
              type: "spring",
              stiffness: 420,
              damping: 32,
              mass: 0.7,
            }}
            style={{ transformOrigin: up ? "bottom left" : "top left" }}
            className={cn(
              "absolute left-0 z-50 w-[15.5rem] overflow-hidden rounded-xl border border-border bg-[var(--surface-solid)] shadow-[var(--shadow-pop)]",
              up ? "bottom-full mb-2" : "top-full mt-2",
            )}
          >
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span
                className="text-[13px] font-semibold text-fg tabular-nums"
                aria-live="polite"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={value || "none"}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.16 }}
                    className="inline-block"
                  >
                    {parsed ? twelveHour(parsed[0], parsed[1]) : "No time"}
                  </motion.span>
                </AnimatePresence>
              </span>
              {clearable && parsed ? (
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    close();
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-subtle hover:bg-surface-2 hover:text-fg"
                >
                  <X className="h-3 w-3" aria-hidden /> Clear
                </button>
              ) : null}
            </div>
            {presets.length ? (
              <div
                className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2"
                role="group"
                aria-label="Quick picks"
              >
                {presets.map((p) => {
                  const pp = parseTime(p);
                  if (!pp) return null;
                  const on = value === p;
                  return (
                    <motion.button
                      key={p}
                      type="button"
                      whileTap={{ scale: 0.92 }}
                      onClick={() => {
                        set(pp[0], pp[1]);
                        close();
                      }}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs tabular-nums transition-colors",
                        on
                          ? "border-accent bg-accent-soft text-accent-soft-fg"
                          : "border-border text-muted hover:border-accent/50 hover:text-fg",
                      )}
                    >
                      {twelveHour(pp[0], pp[1]).replace(":00", "")}
                    </motion.button>
                  );
                })}
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-1 p-1.5">
              <Column
                uid={uid}
                id="h"
                label="Hour"
                items={HOURS}
                value={h}
                focused={col === "h"}
                onFocus={() => setCol("h")}
                onPick={(n) => set(n, m ?? 0)}
              />
              <Column
                uid={uid}
                id="m"
                label="Minute"
                items={minutes}
                value={m}
                focused={col === "m"}
                onFocus={() => setCol("m")}
                onPick={(n) => {
                  set(h ?? 9, n);
                  close();
                }}
              />
            </div>
            <p className="border-t border-border px-3 py-1.5 text-[11px] text-subtle">
              ↑↓ change · ←→ switch · Enter done
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Column({
  uid,
  id,
  label,
  items,
  value,
  focused,
  onFocus,
  onPick,
}: {
  uid: string;
  id: Col;
  label: string;
  items: number[];
  value: number | null;
  focused: boolean;
  onFocus: () => void;
  onPick: (n: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  // Keep the chosen item in the middle of the column (instantly on open, smoothly after).
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-v="${value}"]`);
    if (el && list.current) {
      const top =
        el.offsetTop - list.current.clientHeight / 2 + el.clientHeight / 2;
      list.current.scrollTo?.({
        top,
        behavior: first.current ? "auto" : "smooth",
      });
    }
    first.current = false;
  }, [value]);
  const active = value !== null ? `${uid}-${id}-${value}` : undefined;
  return (
    <div className="min-w-0">
      <p className="px-2 pt-1 pb-1 text-[10.5px] font-semibold tracking-wide text-subtle uppercase">
        {label}
      </p>
      <div
        ref={list}
        data-col={id}
        role="listbox"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={active}
        onFocus={onFocus}
        className={cn(
          "relative h-48 overflow-y-auto overscroll-contain rounded-lg [scrollbar-width:thin] outline-none",
          focused && "ring-2 ring-ring/25",
        )}
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent)",
        }}
      >
        <div className="py-[4.5rem]">
          {items.map((n) => {
            const on = n === value;
            return (
              <div
                key={n}
                id={`${uid}-${id}-${n}`}
                data-v={n}
                role="option"
                tabIndex={-1}
                aria-selected={on}
                onClick={() => onPick(n)}
                onKeyDown={(e) => {
                  if (e.key === " ") {
                    e.preventDefault();
                    onPick(n);
                  }
                }}
                className={cn(
                  "relative mx-1 flex h-8 cursor-pointer items-center justify-center rounded-md text-sm tabular-nums select-none",
                  "transition-colors duration-100",
                  on
                    ? "font-semibold text-accent-fg"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {on ? (
                  <motion.span
                    layoutId={`${uid}-${id}-pill`}
                    className="absolute inset-0 rounded-md bg-accent shadow-card"
                    transition={{ type: "spring", stiffness: 500, damping: 36 }}
                  />
                ) : null}
                <span className="relative">{pad(n)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
