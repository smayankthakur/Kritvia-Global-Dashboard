"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { PickNumber, WhereIsIt } from "@/components/devices/where";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/field";
import { QrCode } from "@/components/ui/qr";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { clock } from "@/lib/link-client";

type Offer = Schemas["OfferOut"];

function useSecondsLeft(until: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return until ? Math.max(0, (new Date(until).getTime() - now) / 1000) : 0;
}

/** The QR, then "Sign in Chrome on Android as you?", then "Connected". */
function OfferDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: () => unwrap(api.POST("/auth/link/offer")),
    onSuccess: (o) => {
      setOffer(o);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const { mutate: makeCode } = make;
  useEffect(() => makeCode(), [makeCode]);

  const state = useQuery({
    queryKey: ["device-link", offer?.id],
    enabled: Boolean(offer),
    queryFn: () => unwrap(api.GET("/auth/link/{link_id}", { params: { path: { link_id: offer!.id } } })),
    refetchInterval: (q) => (["waiting", "claimed", "approved"].includes(q.state.data?.status ?? "waiting") ? 2000 : false),
  });
  const s = state.data;
  const left = useSecondsLeft(s?.expires_at ?? offer?.expires_at);
  const decide = useMutation({
    mutationFn: ({ approve, match }: { approve: boolean; match?: string }) =>
      unwrap(api.POST("/auth/link/{link_id}/decide", { params: { path: { link_id: offer!.id } }, body: { approve, match: match ?? null } })),
    onSuccess: () => {
      void state.refetch();
      void qc.invalidateQueries({ queryKey: ["me", "sessions"] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  useEffect(() => {
    if (s?.status === "used") void qc.invalidateQueries({ queryKey: ["me", "sessions"] });
  }, [s?.status, qc]);
  const status = s?.status ?? "waiting";
  const expired = status === "expired" || (offer !== null && left <= 0 && (status === "waiting" || status === "claimed"));

  return (
    <Dialog open onClose={onClose} title="Open Kritvia on your phone" description="No password to type. Your phone signs in as you, after you say yes here.">
      <FormError message={error} />
      {status === "approved" || status === "used" ? (
        <div className="space-y-3 py-4 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-success" aria-hidden />
          <p className="font-medium">{status === "used" ? `Connected: ${s?.device ?? "your phone"} is signed in.` : "Approved. Your phone is signing in…"}</p>
          <p className="text-sm text-muted">
            On the phone, tap <strong>Install Kritvia</strong> (or Share → <strong>Add to Home Screen</strong> on iPhone) to use it like an app, and turn on
            notifications to approve drafts from anywhere.
          </p>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : status === "claimed" && !expired ? (
        <div className="space-y-4 py-4 text-center">
          <Smartphone className="mx-auto h-10 w-10 text-accent" aria-hidden />
          <p className="text-base">
            Sign in <strong>{s?.device ?? "a device"}</strong> as you?
          </p>
          <WhereIsIt place={s?.place} ip={s?.ip} sameNetwork={s?.same_network} at={s?.claimed_at} />
          <p className="text-sm text-muted">Only say yes if that is the phone in your hand. ({clock(left)} left)</p>
          <PickNumber
            options={s?.options ?? []}
            busy={decide.isPending}
            shownOn="the phone"
            onPick={(n) => decide.mutate({ approve: true, match: n })}
            onRefuse={() => decide.mutate({ approve: false })}
          />
        </div>
      ) : status === "rejected" ? (
        <div className="space-y-3 py-4 text-center">
          <p className="font-medium">Refused. Nothing was signed in.</p>
          <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => make.mutate()}>
            Make a new code
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-2 sm:flex-row sm:items-start">
          <div className="relative shrink-0">
            {offer && !expired ? (
              <QrCode value={offer.url} size={208} label="QR code to open Kritvia on your phone" />
            ) : (
              <div className="grid h-[208px] w-[208px] place-items-center rounded-md border border-dashed border-border text-center text-sm text-muted">
                {make.isPending ? "Making a code…" : (
                  <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => make.mutate()}>
                    New code
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="space-y-3 text-sm">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>Open your phone&apos;s camera (or Google Lens) and point it at the code.</li>
              <li>Tap the link that appears. Kritvia opens in the browser.</li>
              <li>Come back here and tap <strong>Yes, sign it in</strong>.</li>
            </ol>
            <p className="text-xs text-subtle">
              {offer && !expired ? `This code works once, for ${clock(left)}.` : "The code expired. Make a new one."} Nobody can sign in with it without
              your yes on this screen.
            </p>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** "Open on your phone" button; opens the QR dialog. */
export function OpenOnPhone({ className, label = "Open on your phone" }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? "inline-flex items-center gap-1.5 text-sm text-accent hover:underline"}>
        <Smartphone className="h-4 w-4" aria-hidden />
        {label}
      </button>
      {open ? <OfferDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
