import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { clearSession, SESSION_COOKIE } from "./cookies";
import { assertCsrf } from "./csrf";
import { handle } from "./http";

/**
 * Signs out: best-effort revocation at the backend with the access token, then the cookies are
 * cleared whatever the backend said. A failed revocation never leaves the browser signed in.
 */
export function logoutRoute(backendPath: "/v1/auth/logout" | "/v1/auth/logout-all") {
  return (request: NextRequest): Promise<NextResponse> =>
    handle(async () => {
      assertCsrf(request);
      const accessToken = request.cookies.get(SESSION_COOKIE)?.value;
      if (accessToken) {
        try {
          await createApiClient({ headers: { authorization: `Bearer ${accessToken}` } }).POST(backendPath);
        } catch (err) {
          // Unreachable backend: the server session lapses at its own expiry, and the browser is
          // signed out below regardless. Logged by error name only — never a token or a URL.
          console.warn(`[auth] backend ${backendPath} failed: ${err instanceof Error ? err.name : "unknown"}`);
        }
      }
      const response = new NextResponse(null, { status: 204 });
      clearSession(response);
      return response;
    });
}
