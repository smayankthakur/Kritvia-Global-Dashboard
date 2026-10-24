import type { Query } from "@tanstack/react-query";
import { ApiError } from "./api";

/** The API can't be reached (network down, API restarting, proxy can't connect): a passing problem the page
 * recovers from by itself, not an error the owner must act on (round 3, A24). */
export function isUnreachable(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504);
}

/** Wait before the next try: 2 s, 4 s, 8 s … up to 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 2000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/** A query that failed only because the API was out of reach. */
export function unreachableQuery(q: Pick<Query, "state">): boolean {
  return q.state.status === "error" && isUnreachable(q.state.error);
}

const ACCESS_CACHE = "kv-access-cache";

/** The last access map this tab saw, so the sidebar can stay while the API is unreachable. Session only. */
export function cacheAccess(data: unknown): void {
  try {
    window.sessionStorage.setItem(ACCESS_CACHE, JSON.stringify(data));
  } catch {
    /* storage off: the reconnect screen shows without the sidebar */
  }
}

export function cachedAccess<T>(): T | null {
  try {
    const raw = window.sessionStorage.getItem(ACCESS_CACHE);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function forgetAccess(): void {
  try {
    window.sessionStorage.removeItem(ACCESS_CACHE);
  } catch {
    /* nothing kept */
  }
}
