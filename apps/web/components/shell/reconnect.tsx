"use client";

import { useQueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { backoffMs, unreachableQuery } from "@/lib/reconnect";
import { LogoMark } from "./logo";

/** True while any query on the page failed only because the API was out of reach. */
function useUnreachable(): boolean {
  const qc = useQueryClient();
  const [down, setDown] = useState(false);
  useEffect(() => {
    const cache = qc.getQueryCache();
    const check = () => setDown(cache.getAll().some((q) => q.getObserversCount() > 0 && unreachableQuery(q)));
    check();
    return cache.subscribe(check);
  }, [qc]);
  return down;
}

/** While the API is out of reach: a "Reconnecting…" line under the top bar, and the failed queries are tried
 * again with back-off (and as soon as the browser is back online). The page recovers by itself. */
export function ReconnectBanner() {
  const qc = useQueryClient();
  const down = useUnreachable();
  const attempt = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!down) {
      attempt.current = 0;
      return;
    }
    const retry = () => {
      attempt.current += 1;
      void qc.refetchQueries({ predicate: (q) => q.getObserversCount() > 0 && unreachableQuery(q) });
      setTick((t) => t + 1);
    };
    const timer = setTimeout(retry, backoffMs(attempt.current));
    window.addEventListener("online", retry);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", retry);
    };
  }, [down, qc, tick]);

  if (!down) return null;
  return (
    <div role="status" aria-live="polite" className="mb-4 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning-fg">
      <Spinner />
      <span className="min-w-0 flex-1">Reconnecting… Kritvia can&apos;t reach its server just now. This page loads again by itself.</span>
    </div>
  );
}

/** First load with the API out of reach and nothing remembered: the app's frame with "Reconnecting…", trying again with back-off. */
export function OfflineShell({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const attempt = useRef(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const go = () => {
      attempt.current += 1;
      onRetry();
      setTick((t) => t + 1);
    };
    const timer = setTimeout(go, backoffMs(attempt.current));
    window.addEventListener("online", go);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", go);
    };
  }, [onRetry, tick]);
  return (
    <div className="min-h-dvh lg:pl-[16.5rem]">
      <aside className="glass fixed top-3 bottom-3 left-3 z-30 hidden w-60 rounded-2xl border p-4 lg:block" aria-label="Sidebar">
        <LogoMark className="h-7 w-7" />
        <div className="mt-6 space-y-2" aria-hidden>
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="h-6 animate-pulse rounded-md bg-surface-3" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
          ))}
        </div>
      </aside>
      <header className="glass sticky top-3 z-20 mx-3 mt-3 flex h-14 items-center gap-2 rounded-2xl border px-4 lg:mr-4 lg:ml-0">
        <LogoMark className="h-6 w-6 lg:hidden" />
      </header>
      <main id="main" className="mx-auto flex w-full max-w-[1400px] flex-col items-center px-4 pt-24 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-warning-soft text-warning" aria-hidden>
          <WifiOff className="h-5 w-5" />
        </span>
        <h1 className="mt-3 text-base font-semibold" role="status" aria-live="polite">
          Reconnecting…
        </h1>
        <p className="mt-1 max-w-md text-sm text-subtle">Kritvia can&apos;t reach its server just now. Your workspace opens by itself as soon as it&apos;s back.</p>
        <Button size="sm" className="mt-4" onClick={onRetry} loading={retrying}>
          Try now
        </Button>
      </main>
    </div>
  );
}
