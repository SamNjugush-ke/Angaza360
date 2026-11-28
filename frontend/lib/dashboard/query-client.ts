import { QueryClient } from "@tanstack/react-query";
import { ApiHttpError } from "./fetch";

// The query defaults for every data panel:
//   * fresh for 30s — a dashboard re-read inside that window is served from cache;
//   * NO refetch on window focus — money figures must not change under the user's eyes just
//     because they switched tabs; they refresh when they ask (or the period changes);
//   * a 4xx is NEVER retried (asking again will not change a refusal or a bad request); a 5xx
//     or a network failure is retried once.

export const STALE_TIME_MS = 30_000;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiHttpError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        refetchOnWindowFocus: false,
        retry: shouldRetry,
      },
    },
  });
}
