"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { TermsGate } from "@/components/legal/terms-gate";
import { ErrorState } from "@/components/ui/states";
import { Spinner } from "@/components/ui/spinner";
import type { Schemas } from "@/lib/api";
import { AccessProvider, useAccessQuery } from "@/lib/access";
import { cacheAccess, cachedAccess, isUnreachable } from "@/lib/reconnect";
import { AppShell } from "./app-shell";
import { LogoMark } from "./logo";
import { OfflineShell } from "./reconnect";

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

/** Loads the caller's access map; sends first-time users to onboarding. While the API is out of reach the
 * shell stays (from the last access map this tab saw) and pages show "Reconnecting…" until it's back (A24). */
export function AppGate({ children }: { children: ReactNode }) {
  const access = useAccessQuery();
  const router = useRouter();
  const noOrgs = access.data && access.data.orgs.length === 0;
  const offline = access.isError && isUnreachable(access.error);
  const [remembered, setRemembered] = useState<Schemas["MeAccessOut"] | null>(null);

  useEffect(() => {
    if (noOrgs) router.replace("/onboarding");
  }, [noOrgs, router]);
  useEffect(() => {
    if (access.data) cacheAccess(access.data);
  }, [access.data]);
  useEffect(() => {
    if (offline && !access.data) setRemembered(cachedAccess<Schemas["MeAccessOut"]>());
  }, [offline, access.data]);
  const { refetch } = access;
  const retry = useCallback(() => void refetch(), [refetch]);

  // A failed refetch keeps the data it had: the shell stays and only the pages that can't load say so.
  const data = access.data ?? (offline ? remembered : null);
  if ((access.isPending && !data) || noOrgs) return <FullPageLoader />;
  if (!data) {
    if (offline) return <OfflineShell onRetry={retry} retrying={access.isFetching} />;
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState error={access.error} onRetry={retry} />
      </div>
    );
  }
  return (
    <AccessProvider access={data}>
      <AppShell>{children}</AppShell>
      <TermsGate />
    </AccessProvider>
  );
}
