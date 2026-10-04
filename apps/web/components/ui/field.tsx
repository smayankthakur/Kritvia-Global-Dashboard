"use client";

import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "./cn";

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
}
const FieldContext = createContext<FieldCtx | null>(null);

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
  /** Visually hide the label (still read by screen readers). */
  srLabel?: boolean;
  id?: string;
}

export function Field({ label, hint, error, required, className, children, srLabel, id: idProp }: FieldProps) {
  const auto = useId();
  const id = idProp ?? `f${auto.replace(/:/g, "")}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
        <div className={cn("flex items-baseline", srLabel && "sr-only")}>
          <label htmlFor={id} className="text-[13px] font-medium text-fg">
            {label}
          </label>
          {required ? (
            <span className="ml-0.5 text-[13px] text-danger" aria-hidden>
              *
            </span>
          ) : null}
        </div>
        {children}
        {hint && !error ? (
          <p id={hintId} className="text-xs text-subtle">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errId} className="text-xs font-medium text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

function useFieldProps(props: { id?: string; "aria-describedby"?: string; required?: boolean }) {
  const ctx = useContext(FieldContext);
  return {
    id: props.id ?? ctx?.id,
    "aria-describedby": props["aria-describedby"] ?? ctx?.describedBy,
    "aria-invalid": ctx?.invalid || undefined,
    required: props.required ?? ctx?.required,
  };
}

export const controlClass =
  "w-full rounded-lg border border-border bg-surface-strong px-3 text-sm text-fg shadow-card placeholder:text-subtle " +
  "transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring/30 " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  const f = useFieldProps(props);
  return <input ref={ref} className={cn(controlClass, "h-9", className)} {...props} {...f} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 4, ...props },
  ref,
) {
  const f = useFieldProps(props);
  return <textarea ref={ref} rows={rows} className={cn(controlClass, "py-2 leading-relaxed", className)} {...props} {...f} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  const f = useFieldProps(props);
  return (
    <select
      ref={ref}
      className={cn(
        controlClass,
        "kv-select h-9 appearance-none pr-8",
        className,
      )}
      {...props}
      {...f}
    >
      {children}
    </select>
  );
});

export function Checkbox({
  label,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; hint?: ReactNode }) {
  const auto = useId();
  const id = props.id ?? `c${auto.replace(/:/g, "")}`;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong accent-[var(--accent)]"
        {...props}
      />
      <label htmlFor={id} className="text-sm leading-5">
        <span className="font-medium text-fg">{label}</span>
        {hint ? <span className="block text-xs text-subtle">{hint}</span> : null}
      </label>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-3",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform duration-200 ease-out",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="animate-fade-in rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger-fg">
      {message}
    </div>
  );
}
