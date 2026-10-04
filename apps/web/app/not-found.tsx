import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { LogoMark } from "@/components/shell/logo";
import { buttonClass } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="relative isolate flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <div className="kv-grid-bg pointer-events-none absolute inset-0 -z-10" aria-hidden />
      <div className="flex animate-fade-up flex-col items-center gap-3">
        <LogoMark className="h-10 w-10" />
        <p className="mt-2 text-xs font-semibold tracking-wider text-accent uppercase">Error 404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="max-w-sm text-sm text-muted">The page doesn&apos;t exist, or you don&apos;t have access to it.</p>
        <Link href="/" className={buttonClass("primary", "md", "mt-3")}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to dashboard
        </Link>
      </div>
    </main>
  );
}
