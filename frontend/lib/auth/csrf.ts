import "server-only";

import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { expectedAppHost } from "@/lib/config/origin";
import { CSRF_COOKIE, CSRF_HEADER } from "./csrf-shared";
import { BffError } from "./http";

// CSRF defence for every mutating BFF route: the request must come FROM this app's origin, and
// must echo the readable ag_csrf cookie in the X-CSRF-Token header (double submit). A
// cross-site page can make the browser send the cookies, but can neither read ag_csrf to copy
// it into a header nor forge the Origin header.

export { CSRF_HEADER };

function forbidden(message: string): BffError {
  return new BffError(403, "Forbidden", message);
}

/**
 * The request's Origin must name this app's host — APP_ORIGIN's when configured, else the
 * request's own. Used alone on login, where no session (and so no CSRF token) exists yet.
 */
export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  if (!origin) throw forbidden("Cross-site request refused: missing Origin.");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("Cross-site request refused: invalid Origin.");
  }
  if (originHost !== expectedAppHost(request.nextUrl.host)) {
    throw forbidden("Cross-site request refused: Origin does not match this site.");
  }
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Origin check plus the double-submit token. Throws a 403 BffError on any failure. */
export function assertCsrf(request: NextRequest): void {
  assertSameOrigin(request);
  const cookie = request.cookies.get(CSRF_COOKIE)?.value;
  const header = request.headers.get(CSRF_HEADER);
  if (!cookie || !header || !sameToken(cookie, header)) {
    throw forbidden("CSRF token missing or invalid.");
  }
}

/**
 * The read-side counterpart for a public GET the app's own pages make (the invitation preview).
 * Browsers omit Origin on a same-origin GET, so: an Origin, when sent, must be this app's; with
 * none, the browser's Sec-Fetch-Site must say the request came from this origin. A cross-site
 * page or a bare script is refused before the backend is called.
 */
export function assertSameOriginRead(request: NextRequest): void {
  if (request.headers.has("origin")) {
    assertSameOrigin(request);
    return;
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") {
    throw forbidden("Cross-site request refused.");
  }
}
