import { type NextRequest, type NextResponse } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, handle } from "@/lib/auth/http";
import { answerLogin, readJsonObject, requireChallenge, stageError } from "@/lib/auth/login-challenge";

export const runtime = "nodejs";

// Login stage: the forced new password (seeded or administrator-reset accounts).
// Origin-checked like /login (there is no session yet, so no CSRF token); the challenge is read
// from its HttpOnly cookie, never from the browser's body.

export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const challenge = requireChallenge(request);
    const { newPassword } = await readJsonObject(request);
    if (typeof newPassword !== "string" || newPassword.length === 0) {
      throw new BffError(400, "BadRequest", "Choose a new password.");
    }
    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/login/password", {
        body: { challengeToken: challenge.token, newPassword },
      });
    } catch {
      throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
    }
    if (result.data) return answerLogin(result.data, challenge.remember);
    return stageError(result.response.status, result.error);
  });
}
