import type { Metadata } from "next";
import { LinkFlow } from "./link-flow";

export const metadata: Metadata = { title: "Sign in with a QR code", robots: { index: false } };

export default function LinkPage() {
  return <LinkFlow />;
}
