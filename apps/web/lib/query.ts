import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

const NO_RETRY = new Set([400, 401, 403, 404, 409, 413, 422]);

function onUnauthorized(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && typeof window !== "undefined") {
    const here = window.location.pathname + window.location.search;
    if (!window.location.pathname.startsWith("/login")) {
      window.location.assign(`/login?next=${encodeURIComponent(here)}`);
    }
  }
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onUnauthorized }),
    mutationCache: new MutationCache({ onError: onUnauthorized }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (count, error) => {
          if (error instanceof ApiError && (NO_RETRY.has(error.status) || error.status === 429)) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
