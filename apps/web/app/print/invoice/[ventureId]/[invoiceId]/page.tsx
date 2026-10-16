"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { InvoiceDocument } from "@/components/invoices/invoice-document";
import { Skeleton } from "@/components/ui/states";
import { api, errorMessage, unwrap } from "@/lib/api";

/** An invoice on its own page (no app menus), to print or save as PDF. */
export default function PrintInvoicePage() {
  const { ventureId, invoiceId } = useParams<{ ventureId: string; invoiceId: string }>();
  const q = useQuery({
    queryKey: ["invoice-document", ventureId, invoiceId],
    queryFn: () =>
      unwrap(api.GET("/ventures/{venture_id}/invoices/{invoice_id}/document", { params: { path: { venture_id: ventureId, invoice_id: invoiceId } } })),
  });
  return (
    <main id="main" className="min-h-dvh bg-surface-2 py-6 print:bg-white print:py-0">
      {q.data ? <InvoiceDocument doc={q.data} /> : q.isError ? <p className="p-6 text-sm">{errorMessage(q.error)}</p> : <Skeleton className="mx-auto h-96 max-w-3xl" />}
    </main>
  );
}
