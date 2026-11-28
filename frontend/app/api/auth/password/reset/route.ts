import { NextResponse, type NextRequest } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { handle } from "@/lib/auth/http";
import { readStringFields, relayRefusal, unreachable } from "@/lib/auth/public-relay";

export const runtime = "nodejs";

// Spends a reset code for a new password. The backend signs the account out everywhere and signs
// nobody in, so this route sets no cookie: the user signs in afterwards with the new password.
export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const { token, newPassword } = await readStringFields(request, ["token", "newPassword"]);
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/password/reset", {
        body: { token: token ?? "", newPassword: newPassword ?? "" },
      });
    } catch {
      throw unreachable();
    }
    if (result.response.status === 204) return new NextResponse(null, { status: 204 });
    return relayRefusal(result.response.status, result.error, [400, 429]);
  });
}
