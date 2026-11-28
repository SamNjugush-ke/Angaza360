import { CSRF_HEADER, readCsrfToken } from "@/lib/auth/csrf-shared";

// The BROWSER's way to the data API: same-origin calls to the BFF proxy (/api/v1/*). The access
// token never appears here — it rides in the HttpOnly cookie and the BFF attaches it. Mutations
// echo the CSRF cookie. A 401 (expired access token) triggers ONE refresh shared by every call
// that hit it at the same time (single flight), then the call is retried once.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type RefreshOutcome = "refreshed" | "expired" | "unavailable";

let inFlight: Promise<RefreshOutcome> | null = null;

function csrfHeaders(method: string, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  if (MUTATING.has(method.toUpperCase())) result.set(CSRF_HEADER, readCsrfToken(document.cookie) ?? "");
  return result;
}

/** Spends the refresh cookie once, however many calls are waiting on it. */
export function refreshSession(): Promise<RefreshOutcome> {
  inFlight ??= fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: csrfHeaders("POST"),
  })
    .then((response): RefreshOutcome => {
      if (response.status === 204) return "refreshed";
      // 401: the refresh token was refused and the BFF cleared the session.
      return response.status === 401 ? "expired" : "unavailable";
    })
    .catch((): RefreshOutcome => "unavailable")
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Where a browser goes when its session is over. Replaceable for tests. */
let onSessionExpired = (): void => {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  // A full document load on purpose (not router.push): it discards every piece of in-memory
  // client state that belonged to the session that just ended.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?reason=expired&returnTo=${encodeURIComponent(returnTo)}`);
};

export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler;
}

/** fetch(`/api/v1${path}`) with CSRF, single-flight refresh on 401, and one retry. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  // Re-read on each send: a refresh rotates the CSRF cookie.
  const send = () => fetch(`/api/v1${path}`, { ...init, method, credentials: "same-origin", headers: csrfHeaders(method, init.headers) });

  const first = await send();
  if (first.status !== 401) return first;
  const outcome = await refreshSession();
  if (outcome === "refreshed") return send();
  if (outcome === "expired") onSessionExpired();
  return first;
}
