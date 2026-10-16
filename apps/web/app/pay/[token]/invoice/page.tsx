"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { InvoiceDocument } from "@/components/invoices/invoice-document";
import { Skeleton } from "@/components/ui/states";
import { api, errorMessage, unwrap } from "@/lib/api";

/** The customer's copy of the invoice, from its payment link. */
export default function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const q = useQuery({
    queryKey: ["pay-document", token],
    queryFn: () => unwrap(api.GET("/public/pay/{token}/document", { params: { path: { token } } })),
    retry: false,
  });
  return (
    <main id="main" className="min-h-dvh bg-surface-2 py-6 print:bg-white print:py-0">
      {q.data ? <InvoiceDocument doc={q.data} /> : q.isError ? <p className="p-6 text-sm">{errorMessage(q.error)}</p> : <Skeleton className="mx-auto h-96 max-w-3xl" />}
    </main>
  );
}
