import type { Metadata } from "next";
import type { ReactNode } from "react";
import { INDEX } from "@/lib/site";

export const metadata: Metadata = {
  title: "Status",
  description: "Live status of Kritvia and its incidents over the last 90 days.",
  robots: INDEX,
  alternates: { canonical: "/status" },
};

export default function StatusLayout({ children }: { children: ReactNode }) {
  return children;
}
