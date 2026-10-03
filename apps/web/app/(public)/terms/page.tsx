import type { Metadata } from "next";
import { LegalDoc } from "@/components/public/doc-page";
import { TERMS_MD, TERMS_UPDATED } from "@/lib/legal/terms";

export const metadata: Metadata = { title: "Terms of service" };

export default function TermsPage() {
  return <LegalDoc title="Terms of Service" updated={TERMS_UPDATED} markdown={TERMS_MD} />;
}
