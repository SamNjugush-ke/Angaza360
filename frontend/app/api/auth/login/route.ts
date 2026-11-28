import { NextResponse, type NextRequest } from "next/server";
import { createApiClient } from "@/lib/api/client";
import { forwardingHeaders } from "@/lib/api/forwarding";
import { isApiErrorBody } from "@/lib/api/errors";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { BffError, errorResponse, handle } from "@/lib/auth/http";
import { answerLogin, type LoginStep } from "@/lib/auth/login-challenge";

export const runtime = "nodejs";

/**
 * What the browser receives: who signed in — or, since M4.5 Wave 1, which login step comes next
 * (MFA_REQUIRED, PASSWORD_RESET_REQUIRED, MFA_ENROLLMENT_REQUIRED). Never a token.
 */
export type LoginResult = LoginStep;

const GENERIC_LOGIN_FAILURE = "Invalid email or password.";

interface LoginBody {
  email: string;
  password: string;
  remember: boolean;
}

async function readBody(request: NextRequest): Promise<LoginBody> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BffError(400, "BadRequest", "Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null) throw new BffError(400, "BadRequest", "Request body must be an object.");
  const { email, password, remember } = body as Record<string, unknown>;
  if (typeof email !== "string" || email.length === 0 || typeof password !== "string" || password.length === 0) {
    throw new BffError(400, "BadRequest", "email and password are required.");
  }
  if (remember !== undefined && typeof remember !== "boolean") {
    throw new BffError(400, "BadRequest", "remember must be a boolean.");
  }
  return { email, password, remember: remember === true };
}

// Login is exempt from the CSRF token (no session, so no token exists yet) but keeps the Origin
// check, which stops a cross-site page from signing a browser into an attacker's account.
export function POST(request: NextRequest): Promise<NextResponse> {
  return handle(async () => {
    assertSameOrigin(request);
    const { email, password, remember } = await readBody(request);

    let result;
    try {
      result = await createApiClient({ headers: forwardingHeaders(request) }).POST("/v1/auth/login", { body: { email, password } });
    } catch {
      throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
    }

    const { data, error, response: upstream } = result;
    if (data) {
      return answerLogin(data, remember);
    }
    if (upstream.status === 401) {
      return errorResponse(401, "Unauthorized", isApiErrorBody(error) ? error.message : GENERIC_LOGIN_FAILURE);
    }
    if ((upstream.status === 400 || upstream.status === 403 || upstream.status === 429) && isApiErrorBody(error)) {
      return errorResponse(upstream.status, error.error, error.message);
    }
    throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
  });
}
