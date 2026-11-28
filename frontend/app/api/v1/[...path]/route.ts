import { NextResponse, type NextRequest } from "next/server";
import { apiBaseUrl } from "@/lib/api/config";
import { clientIp } from "@/lib/api/forwarding";
import { ACT_AS_COOKIE, SESSION_COOKIE } from "@/lib/auth/cookies";
import { assertCsrf } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";

// The browser's ONLY door to the backend's data API. /api/v1/<path> is forwarded to the backend's
// /v1/<path> with the access token from the HttpOnly cookie as a Bearer header, so the token
// never reaches JavaScript. Mutations are CSRF-checked. /v1/auth/* is NOT proxied — the session
// is managed only through /api/auth/* — with ONE exception (M4.5 W1): /v1/auth/mfa and
// /v1/auth/mfa/*, the signed-in user's own two-step-verification settings. They answer plain
// JSON and never carry a session token, so they ride this door with its CSRF check and refresh. A 401 is passed through untouched: refreshing is the
// client's single-flight job (F0.2-E), never this route's.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Only these backend response headers reach the browser — never a Set-Cookie.
// cache-control and content-security-policy pass too, so the ID-document view (M4.5 W2) keeps its no-store and sandbox.
const PASSED_RESPONSE_HEADERS = ["content-type", "content-disposition", "retry-after", "cache-control", "content-security-policy"];

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{8,200}$/;

/** The acted business id from the HttpOnly act-as cookie ({id,name} JSON), or null. */
function parseActAs(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  try {
    const value = JSON.parse(raw) as { id?: unknown };
    return typeof value.id === "string" && value.id !== "" ? value.id : null;
  } catch {
    return null;
  }
}

function backendUrl(segments: string[], search: string): string {
  if (segments.length === 0) throw new BffError(404, "NotFound", "Not found.");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new BffError(400, "BadRequest", "Invalid path.");
    }
  }
  if (segments[0].toLowerCase() === "auth" && segments[1] !== "mfa") {
    throw new BffError(404, "NotFound", "Not found. Authentication is handled by /api/auth/*.");
  }
  return `${apiBaseUrl()}/v1/${segments.map(encodeURIComponent).join("/")}${search}`;
}

async function forward(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return handle(async () => {
    const { path } = await context.params;
    const url = backendUrl(path, request.nextUrl.search);
    if (MUTATING.has(request.method)) assertCsrf(request);

    const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json" });
    const accessToken = request.cookies.get(SESSION_COOKIE)?.value;
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    const ip = clientIp(request);
    if (ip) headers.set("x-forwarded-for", ip);
    // The ONE request header passed through besides these (M4.5 W5): an idempotency key, so a console
    // job run sent twice is one run. Nothing else — the job trigger's machine secret in particular
    // never rides this door; that endpoint is not reachable with a session at all.
    const key = request.headers.get("idempotency-key");
    if (key !== null && IDEMPOTENCY_KEY.test(key)) headers.set("idempotency-key", key);
    // STANDING GOD-MODE (M4.5 W5): while a SUPER_ADMIN is acting as a business, forward its id so the
    // backend presents this call to the tenant routes as that business. The backend ignores it for a
    // non-SUPER_ADMIN, and it is never forwarded on an auth path.
    const actAs = parseActAs(request.cookies.get(ACT_AS_COOKIE)?.value);
    if (actAs !== null && path[0]?.toLowerCase() !== "auth") headers.set("x-act-as-tenant", actAs);

    let body: ArrayBuffer | undefined;
    if (request.method !== "GET") {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > 0) {
        body = buffer;
        headers.set("content-type", request.headers.get("content-type") ?? "application/json");
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(url, { method: request.method, headers, body, cache: "no-store", redirect: "manual" });
    } catch {
      throw new BffError(502, "BadGateway", "The Angaza360 service is unavailable.");
    }

    const responseHeaders = new Headers();
    for (const name of PASSED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const noBody = upstream.status === 204 || upstream.status === 304;
    return new NextResponse(noBody ? null : await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders,
    });
  });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
