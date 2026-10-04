"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Clock, SearchX, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError, errorMessage } from "@/lib/api";
import { Button } from "./button";
import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("kv-shimmer rounded-md", className)} aria-hidden />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5 p-4", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex animate-fade-up flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {Icon ? (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent ring-1 ring-accent/15">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      ) : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-subtle">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const status = error instanceof ApiError ? error.status : null;
  const Icon = status === 404 ? SearchX : status === 429 ? Clock : TriangleAlert;
  const title =
    status === 404
      ? "Not found, or you don't have access"
      : status === 429
        ? "Slow down a little"
        : status === 403
          ? "Request refused"
          : "Something went wrong";
  const description =
    status === 404
      ? "It may have been removed, or your role doesn't include it. Access is enforced per venture."
      : errorMessage(error);
  return (
    <div role="alert" className={cn("flex animate-fade-up flex-col items-center justify-center px-6 py-12 text-center", className)}>
      <div
        className={cn(
          "mb-3 flex h-10 w-10 items-center justify-center rounded-full",
          status === 404 || status === 429 ? "bg-surface-2 text-subtle" : "bg-danger-soft text-danger",
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-md text-sm text-subtle">{description}</p>
      {onRetry && status !== 404 ? (
        <Button size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Loading / error / empty / data for one query. */
export function QueryState<T>({
  query,
  children,
  empty,
  isEmpty,
  loading,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  loading?: ReactNode;
}) {
  if (query.isPending) return <>{loading ?? <SkeletonRows />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data as T;
  const emptyNow = isEmpty ? isEmpty(data) : Array.isArray(data) && data.length === 0;
  if (emptyNow && empty) return <>{empty}</>;
  return <>{children(data)}</>;
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {errorMessage(error)}
    </p>
  );
}
