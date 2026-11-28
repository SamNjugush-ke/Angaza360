// ===========================================================================
// The staged login (M4.5 Wave 1): MFA, forced reset on first login, admin enrolment.
//
// A correct password no longer always means a session. It means a session ONLY when the
// account owes nothing else. Otherwise it means a LOGIN CHALLENGE — a single-use bearer
// secret (stored as its sha256, like every other one), valid for
// LOGIN_CHALLENGE_TTL_MINUTES — that the client spends, stage by stage, in this order:
//
//   1. MFA_REQUIRED           the account has MFA on: a TOTP or an unused backup code
//   2. PASSWORD_RESET_REQUIRED mustResetPassword: a new password before ANY access
//   3. MFA_ENROLLMENT_REQUIRED a SUPER_ADMIN / PROGRAM_OFFICER without MFA: enrol now
//
// Only when every stage is cleared does the challenge become a session — stamped
// `mfaVerifiedAt` when a factor was proven, which is what the database demands of every
// admin session (`session_mfa_guard`). A challenge's stages can only be cleared, never
// re-opened (`login_challenge_guard`); every stage runs under a row lock, so one
// challenge can never become two sessions.
//
// BRUTE FORCE: a wrong code counts against the challenge; at
// LOGIN_CHALLENGE_MAX_ATTEMPTS it is burned and the user must start again with their
// password (which is itself rate-limited). The stage routes are on the AUTH tier too.
// Every refusal — unknown, expired, burned, consumed, wrong stage — is the SAME 401.
// ===========================================================================

import { assertPasswordPolicy, hashPassword, verifyPassword } from "../../auth/password";
import { revokeAllUserSessions } from "../../auth/tokens";
import { mfaRequiredFor } from "../../auth/mfa-policy";
import { env } from "../../config/env";
import { platformDb } from "../../db/platform";
import type { UserRole } from "../../generated/platform/enums";
import { recordAudit, type PlatformTx } from "./audit";
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  InvalidMfaCodeError,
  verifySecondFactor,
  type MfaEnrollmentStart,
} from "./mfa";
import { hashSecretToken, issueSecretToken } from "./secret-token";

export type ChallengeStage = "MFA_REQUIRED" | "PASSWORD_RESET_REQUIRED" | "MFA_ENROLLMENT_REQUIRED";

/** The ONE answer for any challenge that cannot be used — never which reason. */
export class InvalidChallengeError extends Error {
  constructor() {
    super("This sign-in has expired or is no longer valid. Sign in again with your password.");
    this.name = "InvalidChallengeError";
  }
}

export class ChallengePasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChallengePasswordError";
  }
}

export interface LoginUser {
  readonly id: string;
  readonly role: UserRole;
  readonly tenantId: string | null;
  readonly mfaEnabled: boolean;
  readonly mustResetPassword: boolean;
}

export interface IssuedChallenge {
  readonly status: ChallengeStage;
  readonly challengeToken: string;
  readonly expiresAt: Date;
}

/** Every stage done: the route issues the session, with this factor stamp. */
export interface CompletedLogin {
  readonly status: "COMPLETE";
  readonly userId: string;
  readonly mfaVerifiedAt: Date | null;
}

/** What a stage leads to: the next stage of the SAME challenge, or the session. */
export type StageOutcome = { readonly status: ChallengeStage; readonly challengeToken: string; readonly expiresAt: Date } | CompletedLogin;

