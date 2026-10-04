import type { Metadata } from "next";
import type { ReactNode } from "react";
import { INDEX } from "@/lib/site";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Start free with Kritvia: AI agents that draft replies, proposals and checks for your business. No card needed.",
  robots: INDEX,
  alternates: { canonical: "/register" },
};

export default function RegisterLayout({ children }: { children: ReactNode }) {
  return children;
}
