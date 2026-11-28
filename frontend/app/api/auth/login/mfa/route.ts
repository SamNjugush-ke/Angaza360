import { type NextRequest, type NextResponse } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";
import { answerLogin, readJsonObject, requireChallenge, stageError } from "@/lib/auth/login-challenge";

export const runtime = "nodejs";

// Login stage: prove the second factor (a 6-digit authenticator code or a backup code).
// Origin-checked like /login (there is no session yet, so no CSRF token); the challenge is read
// from its HttpOnly cookie, never from the browser's body.

export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const challenge = requireChallenge(request);
    const { code } = await readJsonObject(request);
    if (typeof code !== "string" || code.trim().length < 6) {
      throw new BffError(400, "BadRequest", "Enter the 6-digit code from your authenticator app, or a backup code.");
    }
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/login/mfa", {
        body: { challengeToken: challenge.token, code: code.trim() },
      });
    } catch {
      throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
    }
    if (result.data) return answerLogin(result.data, challenge.remember);
    return stageError(result.response.status, result.error);
  });
}
