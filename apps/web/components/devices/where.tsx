"use client";

import { AlertTriangle, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Where the device asking to be signed in is, so someone else's device (a phishing page showing their own
 * QR code) can be spotted before saying yes. */
export function WhereIsIt({
  place,
  ip,
  sameNetwork,
  at,
}: {
  place?: string | null;
  ip?: string | null;
  sameNetwork?: boolean | null;
  at?: string | null;
}) {
  const when = at ? new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div className="space-y-2 text-left text-sm">
      <p className="flex items-start gap-2 text-muted">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          {place ? <>Near <strong className="text-fg">{place}</strong></> : "Place not known"}
          {ip ? <> · internet address {ip}</> : null}
          {when ? <> · code made at {when}</> : null}
        </span>
      </p>
      {sameNetwork === false ? (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span>
            That device is on a different internet connection from this one. If you are not sitting at it right now, tap <strong>Not me</strong>: a
            website may be trying to get into your account.
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** Pick the number the other device shows: three choices, a wrong one refuses the sign-in. */
export function PickNumber({
  options,
  busy,
  onPick,
  onRefuse,
  shownOn,
}: {
  options: string[];
  busy: boolean;
  onPick: (n: string) => void;
  onRefuse: () => void;
  shownOn: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        To say yes, tap the number shown on <strong>{shownOn}</strong>:
      </p>
      <div className="flex justify-center gap-2" role="group" aria-label={`The number shown on ${shownOn}`}>
        {options.map((n) => (
          <Button key={n} variant="secondary" className="h-12 w-16 text-lg font-semibold" disabled={busy} onClick={() => onPick(n)}>
            {n}
          </Button>
        ))}
      </div>
      <Button variant="ghost" className="w-full" disabled={busy} onClick={onRefuse}>
        Not me
      </Button>
    </div>
  );
}

/** The number this device shows, for the other device to pick. */
export function ShowNumber({ match, pickOn }: { match: string; pickOn: string }) {
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <p className="text-xs text-subtle">Pick this number on {pickOn}</p>
      <p className="mt-1 font-mono text-4xl font-semibold tracking-widest text-fg" aria-live="polite">
        {match}
      </p>
    </div>
  );
}
