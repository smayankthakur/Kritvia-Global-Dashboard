import type { Metadata } from "next";
import { INDEX } from "@/lib/site";
import { LegalDoc } from "@/components/public/doc-page";
import { TERMS_MD, TERMS_UPDATED } from "@/lib/legal/terms";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The terms that cover your business's use of Kritvia, including how we process your data under India's DPDP Act.",
  robots: INDEX,
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return <LegalDoc title="Terms of Service" updated={TERMS_UPDATED} markdown={TERMS_MD} />;
}
