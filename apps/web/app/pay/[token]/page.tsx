"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, CreditCard, Lock, Smartphone } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Button, buttonClass } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { QrCode } from "@/components/ui/qr";
import { Skeleton } from "@/components/ui/states";
import { ApiError, api, errorMessage, unwrap } from "@/lib/api";
import { formatDate } from "@/lib/format";

function Shell({ business, children }: { business?: string; children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center bg-bg px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="text-lg font-semibold tracking-tight">{business ?? "Payment"}</p>
          <p className="text-sm text-muted">Invoice payment</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 shadow-card">{children}</div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-subtle">
          <Lock className="h-3.5 w-3.5" aria-hidden /> You pay {business ?? "the business"} directly. This page is provided by Kritvia.
        </p>
      </div>
    </main>
  );
}

export default function PayPage() {
  const { token } = useParams<{ token: string }>();
  const [ref, setRef] = useState("");
  const page = useQuery({
    queryKey: ["pay", token],
    queryFn: () => unwrap(api.GET("/public/pay/{token}", { params: { path: { token } } })),
    retry: false,
    refetchOnWindowFocus: true,
  });
  const online = useMutation({
    mutationFn: () => unwrap(api.POST("/public/pay/{token}/online", { params: { path: { token } } })),
    onSuccess: (out) => window.location.assign(out.url),
  });
  const said = useMutation({
    mutationFn: () => unwrap(api.POST("/public/pay/{token}/paid", { params: { path: { token } }, body: { reference: ref.trim() || null } })),
    onSuccess: () => void page.refetch(),
  });

  if (page.isLoading) {
    return (
      <Shell>
        <Skeleton className="h-40" />
      </Shell>
    );
  }
  if (page.isError || !page.data) {
    const gone = page.error instanceof ApiError && page.error.status === 404;
    return (
      <Shell>
        <p className="text-sm text-muted">{gone ? "This payment link isn't valid. Ask the business for a new one." : errorMessage(page.error)}</p>
      </Shell>
    );
  }
  const d = page.data;
  if (d.status !== "open") {
    return (
      <Shell business={d.business}>
        <div className="flex flex-col items-center gap-2 text-center">
          <CheckCircle2 className="h-10 w-10 text-success" aria-hidden />
          <p className="text-lg font-semibold">Paid. Thank you!</p>
          <p className="text-sm text-muted">
            {d.number ? `Invoice ${d.number}` : "This invoice"} for {d.amount_text} is settled.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell business={d.business}>
      <div className="space-y-5">
        <div className="text-center">
          <p className="text-sm text-muted">
            {d.number ? `Invoice ${d.number} · ` : ""}for {d.customer_name}
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{d.amount_text}</p>
          <p className="text-sm text-muted">Due {formatDate(d.due_on)}</p>
          <a className="mt-1 inline-block text-sm font-medium text-accent underline underline-offset-2" href={`/pay/${token}/invoice`}>
            View the invoice
          </a>
        </div>

        {d.customer_says_paid ? (
          <Notice tone="success" title="Thanks, we've told the business">
            They&apos;ll confirm once the payment shows in their account. No need to do anything else.
          </Notice>
        ) : null}

        {d.upi ? (
          <section aria-labelledby="upi-h" className="space-y-3 rounded-lg border border-border p-4">
            <h2 id="upi-h" className="flex items-center gap-2 text-sm font-semibold">
              <Smartphone className="h-4 w-4" aria-hidden /> Pay by UPI
            </h2>
            <div className="flex justify-center">
              <QrCode value={d.upi.link} label={`UPI QR code to pay ${d.amount_text} to ${d.upi.payee_name}`} />
            </div>
            <p className="text-center text-xs text-muted">
              Scan with any UPI app, or on this phone:
            </p>
            <a
              href={d.upi.link}
              className={buttonClass("primary", "md", "w-full justify-center")}
            >
              Open my UPI app
            </a>
            <p className="text-center text-xs text-subtle">
              To {d.upi.payee_name} · {d.upi.upi_id}
            </p>
            {!d.customer_says_paid ? (
              <div className="space-y-2 border-t border-border pt-3">
                <Field label="Paid already? UPI reference (optional)" hint="The 12-digit number in your UPI app">
                  <Input value={ref} onChange={(e) => setRef(e.target.value)} inputMode="numeric" maxLength={60} />
                </Field>
                <Button className="w-full" loading={said.isPending} onClick={() => said.mutate()}>
                  I&apos;ve paid
                </Button>
                {said.isError ? <p className="text-sm text-danger">{errorMessage(said.error)}</p> : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {d.online ? (
          <section aria-labelledby="online-h" className="space-y-2 rounded-lg border border-border p-4">
            <h2 id="online-h" className="flex items-center gap-2 text-sm font-semibold">
              <CreditCard className="h-4 w-4" aria-hidden /> Card, netbanking or UPI online
            </h2>
            <p className="text-xs text-muted">Through Razorpay. The invoice is marked paid as soon as it goes through.</p>
            <Button variant={d.upi ? "secondary" : "primary"} className="w-full" loading={online.isPending} onClick={() => online.mutate()}>
              Pay {d.amount_text} online
            </Button>
            {online.isError ? <p className="text-sm text-danger">{errorMessage(online.error)}</p> : null}
          </section>
        ) : null}

        {!d.upi && !d.online ? (
          <p className="text-sm text-muted">The business hasn&apos;t added a way to pay here yet. Please pay them the way you usually do.</p>
        ) : null}
      </div>
    </Shell>
  );
}
