"use client";

import { CheckCircle2, Laptop, Smartphone, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { InstallApp } from "@/components/devices/install-app";
import { PushToggle } from "@/components/notifications/push-toggle";
import { AuthCard } from "@/components/shell/auth-card";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { linkPost, tokenFromHash } from "@/lib/link-client";

const RESUME = "kv-link-token";
type Peek = { kind: "offer" | "request"; status: string; device: string | null; expires_at: string };
type View =
  | { s: "loading" }
  | { s: "none" }
  | { s: "approve-on-computer"; device: string | null }
  | { s: "signed-in" }
  | { s: "confirm"; device: string | null }
  | { s: "need-signin" }
  | { s: "answered"; approved: boolean }
  | { s: "refused" }
  | { s: "expired"; detail?: string };

/** The page a Kritvia QR code opens on a phone. Two cases:
 *  - a computer offered to sign this phone in: claim it, wait for the yes there, then signed in;
 *  - a login page asked this (signed-in) phone to sign it in: say yes or no here. */
export function LinkFlow() {
  const [view, setView] = useState<View>({ s: "loading" });
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const started = useRef(false);

  const poll = useCallback(async (t: string) => {
    for (let i = 0; i < 90 && alive.current; i++) {
      const r = await linkPost("redeem", { token: t });
      if (r.status === 200) return setView({ s: "signed-in" });
      if (r.status === 403) return setView({ s: "refused" });
      if (r.status === 410) return setView({ s: "expired", detail: r.data.detail });
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    if (alive.current) setView({ s: "expired" });
  }, []);

  useEffect(() => {
    // Scanning another code while this page is open only changes the '#': start over with it.
    const again = () => window.location.reload();
    window.addEventListener("hashchange", again);
    return () => window.removeEventListener("hashchange", again);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (started.current) return;          // a scanned code is claimed once, even if React runs this twice
    started.current = true;
    let t = tokenFromHash(window.location.hash);
    if (t) window.history.replaceState(null, "", "/link");   // the code isn't left in the address bar
    else {
      try {
        t = tokenFromHash(sessionStorage.getItem(RESUME) ?? "");
        sessionStorage.removeItem(RESUME);
      } catch {
        t = null;
      }
    }
    setToken(t);
    if (!t) {
      setView({ s: "none" });
      return;
    }
    void (async () => {
      const p = await linkPost<Peek>("peek", { token: t });
      if (p.status !== 200) return setView({ s: "expired", detail: p.data.detail });
      if (p.data.kind === "offer") {
        const c = await linkPost<{ device: string }>("claim", { token: t });
        if (c.status !== 200) return setView({ s: "expired", detail: c.data.detail });
        setView({ s: "approve-on-computer", device: p.data.device });
        void poll(t);
        return;
      }
      const me = await api.GET("/auth/me");
      if (me.response.status === 200) setView({ s: "confirm", device: p.data.device });
      else setView({ s: "need-signin" });
    })();
    return () => {
      alive.current = false;
    };
  }, [poll]);

  const answer = async (approve: boolean) => {
    if (!token) return;
    setBusy(true);
    const r = await api.POST("/auth/link/answer", { body: { token, approve } });
    setBusy(false);
    if (r.response.ok) setView({ s: "answered", approved: approve });
    else setView({ s: "expired", detail: (r.error as { detail?: string } | undefined)?.detail });
  };

  const signInFirst = () => {
    try {
      if (token) sessionStorage.setItem(RESUME, token);
    } catch {
      /* private mode: they can scan again after signing in */
    }
    window.location.assign("/login?next=%2Flink");
  };

  switch (view.s) {
    case "loading":
      return <AuthCard title="Connecting…"><p className="text-sm text-muted">Checking the code.</p></AuthCard>;
    case "none":
      return (
        <AuthCard title="Scan a Kritvia QR code" subtitle="Open Kritvia on your computer, then Your account → Open on your phone.">
          <Button variant="primary" className="w-full" onClick={() => window.location.assign("/login")}>
            Sign in another way
          </Button>
        </AuthCard>
      );
    case "approve-on-computer":
      return (
        <AuthCard title="Now say yes on your computer" subtitle={view.device ? `Kritvia on ${view.device} is asking you to confirm.` : undefined}>
          <div className="space-y-3 text-center">
            <Laptop className="mx-auto h-10 w-10 animate-pulse text-accent" aria-hidden />
            <p className="text-sm text-muted">Tap <strong>Yes, sign it in</strong> on the computer. This page continues by itself.</p>
          </div>
        </AuthCard>
      );
    case "signed-in":
      return (
        <AuthCard title="You're signed in on this phone" subtitle="Your phone and computer are connected to the same Kritvia account.">
          <div className="space-y-4">
            <InstallApp />
            <PushToggle />
            <Button variant="primary" className="w-full" onClick={() => window.location.assign("/")}>
              Open Kritvia
            </Button>
          </div>
        </AuthCard>
      );
    case "confirm":
      return (
        <AuthCard title="Sign in on your computer?" subtitle="A Kritvia login page showed this code.">
          <div className="space-y-4 text-center">
            <Smartphone className="mx-auto h-10 w-10 text-accent" aria-hidden />
            <p>
              Sign in <strong>{view.device ?? "that device"}</strong> as you?
            </p>
            <p className="text-sm text-muted">Only say yes if you are standing at that computer.</p>
            <div className="flex justify-center gap-2">
              <Button variant="primary" loading={busy} onClick={() => void answer(true)}>
                Yes, sign it in
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void answer(false)}>
                Not me
              </Button>
            </div>
          </div>
        </AuthCard>
      );
    case "need-signin":
      return (
        <AuthCard title="Sign in on this phone first" subtitle="Then this page asks whether to sign your computer in.">
          <Button variant="primary" className="w-full" onClick={signInFirst}>
            Sign in
          </Button>
        </AuthCard>
      );
    case "answered":
      return (
        <AuthCard title={view.approved ? "Done" : "Refused"}>
          <div className="space-y-3 text-center">
            {view.approved ? <CheckCircle2 className="mx-auto h-10 w-10 text-success" aria-hidden /> : <XCircle className="mx-auto h-10 w-10 text-danger" aria-hidden />}
            <p className="text-sm text-muted">{view.approved ? "Your computer is signing in now." : "Nothing was signed in."}</p>
            <Button className="w-full" onClick={() => window.location.assign("/")}>
              Open Kritvia here
            </Button>
          </div>
        </AuthCard>
      );
    case "refused":
      return (
        <AuthCard title="Not signed in" subtitle="The sign-in was refused on your computer.">
          <p className="text-sm text-muted">If that was a mistake, make a new code on the computer and scan it again.</p>
        </AuthCard>
      );
    default:
      return (
        <AuthCard title="This code has expired" subtitle={view.detail ?? "Codes work once, for 3 minutes."}>
          <p className="text-sm text-muted">Make a new QR code on your computer and scan it again.</p>
        </AuthCard>
      );
  }
}
