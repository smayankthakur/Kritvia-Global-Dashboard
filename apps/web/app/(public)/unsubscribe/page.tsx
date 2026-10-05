"use client";

import { MailCheck, MailX } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PublicShell } from "@/components/public/doc-page";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";

function Unsubscribe() {
  const token = useSearchParams().get("t") ?? "";
  const [state, setState] = useState<"ask" | "busy" | "out" | "in">("ask");
  const [err, setErr] = useState<string | null>(null);
  const send = async (resubscribe: boolean) => {
    setErr(null);
    setState("busy");
    const r = await fetch("/api/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, resubscribe }) }).catch(() => null);
    if (!r?.ok) {
      setErr(r?.status === 400 ? "This link is not valid. Use the link from your most recent email, or write to us." : "Could not update your preference. Try again in a minute.");
      setState("ask");
      return;
    }
    setState(resubscribe ? "in" : "out");
  };
  if (!token)
    return <FormError message="This page needs the unsubscribe link from one of our emails." />;
  return (
    <div className="glass max-w-lg rounded-2xl border p-6">
      {state === "out" ? (
        <div role="status">
          <MailX className="h-6 w-6 text-accent" aria-hidden />
          <h2 className="mt-3 text-lg font-semibold text-fg">You&apos;re unsubscribed</h2>
          <p className="mt-1 text-sm text-muted">We won&apos;t send you product emails any more. You&apos;ll still get sign-in codes and security notices, which keep your account safe.</p>
          <Button className="mt-4" variant="ghost" onClick={() => void send(true)}>
            Undo
          </Button>
        </div>
      ) : state === "in" ? (
        <div role="status">
          <MailCheck className="h-6 w-6 text-success" aria-hidden />
          <h2 className="mt-3 text-lg font-semibold text-fg">You&apos;re subscribed again</h2>
          <p className="mt-1 text-sm text-muted">Product emails will reach you as before.</p>
        </div>
      ) : (
        <>
          <h2 className="text-lg font-semibold text-fg">Stop product emails?</h2>
          <p className="mt-1 text-sm text-muted">Product emails are summaries, tips and announcements. Sign-in codes and security notices always arrive.</p>
          <FormError message={err} />
          <Button className="mt-4" variant="primary" loading={state === "busy"} onClick={() => void send(false)}>
            Unsubscribe
          </Button>
        </>
      )}
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <PublicShell>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Email preferences</h1>
      <Suspense>
        <Unsubscribe />
      </Suspense>
    </PublicShell>
  );
}
