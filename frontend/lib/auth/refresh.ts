import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { PERSIST_COOKIE, REFRESH_COOKIE, setSession } from "./cookies";

// Spending the refresh cookie — ONE implementation, used by POST /api/auth/refresh (the browser's
// single-flight refresh) and GET /api/auth/refresh/continue (proxy.ts sends a full page load
// there when its access token has expired). Both routes live under the refresh cookie's own path,
// /api/auth/refresh, which is the only place the browser sends that cookie.

export type RefreshOutcome =
  /** The backend issued a new pair: write it (rotating every cookie) onto a response. */
  | { kind: "refreshed"; writeCookies: (response: NextResponse) => void }
  /** No refresh cookie, or the backend refused it: the session is over. */
  | { kind: "refused" }
  /** The backend could not be reached: the token was never spent and is still good. */
  | { kind: "unavailable" };

export async function refreshFromCookies(request: NextRequest): Promise<RefreshOutcome> {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return { kind: "refused" };
  // Keep the session's "keep me signed in" mode across the rotation.
  const remember = request.cookies.get(PERSIST_COOKIE)?.value === "1";

  let result;
  try {
    result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/refresh", { body: { refreshToken } });
  } catch {
    // Network failure reaching the backend: nothing was spent.
    return { kind: "unavailable" };
  }
  const { data, response: upstream } = result;
  if (data) {
    return { kind: "refreshed", writeCookies: (response) => setSession(response, { ...data, remember }) };
  }
  if (upstream.status === 400 || upstream.status === 401) return { kind: "refused" };
  return { kind: "unavailable" };
}
