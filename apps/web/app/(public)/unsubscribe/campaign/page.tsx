"use client";

import { MailX } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PublicShell } from "@/components/public/doc-page";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";

function Unsubscribe() {
  const token = useSearchParams().get("t") ?? "";
  const [state, setState] = useState<"ask" | "busy" | "out">("ask");
  const [business, setBusiness] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setErr(null);
    setState("busy");
    const r = await fetch("/api/unsubscribe/campaign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => null);
    if (!r?.ok) {
      setErr(r?.status === 400 ? "This link is not valid. Use the link from the most recent email." : "Could not update your preference. Try again in a minute.");
      setState("ask");
      return;
    }
    const b = (await r.json().catch(() => ({}))) as { business?: string };
    setBusiness(b.business ?? "");
    setState("out");
  };
  if (!token) return <FormError message="This page needs the unsubscribe link from the email." />;
  return (
    <div className="glass max-w-lg rounded-2xl border p-6">
      {state === "out" ? (
        <div role="status">
          <MailX className="h-6 w-6 text-accent" aria-hidden />
          <h2 className="mt-3 text-lg font-semibold text-fg">You&apos;re unsubscribed</h2>
          <p className="mt-1 text-sm text-muted">{business || "This business"} won&apos;t send you offers and news by email any more.</p>
        </div>
      ) : (
        <>
          <h2 className="text-lg font-semibold text-fg">Stop these emails?</h2>
          <p className="mt-1 text-sm text-muted">You&apos;ll stop getting offers and news from this business by email. Invoices and booking messages still arrive.</p>
          <FormError message={err} />
          <Button className="mt-4" variant="primary" loading={state === "busy"} onClick={() => void send()}>
            Unsubscribe
          </Button>
        </>
      )}
    </div>
  );
}

export default function CampaignUnsubscribePage() {
  return (
    <PublicShell>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Email preferences</h1>
      <Suspense>
        <Unsubscribe />
      </Suspense>
    </PublicShell>
  );
}
