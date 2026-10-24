"use client";

import { Button } from "./button";
import { cn } from "./cn";

/** "Unsaved changes — Save / Discard", shown while a form has edits that aren't saved yet (round 3, A2). */
export function UnsavedBar({
  onSave,
  onDiscard,
  saving,
  saveDisabled,
  className,
  sticky = false,
}: {
  onSave: () => void;
  onDiscard: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
  className?: string;
  /** Keep it in view at the bottom of the screen while the page scrolls. */
  sticky?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-fg",
        sticky && "sticky bottom-3 z-20 shadow-md",
        className,
      )}
    >
      <span className="font-medium">Unsaved changes</span>
      <span className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} loading={saving} disabled={saveDisabled}>
          Save
        </Button>
      </span>
    </div>
  );
}
