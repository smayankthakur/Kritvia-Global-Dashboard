import type { Metadata } from "next";
import { INDEX } from "@/lib/site";
import { LegalDoc } from "@/components/public/doc-page";
import { PRIVACY_MD, PRIVACY_UPDATED } from "@/lib/legal/privacy";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What Kritvia collects, why, who processes it, how long it is kept, and your rights under India's DPDP Act.",
  robots: INDEX,
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return <LegalDoc title="Privacy Policy" updated={PRIVACY_UPDATED} markdown={PRIVACY_MD} />;
}
