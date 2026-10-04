"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="flex min-h-[60dvh] animate-fade-up flex-col items-center justify-center gap-3 px-4 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-danger-soft text-danger">
        <TriangleAlert className="h-5 w-5" aria-hidden />
      </span>
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted">An unexpected error occurred while showing this page.{error.digest ? ` Reference: ${error.digest}` : ""}</p>
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
