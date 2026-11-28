import { NextResponse, type NextRequest } from "next/server";
import { clearSession, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { assertCsrf } from "@/lib/auth/csrf";
import { BffError, errorResponse, handle } from "@/lib/auth/http";
import { refreshFromCookies } from "@/lib/auth/refresh";

export const runtime = "nodejs";

function signedOut(message: string): NextResponse {
  const response = errorResponse(401, "Unauthorized", message);
  clearSession(response);
  return response;
}

// Spends the single-use refresh token (sent only to this path) for a new pair and rotates every
// cookie, keeping the session's "remember me" mode. A refusal signs the browser out; an
// unreachable backend does NOT, because the token was never spent and is still good.
export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertCsrf(request);
    const outcome = await refreshFromCookies(request);
    if (outcome.kind === "refreshed") {
      const response = new NextResponse(null, { status: 204 });
      outcome.writeCookies(response);
      return response;
    }
    if (outcome.kind === "refused") {
      return signedOut(request.cookies.has(REFRESH_COOKIE) ? "Your session has expired." : "No session to refresh.");
    }
    throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
  });
}
