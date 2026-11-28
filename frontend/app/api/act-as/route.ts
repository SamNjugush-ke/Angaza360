import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { ACT_AS_COOKIE, COOKIE_SECURE } from "@/lib/auth/cookies";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";
import { getSession } from "@/lib/auth/session";

// START / STOP acting as a business — standing god-mode (M4.5 W5). Sets (or clears) the HttpOnly
// act-as cookie that the data proxy forwards as x-act-as-tenant. The cookie is set ONLY for a
// verified SUPER_ADMIN session, so a lesser role can never grant itself the merchant workspace on
// the frontend (and the backend ignores the header for a non-SUPER_ADMIN regardless). The token
// never reaches JavaScript; this route only moves a cookie.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookieReader(request: NextRequest) {
  return {
    get(name: string) {
      const found = request.cookies.get(name);
      return found ? { value: found.value } : undefined;
    },
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const session = await getSession(cookieReader(request));
    if (session === null) throw new BffError(401, "Unauthorized", "Sign in again.");
    if (session.role !== "SUPER_ADMIN") throw new BffError(403, "Forbidden", "Only a super-administrator can act as a business.");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new BffError(400, "BadRequest", "Request body must be JSON.");
    }
    const record = (typeof body === "object" && body !== null ? body : {}) as { tenantId?: unknown; name?: unknown };
    const tenantId = typeof record.tenantId === "string" ? record.tenantId.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (tenantId === "") throw new BffError(400, "BadRequest", "tenantId is required.");

    const response = NextResponse.json({ ok: true });
    response.cookies.set(ACT_AS_COOKIE, JSON.stringify({ id: tenantId, name: name || tenantId }), {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
    });
    return response;
  });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(ACT_AS_COOKIE, "", { httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", path: "/", maxAge: 0, expires: new Date(0) });
    return response;
  });
}
