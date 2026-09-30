import Link from "next/link";
import { LogoMark } from "@/components/shell/logo";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <LogoMark className="h-9 w-9" />
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="max-w-sm text-sm text-muted">The page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/" className="text-sm font-medium text-accent hover:underline">
        Back to dashboard
      </Link>
    </main>
  );
}
