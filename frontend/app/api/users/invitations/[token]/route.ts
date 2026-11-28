import { NextResponse, type NextRequest } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOriginRead } from "@/lib/auth/csrf";
import { handle } from "@/lib/auth/http";
import { relayRefusal, unreachable } from "@/lib/auth/public-relay";

export const runtime = "nodejs";

// What an invitation offers — the invited email, the role and the business — for the accept page.
// The token in the path is the invitation's own single-use secret: passed to the backend, never
// stored or echoed. A used, revoked or expired invitation is the backend's one 400.
export function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  return handle(async () => {
    assertSameOriginRead(request);
    const { token } = await params;
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).GET("/v1/users/invitations/{token}", {
        params: { path: { token } },
      });
    } catch {
      throw unreachable();
    }
    if (result.data) {
      const { email, role, businessName, expiresAt } = result.data;
      return NextResponse.json({ email, role, businessName, expiresAt }, { status: 200, headers: { "cache-control": "no-store" } });
    }
    return relayRefusal(result.response.status, result.error, [400, 429]);
  });
}
