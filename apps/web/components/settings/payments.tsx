"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IndianRupee } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";

const UPI_ID = /^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;

/** Getting paid: the business's UPI ID (on every invoice's payment page) and its own Razorpay account. */
export function PaymentsCard({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["payment-settings", ventureId] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/payment-settings", { params: { path: { venture_id: ventureId } } })),
  });
  const [upi, setUpi] = useState<string | null>(null);
  const [payee, setPayee] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rzOpen, setRzOpen] = useState(false);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [rzError, setRzError] = useState<string | null>(null);
  const [hook, setHook] = useState<Schemas["RazorpayConnectOut"] | null>(null);

  const save = useMutation({
    mutationFn: (b: Schemas["PaymentSettings"]) =>
      unwrap(api.PUT("/ventures/{venture_id}/payment-settings", { params: { path: { venture_id: ventureId } }, body: b })),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setUpi(null);
      setPayee(null);
      setError(null);
      toast.success("Saved", d.upi_id ? "Every invoice's payment page now shows your UPI QR." : "UPI removed from payment pages.");
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const connect = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/connectors/razorpay", {
          params: { path: { venture_id: ventureId } },
          body: { key_id: keyId.trim(), key_secret: keySecret.trim() },
        }),
      ),
    onSuccess: (out) => {
      setKeySecret("");
      setRzError(null);
      setHook(out);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setRzError(errorMessage(e)),
  });
  const closeRz = () => {
    setRzOpen(false);
    setKeyId("");
    setKeySecret("");
    setRzError(null);
    setHook(null);
  };

  const header = (
    <CardHeader
      title={
        <span className="flex items-center gap-2">
          <IndianRupee className="h-4 w-4 text-subtle" aria-hidden /> Getting paid
        </span>
      }
      description="Every invoice gets a payment page to share. Customers pay by UPI (QR or any UPI app), or by card and netbanking through your own Razorpay, which marks the invoice paid by itself."
      actions={q.data?.razorpay ? <Badge tone="success" dot>Razorpay connected</Badge> : undefined}
    />
  );
  if (q.isLoading) return <Card>{header}<SkeletonRows rows={2} /></Card>;
  if (q.isError || !q.data) return <Card>{header}<ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  const d = q.data;
  const upiValue = upi ?? d.upi_id ?? "";
  const payeeValue = payee ?? d.payee_name ?? "";
  const dirty = upi !== null || payee !== null;

  return (
    <Card>
      {header}
      <div className="space-y-4 p-4">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (upiValue.trim() && !UPI_ID.test(upiValue.trim())) return setError("A UPI ID looks like name@bank, e.g. glowsalon@okicici.");
            save.mutate({ upi_id: upiValue.trim() || null, payee_name: payeeValue.trim() || null });
          }}
        >
          <Field label="UPI ID" hint="From your UPI or bank app">
            <Input value={upiValue} onChange={(e) => setUpi(e.target.value)} placeholder="glowsalon@okicici" maxLength={300} disabled={!d.can_edit} />
          </Field>
          <Field label="Name customers see" hint="Defaults to the business's name">
            <Input value={payeeValue} onChange={(e) => setPayee(e.target.value)} maxLength={100} disabled={!d.can_edit} />
          </Field>
          <Button type="submit" variant="primary" disabled={!d.can_edit || !dirty} loading={save.isPending}>
            Save
          </Button>
        </form>
        <FormError message={error} />
        <p className="text-xs text-subtle">
          Only the business&apos;s owner can change the UPI ID, within 10 minutes of signing in (sign out and back in if it asks), and every
          owner gets an email when it changes. Invoices already sent keep the UPI ID they were sent with.
        </p>
        <p className="text-xs text-subtle">
          Kritvia can&apos;t see payments made straight to your UPI ID. The customer can tap &quot;I&apos;ve paid&quot; on the page, and you confirm
          it on Invoices when the money shows in your bank.
        </p>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button variant={d.razorpay ? "secondary" : "primary"} disabled={!d.can_edit} onClick={() => setRzOpen(true)}>
            {d.razorpay ? "Change Razorpay account" : "Connect your Razorpay"}
          </Button>
          {d.razorpay ? (
            <span className="text-sm text-muted">
              {d.razorpay.key_id}
              {d.razorpay.last_error ? <span className="text-danger"> · {d.razorpay.last_error}</span> : null}
            </span>
          ) : (
            <span className="text-sm text-muted">Optional: online payments that mark invoices paid automatically.</span>
          )}
        </div>
        {d.razorpay ? <CopyField label="Razorpay webhook address" value={d.razorpay.webhook_url} /> : null}
      </div>
      <Dialog
        open={rzOpen}
        onClose={closeRz}
        title={hook ? "One last step in Razorpay" : "Connect your Razorpay"}
        description={
          hook
            ? "Razorpay tells Kritvia when a customer pays. Add this webhook once."
            : "Your own Razorpay account: money goes straight to you. Keys are checked with Razorpay and stored encrypted."
        }
        footer={
          hook ? (
            <Button variant="primary" onClick={closeRz}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeRz}>
                Cancel
              </Button>
              <Button variant="primary" loading={connect.isPending} disabled={!keyId.trim() || !keySecret.trim()} onClick={() => connect.mutate()}>
                Check and connect
              </Button>
            </>
          )
        }
      >
        {hook ? (
          <div className="space-y-3 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-muted">
              <li>In Razorpay Dashboard, open Account &amp; Settings → Webhooks → Add new webhook.</li>
              <li>Paste the address and the secret below.</li>
              <li>
                Under events, tick <span className="font-mono">payment_link.paid</span> (it tells Kritvia when a customer pays), then Create
                webhook.
              </li>
            </ol>
            <CopyField label="Webhook URL" value={hook.webhook_url} />
            <CopyField label="Secret (shown only now)" value={hook.webhook_secret} secret />
            <Notice tone="warning" title="Copy the secret now">
              Kritvia won&apos;t show it again. If you lose it, connect Razorpay again for a new one.
            </Notice>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">In Razorpay Dashboard: Account &amp; Settings → API keys → Generate key. Paste both here.</p>
            <Field label="Key id">
              <Input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="rzp_live_…" autoComplete="off" maxLength={60} />
            </Field>
            <Field label="Key secret">
              <Input type="password" value={keySecret} onChange={(e) => setKeySecret(e.target.value)} autoComplete="off" maxLength={100} />
            </Field>
            <FormError message={rzError} />
          </div>
        )}
      </Dialog>
    </Card>
  );
}
