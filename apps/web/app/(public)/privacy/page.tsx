import type { Metadata } from "next";
import { LegalDoc } from "@/components/public/doc-page";
import { PRIVACY_MD, PRIVACY_UPDATED } from "@/lib/legal/privacy";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return <LegalDoc title="Privacy Policy" updated={PRIVACY_UPDATED} markdown={PRIVACY_MD} />;
}
