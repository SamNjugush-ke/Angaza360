import { NextResponse, type NextRequest } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";
import { requireChallenge, stageError } from "@/lib/auth/login-challenge";

export const runtime = "nodejs";

// Login stage: start an administrator's required MFA enrolment. Answers the secret and its otpauth URI ONCE, for the QR code; the browser shows them and keeps them nowhere.
// Origin-checked like /login (there is no session yet, so no CSRF token); the challenge is read
// from its HttpOnly cookie, never from the browser's body.

export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const challenge = requireChallenge(request);
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/login/mfa-enrollment/start", {
        body: { challengeToken: challenge.token },
      });
    } catch {
      throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
    }
    if (result.data) {
      const response = NextResponse.json({ secret: result.data.secret, otpauthUri: result.data.otpauthUri }, { status: 200 });
      response.headers.set("cache-control", "no-store");
      return response;
    }
    return stageError(result.response.status, result.error);
  });
}
