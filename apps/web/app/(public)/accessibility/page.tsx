import type { Metadata } from "next";
import { LegalDoc } from "@/components/public/doc-page";
import { ACCESSIBILITY_MD, ACCESSIBILITY_UPDATED } from "@/lib/legal/accessibility";
import { INDEX } from "@/lib/site";

export const metadata: Metadata = {
  title: "Accessibility statement",
  description: "How accessible Kritvia is, the gaps we know about, and how to tell us about a barrier.",
  robots: INDEX,
  alternates: { canonical: "/accessibility" },
};

export default function AccessibilityPage() {
  return <LegalDoc title="Accessibility Statement" updated={ACCESSIBILITY_UPDATED} markdown={ACCESSIBILITY_MD} />;
}
