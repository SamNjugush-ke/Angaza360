import { NextResponse, type NextRequest } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { handle } from "@/lib/auth/http";
import { readStringFields, relayRefusal, unreachable } from "@/lib/auth/public-relay";

export const runtime = "nodejs";

// Asks for a password-reset code. The backend answers the SAME 202 whether or not the email has
// an account, and so does this route — it adds no hint of its own. No session is involved.
export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const { email } = await readStringFields(request, ["email"]);
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/password/forgot", {
        body: { email: email ?? "" },
      });
    } catch {
      throw unreachable();
    }
    if (result.data) return NextResponse.json(result.data, { status: 202 });
    return relayRefusal(result.response.status, result.error, [400, 429]);
  });
}
