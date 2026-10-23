"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * A set of cards that behaves like radio buttons for keyboard and screen-reader users: one Tab stop
 * (the chosen card, or the first), arrow keys move and choose, Home/End jump to the ends.
 */
export function ChoiceCards<T extends { id: string }>({
  label,
  options,
  value,
  onChange,
  render,
  className,
  cardClassName,
}: {
  label: string;
  options: T[];
  value: string | null | undefined;
  onChange: (option: T) => void;
  render: (option: T, checked: boolean) => ReactNode;
  className?: string;
  cardClassName?: (checked: boolean) => string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.id === value);
  const focusable = selected >= 0 ? selected : 0;

  const move = (to: number) => {
    const i = (to + options.length) % options.length;
    refs.current[i]?.focus();
    onChange(options[i]!);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(i + 1),
      ArrowDown: () => move(i + 1),
      ArrowLeft: () => move(i - 1),
      ArrowUp: () => move(i - 1),
      Home: () => move(0),
      End: () => move(options.length - 1),
    };
    const k = keys[e.key];
    if (k) {
      e.preventDefault();
      k();
    }
  };

  return (
    <div role="radiogroup" aria-label={label} className={className}>
      {options.map((o, i) => {
        const checked = i === selected;
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === focusable ? 0 : -1}
            onClick={() => onChange(o)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(cardClassName?.(checked))}
          >
            {render(o, checked)}
          </button>
        );
      })}
    </div>
  );
}
