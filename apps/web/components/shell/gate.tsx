"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { TermsGate } from "@/components/legal/terms-gate";
import { ErrorState } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import { AccessProvider, useAccessQuery } from "@/lib/access";
import { AppShell } from "./app-shell";
import { LogoMark } from "./logo";

export function FullPageLoader({ label = "Loading your workspace" }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 text-subtle">
      <LogoMark className="h-9 w-9" />
      <div className="flex items-center gap-2 text-sm">
        <Spinner /> {label}…
      </div>
    </div>
  );
}

/** Loads the caller's access map; sends first-time users to onboarding. */
export function AppGate({ children }: { children: ReactNode }) {
  const access = useAccessQuery();
  const router = useRouter();
  const noOrgs = access.data && access.data.orgs.length === 0;

  useEffect(() => {
    if (noOrgs) router.replace("/onboarding");
  }, [noOrgs, router]);

  if (access.isPending || noOrgs) return <FullPageLoader />;
  if (access.isError)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState error={access.error} onRetry={() => void access.refetch()} />
      </div>
    );
  return (
    <AccessProvider access={access.data}>
      <AppShell>{children}</AppShell>
      <TermsGate />
    </AccessProvider>
  );
}
