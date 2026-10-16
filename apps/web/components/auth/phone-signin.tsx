"use client";

import { RefreshCw, Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/field";
import { QrCode } from "@/components/ui/qr";
import { clock, linkPost } from "@/lib/link-client";

type Req = { token: string; url: string; expires_at: string };

/** Login page: show a QR that a phone already signed in to Kritvia can scan to sign this computer in. */
function PhoneQr({ onClose, onSignedIn }: { onClose: () => void; onSignedIn: () => void }) {
  const [req, setReq] = useState<Req | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [refused, setRefused] = useState(false);
  const gen = useRef({ n: 0 });
  const signedIn = useRef(onSignedIn);
  useEffect(() => {
    signedIn.current = onSignedIn;
  }, [onSignedIn]);

  const start = useCallback(async () => {
    const mine = ++gen.current.n;
    setError(null);
    setRefused(false);
    setReq(null);
    const r = await linkPost<Req>("request");
    if (mine !== gen.current.n) return;
    if (r.status !== 201) {
      setError(r.data.detail ?? "Couldn't make a code. Try again.");
      return;
    }
    setReq(r.data);
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 2000));
      if (mine !== gen.current.n) return;
      const p = await linkPost("redeem", { token: r.data.token });
      if (mine !== gen.current.n) return;
      if (p.status === 200) return signedIn.current();
      if (p.status === 403) return setRefused(true);
      if (p.status === 410) return setLeft(0);
    }
  }, []);

  useEffect(() => {
    const g = gen.current;
    void start();
    return () => {
      g.n++;
    };
  }, [start]);
  useEffect(() => {
    if (!req) return;
    const tick = () => setLeft(Math.max(0, (new Date(req.expires_at).getTime() - Date.now()) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [req]);

  const expired = req !== null && left <= 0;
  return (
    <Dialog open onClose={onClose} title="Sign in with your phone" description="Use a phone where you're already signed in to Kritvia.">
      <FormError message={error} />
      <div className="flex flex-col items-center gap-4 py-2 sm:flex-row sm:items-start">
        <div className="shrink-0">
          {req && !expired && !refused ? (
            <QrCode value={req.url} size={208} label="QR code to sign in with your phone" />
          ) : (
            <div className="grid h-[208px] w-[208px] place-items-center rounded-md border border-dashed border-border p-4 text-center text-sm text-muted">
              {req === null && !error ? (
                "Making a code…"
              ) : (
                <div className="space-y-2">
                  <p>{refused ? "Refused on the phone." : "The code expired."}</p>
                  <Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => void start()}>
                    New code
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="space-y-3 text-sm">
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>On your phone, open the camera (or Google Lens) and point it at the code.</li>
            <li>Tap the link. Kritvia opens on the phone.</li>
            <li>Tap <strong>Yes, sign it in</strong> on the phone. This page signs in by itself.</li>
          </ol>
          <p className="text-xs text-subtle">{req && !expired && !refused ? `Works once, for ${clock(left)}.` : null} Not signed in on your phone yet? Sign in there first with your email code.</p>
        </div>
      </div>
    </Dialog>
  );
}

export function PhoneSigninButton({ onSignedIn }: { onSignedIn: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="w-full" icon={<Smartphone className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Sign in with your phone
      </Button>
      {open ? <PhoneQr onClose={() => setOpen(false)} onSignedIn={onSignedIn} /> : null}
    </>
  );
}
