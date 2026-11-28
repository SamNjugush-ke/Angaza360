import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { apiBaseUrl } from "@/lib/api/config";
import { clientIp } from "@/lib/api/forwarding";
import { COOKIE_SECURE } from "@/lib/auth/cookies";
import { BffError } from "@/lib/auth/http";

// THE APPLICANT'S BFF (M4.5 Wave 2). A business application is opened by its ACCESS TOKEN — a
// bearer secret the backend stores only as a hash. In the browser it lives in ONE HttpOnly,
// SameSite=strict cookie scoped to /api/application, so page JavaScript never holds it: the
// application form gets it when it starts a draft, and the status link (whose token rides in
// the URL fragment, which no server sees) hands it over ONCE to /api/application/open. Every
// route here is Origin-checked and forwards the user's address; none starts a session.

export const APPLICATION_COOKIE = "ag_application";
const COOKIE_PATH = "/api/application";
const NINETY_DAYS = 90 * 24 * 60 * 60;

export const UNAVAILABLE = "The service is temporarily unavailable. Please try again shortly.";

export function applicationToken(request: NextRequest): string {
  const token = request.cookies.get(APPLICATION_COOKIE)?.value;
  if (!token) throw new BffError(404, "NotFound", "No application is open in this browser. Use the link we emailed you, or start a new application.");
  return token;
}

export function setApplicationCookie(response: NextResponse, token: string): void {
  response.cookies.set(APPLICATION_COOKIE, token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", path: COOKIE_PATH, maxAge: NINETY_DAYS });
}

export function clearApplicationCookie(response: NextResponse): void {
  response.cookies.set(APPLICATION_COOKIE, "", { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", path: COOKIE_PATH, maxAge: 0, expires: new Date(0) });
}

/** One call to the backend's /v1/public, with the token header when there is one. */
export async function backend(request: NextRequest, path: string, init: { method: string; token?: string; json?: unknown; raw?: { body: ArrayBuffer; contentType: string } }): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  const ip = clientIp(request);
  if (ip) headers.set("x-forwarded-for", ip);
  if (init.token) headers.set("x-application-token", init.token);
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  } else if (init.raw) {
    headers.set("content-type", init.raw.contentType);
    body = init.raw.body;
  }
  try {
    return await fetch(`${apiBaseUrl()}/v1/public${path}`, { method: init.method, headers, body, cache: "no-store", redirect: "manual" });
  } catch {
    throw new BffError(502, "BadGateway", UNAVAILABLE);
  }
}

/** The backend's answer passed through as JSON (its 400 carries the field errors), or a 502. */
export async function relay(upstream: Response, passThrough: readonly number[] = [400, 404, 409, 413, 415, 429]): Promise<NextResponse> {
  if (upstream.status === 204) return new NextResponse(null, { status: 204 });
  if (upstream.ok || passThrough.includes(upstream.status)) {
    const body: unknown = await upstream.json().catch(() => null);
    if (body !== null) {
      const response = NextResponse.json(body, { status: upstream.status });
      response.headers.set("cache-control", "no-store");
      return response;
    }
  }
  throw new BffError(502, "BadGateway", UNAVAILABLE);
}

/** A JSON object body, or a 400. */
export async function readObject(request: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BffError(400, "BadRequest", "Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BffError(400, "BadRequest", "Request body must be an object.");
  return body as Record<string, unknown>;
}
