import { NextResponse, type NextRequest } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { handle } from "@/lib/auth/http";
import { readStringFields, relayRefusal, unreachable } from "@/lib/auth/public-relay";

export const runtime = "nodejs";

// Accepts an invitation: the backend creates the account with the invited role and business and
// signs nobody in, so this route sets no cookie and returns only the email the account uses.
export function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const { token } = await params;
    const { fullName, password } = await readStringFields(request, ["fullName", "password"]);
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/users/invitations/{token}/accept", {
        params: { path: { token } },
        body: { fullName: fullName ?? "", password: password ?? "" },
      });
    } catch {
      throw unreachable();
    }
    if (result.data) return NextResponse.json({ email: result.data.email }, { status: 201 });
    return relayRefusal(result.response.status, result.error, [400, 409, 429]);
  });
}
