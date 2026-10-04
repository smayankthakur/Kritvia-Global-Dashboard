"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./cn";
import { Input } from "./field";

/**
 * Modal dialog built on the native <dialog> element: showModal() gives a focus trap,
 * Escape to close and an inert background for free. Focus returns to the opener.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  variant = "center",
  className,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  variant?: "center" | "sheet-right" | "sheet-left";
  className?: string;
  /** false: no close button, and Escape or a click outside does nothing (a required step). */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const uid = useId().replace(/:/g, "");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };
  const layout =
    variant === "center"
      ? cn("m-auto w-[calc(100vw-2rem)] rounded-2xl max-h-[calc(100dvh-2rem)]", widths[size])
      : cn(
          "my-0 h-dvh max-h-dvh w-full rounded-none",
          variant === "sheet-right" ? "mr-0 ml-auto" : "ml-0 mr-auto",
          variant === "sheet-left" ? "max-w-[18rem]" : widths[size === "md" ? "lg" : size],
        );

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${uid}-title`}
      aria-describedby={description ? `${uid}-desc` : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={cn(
        "glass-strong border p-0 text-fg open:flex open:flex-col",
        variant === "center" ? "open:animate-scale-in" : variant === "sheet-right" ? "open:animate-slide-in-right" : "open:animate-slide-in-left",
        layout,
        className,
      )}
    >
      {open ? (
        <>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h2 id={`${uid}-title`} className="text-base font-semibold">
                {title}
              </h2>
              {description ? (
                <p id={`${uid}-desc`} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              ) : null}
            </div>
            {dismissible ? (
              <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose} className="-mt-1 -mr-2 h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3">
              {footer}
            </div>
          ) : null}
        </>
      ) : null}
    </dialog>
  );
}

export function Sheet(props: Omit<Parameters<typeof Dialog>[0], "variant"> & { side?: "left" | "right" }) {
  const { side = "right", ...rest } = props;
  return <Dialog {...rest} variant={side === "left" ? "sheet-left" : "sheet-right"} />;
}

/** Confirmation for destructive actions; optionally requires typing a phrase. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  typeToConfirm,
  loading,
  danger = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  typeToConfirm?: string;
  loading?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const ok = !typeToConfirm || typed.trim() === typeToConfirm;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={!ok} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {typeToConfirm ? (
        <div className="mt-2 space-y-1.5">
          <label className="text-sm text-muted" htmlFor="confirm-phrase">
            Type <span className="font-mono font-semibold text-fg">{typeToConfirm}</span> to confirm
          </label>
          <Input id="confirm-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
      ) : null}
    </Dialog>
  );
}
