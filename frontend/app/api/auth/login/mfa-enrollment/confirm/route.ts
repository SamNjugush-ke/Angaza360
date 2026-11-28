import { type NextRequest, type NextResponse } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";
import { answerLogin, readJsonObject, requireChallenge, stageError } from "@/lib/auth/login-challenge";

export const runtime = "nodejs";

// Login stage: confirm the enrolment with a code from the new app. Answers the ten backup codes ONCE beside the next step.
// Origin-checked like /login (there is no session yet, so no CSRF token); the challenge is read
// from its HttpOnly cookie, never from the browser's body.

export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const challenge = requireChallenge(request);
    const { code } = await readJsonObject(request);
    if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
      throw new BffError(400, "BadRequest", "Enter the 6-digit code your authenticator app shows.");
    }
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/login/mfa-enrollment/confirm", {
        body: { challengeToken: challenge.token, code: code.trim() },
      });
    } catch {
      throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
    }
    if (result.data) {
      const response = answerLogin(result.data.result, challenge.remember, { backupCodes: result.data.backupCodes });
      response.headers.set("cache-control", "no-store");
      return response;
    }
    return stageError(result.response.status, result.error);
  });
}
