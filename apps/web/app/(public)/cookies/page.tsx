import type { Metadata } from "next";
import { LegalDoc } from "@/components/public/doc-page";
import { COOKIES_MD, COOKIES_UPDATED } from "@/lib/legal/cookies";
import { INDEX } from "@/lib/site";

export const metadata: Metadata = {
  title: "Cookie policy",
  description: "Every cookie and storage key Kritvia uses. Only what is needed to work: no advertising, analytics or third-party trackers.",
  robots: INDEX,
  alternates: { canonical: "/cookies" },
};

export default function CookiesPage() {
  return <LegalDoc title="Cookie Policy" updated={COOKIES_UPDATED} markdown={COOKIES_MD} />;
}
