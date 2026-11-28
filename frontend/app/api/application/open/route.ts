import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";
import { backend, readObject, relay, setApplicationCookie } from "@/lib/application/relay";

export const runtime = "nodejs";

// The status link's token, handed over ONCE: checked with the backend, then kept only in the
// HttpOnly cookie. The page drops it from the address bar straight after.
export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const { token } = await readObject(request);
    if (typeof token !== "string" || token.length < 16 || token.length > 200) {
      throw new BffError(400, "BadRequest", "That link is not complete. Open it again from the email.");
    }
    const upstream = await backend(request, "/applications/current", { method: "GET", token });
    if (upstream.status !== 200) return relay(upstream);
    const response = new NextResponse(null, { status: 204 });
    setApplicationCookie(response, token);
    return response;
  });
}
