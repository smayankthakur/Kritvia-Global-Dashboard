"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { TradeDocument } from "@/components/trade/trade-document";
import { Skeleton } from "@/components/ui/states";
import { api, errorMessage, unwrap } from "@/lib/api";

/** An export invoice or packing list on its own page (no app menus), to print or save as PDF. */
function PrintShipment() {
  const { ventureId, shipmentId } = useParams<{ ventureId: string; shipmentId: string }>();
  const kind = useSearchParams().get("doc") === "packing" ? "packing" : "invoice";
  const s = useQuery({
    queryKey: ["shipment", ventureId, shipmentId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/shipments/{shipment_id}", { params: { path: { venture_id: ventureId, shipment_id: shipmentId } } })),
  });
  const p = useQuery({
    queryKey: ["trade-profile", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/trade-profile", { params: { path: { venture_id: ventureId } } })),
  });
  const err = s.error ?? p.error;
  return (
    <main id="main" className="min-h-dvh bg-surface-2 py-6 print:bg-white print:py-0">
      {s.data && p.data ? (
        <TradeDocument s={s.data} p={p.data} kind={kind} />
      ) : err ? (
        <p className="p-6 text-sm">{errorMessage(err)}</p>
      ) : (
        <Skeleton className="mx-auto h-96 max-w-4xl" />
      )}
    </main>
  );
}

export default function PrintShipmentPage() {
  return (
    <Suspense>
      <PrintShipment />
    </Suspense>
  );
}