interface ChallengeRow {
  id: string;
  userId: string;
  needsMfa: boolean;
  needsPasswordReset: boolean;
  needsMfaEnrollment: boolean;
  mfaVerified: boolean;
  failedAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

function nextStage(row: Pick<ChallengeRow, "needsMfa" | "needsPasswordReset" | "needsMfaEnrollment">): ChallengeStage | null {
  if (row.needsMfa) return "MFA_REQUIRED";
  if (row.needsPasswordReset) return "PASSWORD_RESET_REQUIRED";
  if (row.needsMfaEnrollment) return "MFA_ENROLLMENT_REQUIRED";
  return null;
}

/**
 * Called after a CORRECT password for an ACTIVE user. Returns null when the account owes
 * nothing (the route issues a session as it always has), otherwise a challenge.
 */
export async function beginLogin(user: LoginUser, ipAddress: string | null): Promise<IssuedChallenge | null> {
  const needsMfa = user.mfaEnabled;
  const needsMfaEnrollment = !user.mfaEnabled && mfaRequiredFor(user.role);
  const needsPasswordReset = user.mustResetPassword;
  if (!needsMfa && !needsMfaEnrollment && !needsPasswordReset) {
    return null;
  }
  const token = issueSecretToken();
  const expiresAt = new Date(Date.now() + env.loginChallengeTtlMinutes * 60_000);
  await platformDb.loginChallenge.create({
    data: { userId: user.id, tokenHash: token.hash, needsMfa, needsPasswordReset, needsMfaEnrollment, expiresAt, ipAddress },
  });
  const status = nextStage({ needsMfa, needsPasswordReset, needsMfaEnrollment });
  if (status === null) {
    throw new Error("unreachable: a challenge always owes a stage");
  }
  return { status, challengeToken: token.raw, expiresAt };
}

/** Locks and validates the challenge for `stage`; anything wrong is the one 401. */
async function lockChallenge(tx: PlatformTx, rawToken: string, stage: ChallengeStage): Promise<ChallengeRow> {
  const tokenHash = hashSecretToken(rawToken);
  const rows = await tx.$queryRaw<ChallengeRow[]>`
    SELECT "id", "userId", "needsMfa", "needsPasswordReset", "needsMfaEnrollment", "mfaVerified",
           "failedAttempts", "expiresAt", "consumedAt"
      FROM public."login_challenges" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
  const row = rows[0];
  if (row === undefined || row.consumedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw new InvalidChallengeError();
  }
  if (row.failedAttempts >= env.loginChallengeMaxAttempts || nextStage(row) !== stage) {
    throw new InvalidChallengeError();
  }
  const user = await tx.user.findUnique({ where: { id: row.userId }, select: { isActive: true } });
  if (user === null || !user.isActive) {
    throw new InvalidChallengeError();
  }
  return row;
}

/** After a stage: the next stage, or — every stage cleared — consume and complete. */
async function advance(
  tx: PlatformTx,
  row: ChallengeRow,
  rawToken: string,
  cleared: Partial<Pick<ChallengeRow, "needsMfa" | "needsPasswordReset" | "needsMfaEnrollment" | "mfaVerified">>,
): Promise<StageOutcome> {
  const after = { ...row, ...cleared };
  const stage = nextStage(after);
  await tx.loginChallenge.update({
    where: { id: row.id },
    data: { ...cleared, ...(stage === null ? { consumedAt: new Date() } : {}) },
  });
  if (stage !== null) {
    return { status: stage, challengeToken: rawToken, expiresAt: row.expiresAt };
  }
  return { status: "COMPLETE", userId: row.userId, mfaVerifiedAt: after.mfaVerified ? new Date() : null };
}

/**
 * Records a wrong code against the challenge, OUTSIDE the refused attempt's own
 * transaction (which rolls back), and burns the challenge at the attempt limit.
 */
async function recordFailedAttempt(rawToken: string, ipAddress: string | null): Promise<void> {
  const tokenHash = hashSecretToken(rawToken);
  await platformDb.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ChallengeRow[]>`
      SELECT "id", "userId", "failedAttempts", "consumedAt" FROM public."login_challenges"
       WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const row = rows[0];
    if (row === undefined || row.consumedAt !== null) {
      return;
    }
    const attempts = row.failedAttempts + 1;
    const burn = attempts >= env.loginChallengeMaxAttempts;
    await tx.loginChallenge.update({
      where: { id: row.id },
      data: { failedAttempts: attempts, ...(burn ? { consumedAt: new Date() } : {}) },
    });
    const user = await tx.user.findUnique({ where: { id: row.userId }, select: { tenantId: true } });
    await recordAudit(tx, {
      action: "MFA_CHALLENGE_FAILED",
      actorUserId: null,
      targetUserId: row.userId,
      tenantId: user?.tenantId ?? null,
      ipAddress,
      metadata: { attempts, burned: burn },
    });
  });
}

// ---- Stage 1: MFA ---------------------------------------------------------------

export async function completeMfaStage(rawToken: string, code: string, ipAddress: string | null): Promise<StageOutcome> {
  try {
    return await platformDb.$transaction(async (tx) => {
      const row = await lockChallenge(tx, rawToken, "MFA_REQUIRED");
      await verifySecondFactor(tx, row.userId, code, { ipAddress });
      return advance(tx, row, rawToken, { needsMfa: false, mfaVerified: true });
    });
  } catch (error) {
    if (error instanceof InvalidMfaCodeError) {
      await recordFailedAttempt(rawToken, ipAddress);
    }
    throw error;
  }
}

// ---- Stage 2: forced new password ------------------------------------------------

export async function completePasswordStage(rawToken: string, newPassword: string, ipAddress: string | null): Promise<StageOutcome> {
  try {
    assertPasswordPolicy(newPassword);
  } catch (error) {
    throw new ChallengePasswordError(error instanceof Error ? error.message : "Password does not meet policy.");
  }
  const passwordHash = await hashPassword(newPassword);
  const outcome = await platformDb.$transaction(async (tx) => {
    const row = await lockChallenge(tx, rawToken, "PASSWORD_RESET_REQUIRED");
    const user = await tx.user.findUniqueOrThrow({ where: { id: row.userId }, select: { passwordHash: true, tenantId: true } });
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new ChallengePasswordError("Choose a new password — not the one you were given.");
    }
    await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash, passwordUpdatedAt: new Date(), mustResetPassword: false },
    });
    await recordAudit(tx, {
      action: "PASSWORD_FORCED_RESET_COMPLETED",
      actorUserId: row.userId,
      targetUserId: row.userId,
      tenantId: user.tenantId,
      ipAddress,
    });
    return { userId: row.userId, next: await advance(tx, row, rawToken, { needsPasswordReset: false }) };
  });
  // Whoever held the issued password holds no session any more.
  await revokeAllUserSessions(outcome.userId);
  return outcome.next;
}

// ---- Stage 3: admin MFA enrolment ------------------------------------------------

export async function startEnrollmentStage(rawToken: string): Promise<MfaEnrollmentStart> {
  return platformDb.$transaction(async (tx) => {
    const row = await lockChallenge(tx, rawToken, "MFA_ENROLLMENT_REQUIRED");
    return beginMfaEnrollment(tx, row.userId);
  });
}

export async function confirmEnrollmentStage(
  rawToken: string,
  code: string,
  ipAddress: string | null,
): Promise<{ backupCodes: string[]; next: StageOutcome }> {
  try {
    return await platformDb.$transaction(async (tx) => {
      const row = await lockChallenge(tx, rawToken, "MFA_ENROLLMENT_REQUIRED");
      const backupCodes = await confirmMfaEnrollment(tx, row.userId, code, { ipAddress });
      const next = await advance(tx, row, rawToken, { needsMfaEnrollment: false, mfaVerified: true });
      return { backupCodes, next };
    });
  } catch (error) {
    if (error instanceof InvalidMfaCodeError) {
      await recordFailedAttempt(rawToken, ipAddress);
    }
    throw error;
  }
}
