import { NextResponse, type NextRequest } from "next/server";
import { safeReturnTo } from "@/lib/auth/landing";
import { clearSession } from "@/lib/auth/cookies";
import { refreshFromCookies } from "@/lib/auth/refresh";

export const runtime = "nodejs";

// SESSION CONTINUITY ON A FULL PAGE LOAD. proxy.ts sends a navigation here (307) when its access
// token has expired but the session can still be refreshed. This route sits under the refresh
// cookie's own path (/api/auth/refresh), so — unlike the page — it receives that cookie. It spends
// it, rotates every cookie (keeping "keep me signed in") and sends the browser back (303) to the
// page it asked for, which now renders with the new session.
//
// A GET that rotates the session is safe here: the refresh cookie is SameSite=Strict, so a
// cross-site page cannot make the browser send it, and the response carries nothing readable —
// only cookies and a redirect to a same-site path (returnTo goes through safeReturnTo).

function toLogin(request: NextRequest, returnTo: string | null): NextResponse {
  const login = new URL("/login", request.url);
  login.searchParams.set("reason", "expired");
  if (returnTo !== null) login.searchParams.set("returnTo", returnTo);
  return NextResponse.redirect(login, 303);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const outcome = await refreshFromCookies(request);

  if (outcome.kind === "refreshed") {
    const response = NextResponse.redirect(new URL(returnTo ?? "/", request.url), 303);
    outcome.writeCookies(response);
    return response;
  }
  const response = toLogin(request, returnTo);
  // A refused token ends the session; an unreachable backend leaves it (nothing was spent), and
  // the sign-in page's "session ended" notice is still the honest next step for the user.
  if (outcome.kind === "refused") clearSession(response);
  return response;
}
