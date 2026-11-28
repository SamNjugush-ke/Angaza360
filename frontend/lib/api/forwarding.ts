import "server-only";

import type { NextRequest } from "next/server";

/**
 * The client IP for X-Forwarded-For: the first hop recorded by the proxy in front of this app,
 * else X-Real-IP. Next route handlers see no socket address, so this is only as trustworthy as
 * the edge that sets it — and the backend counts it only once it trusts THIS server as a proxy.
 */
export function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return request.headers.get("x-real-ip")?.trim() || null;
}

/**
 * Headers that tell the backend who the real client is, for every BFF call made on a user's
 * behalf — sign-in, refresh and the public auth flows included. The backend honours
 * X-Forwarded-For only from a proxy it trusts (TRUST_PROXY), so its per-IP rate limits apply to
 * each user instead of to this server as a whole.
 */
export function forwardingHeaders(request: NextRequest): Record<string, string> {
  const ip = clientIp(request);
  return ip ? { "x-forwarded-for": ip } : {};
}
