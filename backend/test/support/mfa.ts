// ===========================================================================
// MFA helpers for the suite (M4.5 Wave 1).
//
// Since Wave 1 a SUPER_ADMIN or PROGRAM_OFFICER cannot sign in without a second factor,
// so the shared login helper (`accessTokenFor`) completes the staged login through the
// REAL HTTP routes: it enrols the account on its first login and proves a code on every
// later one. This file remembers each enrolled account's secret and backup codes, and
// hands out a code for a TOTP step that account has not used yet — the server accepts
// each step once (replay protection), so two logins inside one 30-second window take the
// next step, then fall back to a one-time backup code.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { totpCodeAt } from "../../src/services/identity/mfa";

const STEP_MS = 30_000;

interface Enrolled {
  readonly secret: string;
  lastStep: number;
  readonly backupCodes: string[];
}

const enrolled = new Map<string, Enrolled>();

export function rememberEnrollment(email: string, secret: string, backupCodes: readonly string[]): void {
  enrolled.set(email, { secret, lastStep: -1, backupCodes: [...backupCodes] });
}

export function enrollmentOf(email: string): Enrolled | undefined {
  return enrolled.get(email);
}

/** A code the server has not seen for this account: an unused TOTP step, else a backup code. */
export function freshCode(email: string): string {
  const entry = enrolled.get(email);
  if (entry === undefined) {
    throw new Error(`No MFA enrolment remembered for ${email}.`);
  }
  const current = Math.floor(Date.now() / STEP_MS);
  for (const step of [current, current + 1]) {
    if (step > entry.lastStep) {
      entry.lastStep = step;
      return totpCodeAt(entry.secret, step * STEP_MS);
    }
  }
  const backup = entry.backupCodes.shift();
  if (backup === undefined) {
    throw new Error(`Out of fresh MFA codes for ${email}.`);
  }
  return backup;
}

interface LoginBody {
  status?: string;
  accessToken?: string;
  challengeToken?: string;
  secret?: string;
  backupCodes?: string[];
  result?: LoginBody;
}

async function post(app: FastifyInstance, url: string, payload: Record<string, string>, remoteAddress: string): Promise<{ status: number; body: LoginBody; raw: string }> {
  const response = await app.inject({ method: "POST", url, remoteAddress, payload });
  return { status: response.statusCode, body: response.json<LoginBody>(), raw: response.body };
}

/**
 * Drives a login challenge to its session. Supports the MFA and enrolment stages; a
 * forced reset is a test's own business (it must choose the new password).
 */
export async function completeChallenge(
  app: FastifyInstance,
  email: string,
  first: LoginBody,
  remoteAddress: string,
): Promise<string> {
  let current: LoginBody = first;
  for (let guard = 0; guard < 4; guard += 1) {
    if (current.status === "AUTHENTICATED" && typeof current.accessToken === "string") {
      return current.accessToken;
    }
    const challengeToken = current.challengeToken;
    if (typeof challengeToken !== "string") {
      throw new Error(`login answered neither a session nor a challenge: ${JSON.stringify(current)}`);
    }
    if (current.status === "MFA_REQUIRED") {
      const next = await post(app, "/v1/auth/login/mfa", { challengeToken, code: freshCode(email) }, remoteAddress);
      if (next.status !== 200) throw new Error(`MFA stage failed with ${next.status.toString()}: ${next.raw}`);
      current = next.body;
      continue;
    }
    if (current.status === "MFA_ENROLLMENT_REQUIRED") {
      const start = await post(app, "/v1/auth/login/mfa-enrollment/start", { challengeToken }, remoteAddress);
      if (start.status !== 200 || typeof start.body.secret !== "string") {
        throw new Error(`enrolment start failed with ${start.status.toString()}: ${start.raw}`);
      }
      rememberEnrollment(email, start.body.secret, []);
      const confirm = await post(app, "/v1/auth/login/mfa-enrollment/confirm", { challengeToken, code: freshCode(email) }, remoteAddress);
      if (confirm.status !== 200 || confirm.body.result === undefined) {
        throw new Error(`enrolment confirm failed with ${confirm.status.toString()}: ${confirm.raw}`);
      }
      enrollmentOf(email)?.backupCodes.push(...(confirm.body.backupCodes ?? []));
      current = confirm.body.result;
      continue;
    }
    throw new Error(`login challenge ${String(current.status)} is not handled by the shared helper.`);
  }
  throw new Error("login challenge did not complete.");
}

let stepUpCounter = 0;

/** Each step-up from its own client address (the route is on the AUTH rate-limit tier). */
function stepUpIp(): string {
  stepUpCounter += 1;
  return `10.43.${Math.floor(stepUpCounter / 250).toString()}.${((stepUpCounter % 250) + 1).toString()}`;
}

/** A step-up on the session behind `token`, so a sensitive admin action is accepted. */
export async function stepUp(app: FastifyInstance, token: string, email: string): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/step-up",
    remoteAddress: stepUpIp(),
    headers: { authorization: `Bearer ${token}` },
    payload: { code: freshCode(email) },
  });
  if (response.statusCode !== 200) {
    throw new Error(`step-up failed with ${response.statusCode.toString()}: ${response.body}`);
  }
}
