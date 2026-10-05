import type { Metadata } from "next";
import { LegalDoc } from "@/components/public/doc-page";
import { REFUNDS_MD, REFUNDS_UPDATED } from "@/lib/legal/refunds";
import { INDEX } from "@/lib/site";

export const metadata: Metadata = {
  title: "Cancellation, refund and delivery policy",
  description: "Cancel any paid Kritvia plan in the app at any time. When we refund, how to ask, and how the service is delivered.",
  robots: INDEX,
  alternates: { canonical: "/refunds" },
};

export default function RefundsPage() {
  return <LegalDoc title="Cancellation, Refund and Delivery Policy" updated={REFUNDS_UPDATED} markdown={REFUNDS_MD} />;
}
