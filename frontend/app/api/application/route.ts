import { type NextRequest, type NextResponse } from "next/server";
import { assertSameOrigin, assertSameOriginRead } from "@/lib/auth/csrf";
import { handle } from "@/lib/auth/http";
import { applicationToken, backend, readObject, relay, setApplicationCookie } from "@/lib/application/relay";

export const runtime = "nodejs";

/** Where the application open in this browser stands. */
export function GET(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOriginRead(request);
    return relay(await backend(request, "/applications/current", { method: "GET", token: applicationToken(request) }));
  });
}

/** Starts a draft; its access token goes into the HttpOnly cookie, never the response. */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const fields = await readObject(request);
    const upstream = await backend(request, "/applications", { method: "POST", json: fields });
    if (upstream.status !== 201) return relay(upstream);
    const body = (await upstream.json()) as { applicationId: string; accessToken: string };
    const response = await relay(new Response(JSON.stringify({ applicationId: body.applicationId }), { status: 201, headers: { "content-type": "application/json" } }));
    setApplicationCookie(response, body.accessToken);
    return response;
  });
}

/** Saves changes to the open application (a draft, or one sent back for changes). */
export function PATCH(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const fields = await readObject(request);
    return relay(await backend(request, "/applications/current", { method: "PATCH", token: applicationToken(request), json: fields }));
  });
}
