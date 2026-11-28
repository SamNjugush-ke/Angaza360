import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { isApiErrorBody } from "@/lib/api/errors";
import type { paths } from "@/lib/api/schema";
import { COOKIE_SECURE, setSession } from "./cookies";
import { BffError, errorResponse } from "./http";

// THE STAGED LOGIN (M4.5 Wave 1). A correct password that still owes a step — an MFA code, a
// forced new password, an administrator's MFA enrolment — answers with a single-use CHALLENGE.
// The challenge token is a bearer secret, so the browser never sees it: the BFF keeps it in an
// HttpOnly, SameSite=strict cookie scoped to the login routes (with the "keep me signed in"
// choice beside it), and the browser only learns WHICH step comes next. When the last step is
// done the BFF sets the session exactly as a plain login does and drops the challenge.

type BackendLoginResult = paths["/v1/auth/login"]["post"]["responses"][200]["content"]["application/json"];
type Authenticated = Extract<BackendLoginResult, { status: "AUTHENTICATED" }>;
export type ChallengeStatus = Exclude<BackendLoginResult["status"], "AUTHENTICATED">;

export const CHALLENGE_COOKIE = "ag_login_challenge";
/** Sent only to the login routes that spend it. */
export const CHALLENGE_COOKIE_PATH = "/api/auth/login";
const CHALLENGE_MAX_AGE_SECONDS = 600;

/** What the browser receives: the next step, or who signed in. Never a token. */
export type LoginStep =
  | { status: ChallengeStatus }
  | { status: "AUTHENTICATED"; user: Authenticated["user"]; role: Authenticated["user"]["role"]; tenant: Authenticated["tenant"] };

interface StoredChallenge {
  token: string;
  remember: boolean;
}

export function readChallenge(request: NextRequest): StoredChallenge | null {
  const raw = request.cookies.get(CHALLENGE_COOKIE)?.value;
  if (raw === undefined || raw === "") return null;
  const dot = raw.indexOf(".");
  if (dot !== 1) return null;
  const token = raw.slice(2);
  return token === "" ? null : { token, remember: raw.startsWith("1") };
}

function setChallenge(response: NextResponse, challenge: StoredChallenge): void {
  response.cookies.set(CHALLENGE_COOKIE, `${challenge.remember ? "1" : "0"}.${challenge.token}`, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    path: CHALLENGE_COOKIE_PATH,
    maxAge: CHALLENGE_MAX_AGE_SECONDS,
  });
}

export function clearChallenge(response: NextResponse): void {
  response.cookies.set(CHALLENGE_COOKIE, "", {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    path: CHALLENGE_COOKIE_PATH,
    maxAge: 0,
    expires: new Date(0),
  });
}

/** Turns a backend login result into the browser's answer, setting the session or the challenge. */
export function answerLogin(data: BackendLoginResult, remember: boolean, extra: Record<string, unknown> = {}): NextResponse {
  if (data.status === "AUTHENTICATED") {
    const body: LoginStep = { status: "AUTHENTICATED", user: data.user, role: data.user.role, tenant: data.tenant };
    const response = NextResponse.json({ ...extra, ...body }, { status: 200 });
    setSession(response, { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt, remember });
    clearChallenge(response);
    return response;
  }
  if (typeof data.challengeToken !== "string" || data.challengeToken === "") {
    throw new BffError(502, "BadGateway", "The sign-in service answered in an unexpected way.");
  }
  const response = NextResponse.json({ ...extra, status: data.status } satisfies Record<string, unknown>, { status: 200 });
  setChallenge(response, { token: data.challengeToken, remember });
  return response;
}

const EXPIRED = "Your sign-in has expired. Enter your email and password again.";

/** The stored challenge, or the one 401 that sends the browser back to the password step. */
export function requireChallenge(request: NextRequest): StoredChallenge {
  const challenge = readChallenge(request);
  if (challenge === null) throw new BffError(401, "ChallengeInvalid", EXPIRED);
  return challenge;
}

/**
 * Maps a backend refusal of a login STAGE. A dead challenge also drops the cookie, so the
 * browser starts again from the password.
 */
export function stageError(status: number, error: unknown): NextResponse {
  if (isApiErrorBody(error)) {
    if (status === 401 && error.error === "ChallengeInvalid") {
      const response = errorResponse(401, "ChallengeInvalid", EXPIRED);
      clearChallenge(response);
      return response;
    }
    if (status === 400 || status === 401 || status === 403 || status === 409 || status === 429) {
      return errorResponse(status, error.error, error.message);
    }
  }
  throw new BffError(502, "BadGateway", "The sign-in service is unavailable.");
}

/** Reads a JSON object body, or a 400. */
export async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new BffError(400, "BadRequest", "Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null) throw new BffError(400, "BadRequest", "Request body must be an object.");
  return body as Record<string, unknown>;
}
