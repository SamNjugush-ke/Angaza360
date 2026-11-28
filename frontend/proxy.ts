import { NextResponse, type NextRequest } from "next/server";
import { CSRF_COOKIE } from "@/lib/auth/csrf-shared";
import { isAccessTokenUsable } from "@/lib/auth/jwt";
import { isProtectedPath } from "@/lib/auth/landing";
import { PATHNAME_HEADER, REFRESH_CONTINUE_PATH, SESSION_COOKIE, WORKSPACE_PATH } from "@/lib/auth/names";
import { hostConfig, hostKind } from "@/lib/hosts";

// Next.js 16 "proxy" (the renamed middleware). It makes NO backend call: the session is validated
// by the server layout (requireSession) against GET /v1/auth/me. What it does:
//   * keeps a visitor with no session off the protected area (to /login, with a returnTo);
//   * SESSION CONTINUITY: when the access token is absent or expired (read locally from its exp,
//     unverified) but the session can still be refreshed, it sends the page load through
//     GET /api/auth/refresh/continue, which spends the refresh cookie and comes straight back.
//     The proxy cannot refresh inline: the refresh cookie is scoped to /api/auth/refresh and is
//     never sent with a page request. "Can still be refreshed" is read from the CSRF cookie,
//     which is not a credential and lives exactly as long as the refresh token;
//   * keeps a signed-in visitor off the login page;
//   * "/" is the public landing page, which is static and reads no session — so a signed-in
//     visitor's "/" is sent here to /workspace (which resolves their role's workspace), a session
//     that can still be refreshed is refreshed first (it comes back to "/"), and everyone else
//     sees the landing — on the MARKETING host. On the APP host (app.<domain> or a business's
//     subdomain; see lib/hosts.ts) an anonymous "/" goes to sign in instead.

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const usable = isAccessTokenUsable(request.cookies.get(SESSION_COOKIE)?.value);
  const refreshable = request.cookies.has(CSRF_COOKIE);

  if (pathname === "/login") {
    // A cookie the backend already refused arrives with reason=expired; let it reach the form,
    // or a stale cookie would bounce between /login and / forever. An EXPIRED token is not a
    // session either.
    if (usable && request.nextUrl.searchParams.get("reason") !== "expired") {
      return NextResponse.redirect(new URL(WORKSPACE_PATH, request.url));
    }
    return NextResponse.next();
  }

  if (pathname === "/") {
    if (usable) return NextResponse.redirect(new URL(WORKSPACE_PATH, request.url));
    if (refreshable) return NextResponse.redirect(new URL(REFRESH_CONTINUE_PATH, request.url));
    if (hostKind(request.headers.get("host") ?? request.nextUrl.host, hostConfig()) === "app") {
      const login = new URL("/login", request.url);
      if (request.cookies.has(SESSION_COOKIE)) login.searchParams.set("reason", "expired");
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  }

  if (isProtectedPath(pathname)) {
    const here = `${pathname}${search}`;
    if (!usable) {
      if (refreshable) {
        const resume = new URL(REFRESH_CONTINUE_PATH, request.url);
        resume.searchParams.set("returnTo", here);
        return NextResponse.redirect(resume);
      }
      const login = new URL("/login", request.url);
      if (request.cookies.has(SESSION_COOKIE)) login.searchParams.set("reason", "expired");
      login.searchParams.set("returnTo", here);
      return NextResponse.redirect(login);
    }
    // Hand the path to the server layout (layouts cannot see it) for its own returnTo. Always
    // overwritten here, so a client cannot supply its own.
    const forwarded = new Headers(request.headers);
    forwarded.set(PATHNAME_HEADER, here);
    return NextResponse.next({ request: { headers: forwarded } });
  }

  return NextResponse.next();
}

// Only the landing, the login page and the protected app area (PROTECTED_PREFIXES — a test keeps
// the two in step): /api/*, /_next/*, static files and assets never reach the proxy.
export const config = {
  matcher: [
    "/",
    "/login",
    "/dashboard/:path*",
    "/pos/:path*",
    "/sales/:path*",
    "/products/:path*",
    "/inventory/:path*",
    "/procurement/:path*",
    "/customers/:path*",
    "/expenses/:path*",
    "/accounting/:path*",
    "/payroll/:path*",
    "/tax/:path*",
    "/people/:path*",
    "/settings/:path*",
    "/mentorship/:path*",
    "/admin/:path*",
    "/exports/:path*",
    "/account/:path*",
  ],
};
