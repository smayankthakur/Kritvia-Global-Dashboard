import type { Metadata } from "next";
import type { ReactNode } from "react";
import { INDEX } from "@/lib/site";

export const metadata: Metadata = {
  title: "Help",
  description: "Getting started with Kritvia, how agents and approvals work, plans and billing, and how to reach support.",
  robots: INDEX,
  alternates: { canonical: "/help" },
};

export default function HelpLayout({ children }: { children: ReactNode }) {
  return children;
}
