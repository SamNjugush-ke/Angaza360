// ===========================================================================
// Native TOTP multi-factor authentication (M4.5 Wave 1, T-B5).
//
// RFC 6238 TOTP through otplib (30-second steps, 6 digits, SHA-1 — what every
// authenticator app speaks). There is NO Firebase here: `users.authUid` stays the
// dormant Firebase seam it has always been, and nothing reads it.
//
// THE SECRET IS ENCRYPTED AT REST through the SAME AES-256-GCM cipher as the
// integration credentials (src/lib/crypto/credential-cipher.ts — ciphertext, iv,
// authTag, keyRef), and is NEVER returned by any API after enrolment begins. It leaves
// the server exactly once, at enrolment start, so the user can add it to their app
// (the otpauth URI the frontend renders as a QR code).
//
// BACKUP CODES are ten one-time codes, stored ONLY as their sha256 (like every bearer
// secret in this system) and burned on use — by a conditional update here and by the
// `mfa_backup_code_guard` trigger.
//
// REPLAY: a TOTP code is accepted for the current step and one either side (clock
// drift), every candidate compared in constant time, and the ACCEPTED STEP is claimed
// atomically — `mfaLastUsedStep` may only move forward (`user_mfa_step_guard`) — so a
// code, once used, can never be used again, even within its own 30 seconds.
//
// THIS MODULE IS THE ONLY WRITER of the users' mfa* columns and of mfa_backup_codes.
// ===========================================================================

import { randomInt, timingSafeEqual } from "node:crypto";
import { authenticator } from "otplib";
import { PRODUCT_NAME } from "../../config/brand";
import { decryptCredential, encryptCredential } from "../../lib/crypto/credential-cipher";
import { platformDb } from "../../db/platform";
import { mfaRequiredFor } from "../../auth/mfa-policy";
import { verifyPassword } from "../../auth/password";
import { revokeAllUserSessions } from "../../auth/tokens";
import { recordAudit, type PlatformTx } from "./audit";
import { hashSecretToken } from "./secret-token";

export { MFA_REQUIRED_ROLES, mfaRequiredFor } from "../../auth/mfa-policy";

const STEP_MS = 30_000;
const DRIFT_STEPS = 1;
const BACKUP_CODE_COUNT = 10;
// Crockford-style alphabet: no I, L, O, U — nothing to misread on paper.
const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const BACKUP_HALF = 5;

/** A refused second factor. ONE message for every reason — never which. */
export class InvalidMfaCodeError extends Error {
  constructor() {
    super("That code is not valid. Enter the current code from your authenticator app, or an unused backup code.");
    this.name = "InvalidMfaCodeError";
  }
}

export class MfaStateError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "MfaStateError";
    this.status = status;
  }
}

export interface MfaEnrollmentStart {
  /** Base32 secret — shown ONCE so it can be typed into an app; never returned again. */
  readonly secret: string;
  /** otpauth://totp/... — the frontend renders it as a QR code. */
  readonly otpauthUri: string;
}

interface StoredSecret {
  readonly totpSecret: string;
}

function encryptSecret(secret: string): {
  mfaSecretCiphertext: string;
  mfaSecretIv: string;
  mfaSecretAuthTag: string;
  mfaSecretKeyRef: string;
} {
  const blob = encryptCredential(JSON.stringify({ totpSecret: secret } satisfies StoredSecret));
  return {
    mfaSecretCiphertext: blob.ciphertext,
    mfaSecretIv: blob.iv,
    mfaSecretAuthTag: blob.authTag,
    mfaSecretKeyRef: blob.keyRef,
  };
}

interface EncryptedSecretColumns {
  readonly mfaSecretCiphertext: string | null;
  readonly mfaSecretIv: string | null;
  readonly mfaSecretAuthTag: string | null;
  readonly mfaSecretKeyRef: string | null;
}

function decryptSecret(row: EncryptedSecretColumns): string {
  if (row.mfaSecretCiphertext === null || row.mfaSecretIv === null || row.mfaSecretAuthTag === null || row.mfaSecretKeyRef === null) {
    throw new MfaStateError(409, "No authenticator is set up for this account.");
  }
  const plain = decryptCredential({
    ciphertext: row.mfaSecretCiphertext,
    iv: row.mfaSecretIv,
    authTag: row.mfaSecretAuthTag,
    keyRef: row.mfaSecretKeyRef,
  });
  const parsed: unknown = JSON.parse(plain);
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { totpSecret?: unknown }).totpSecret !== "string") {
    throw new Error("The stored MFA secret is not in the expected shape.");
  }
  return (parsed as StoredSecret).totpSecret;
}

const SECRET_SELECT = {
  id: true,
  email: true,
  role: true,
  tenantId: true,
  isActive: true,
  mfaEnabled: true,
  mfaEnrolledAt: true,
  mfaLastUsedStep: true,
  mfaSecretCiphertext: true,
  mfaSecretIv: true,
  mfaSecretAuthTag: true,
  mfaSecretKeyRef: true,
} as const;

// ---- TOTP ------------------------------------------------------------------------

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The TOTP step `code` matches (current step, or one either side), or null. EVERY
 * candidate is generated and compared in constant time — no early exit — so timing does
 * not say which step (if any) matched.
 */
export function matchTotpStep(secret: string, code: string, now: number = Date.now()): bigint | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const current = Math.floor(now / STEP_MS);
  let matched: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    const expected = authenticator.clone({ epoch: step * STEP_MS }).generate(secret);
    if (sameCode(expected, code) && matched === null) {
      matched = step;
    }
  }
  return matched === null ? null : BigInt(matched);
}

/** For tests and the enrolment screen's own check: the code an app shows at `now`. */
export function totpCodeAt(secret: string, now: number): string {
  return authenticator.clone({ epoch: Math.floor(now / STEP_MS) * STEP_MS }).generate(secret);
}

/** Claims `step` for the user: true only if no equal or later step was used before. */
async function claimTotpStep(db: PlatformTx, userId: string, step: bigint): Promise<boolean> {
  const claimed = await db.user.updateMany({
    where: { id: userId, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
    data: { mfaLastUsedStep: step },
  });
  return claimed.count === 1;
}

// ---- Backup codes ----------------------------------------------------------------

function randomBackupCode(): string {
  const pick = (): string => BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)] ?? "A";
  const half = (): string => Array.from({ length: BACKUP_HALF }, pick).join("");
  return `${half()}-${half()}`;
}

/** Upper-cases and drops spaces and hyphens, so "abcde fghjk" and "ABCDE-FGHJK" are one code. */
export function normalizeBackupCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

function hashBackupCode(code: string): string {
  return hashSecretToken(normalizeBackupCode(code));
}

async function issueBackupCodes(db: PlatformTx, userId: string): Promise<string[]> {
  await db.mfaBackupCode.deleteMany({ where: { userId } });
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) {
    codes.add(randomBackupCode());
  }
  const list = [...codes];
  await db.mfaBackupCode.createMany({ data: list.map((code) => ({ userId, codeHash: hashBackupCode(code) })) });
  return list;
}

// ---- Verification ----------------------------------------------------------------

export type SecondFactorMethod = "TOTP" | "BACKUP_CODE";

export interface VerifyContext {
  readonly ipAddress: string | null;
}

/**
 * Verifies a second factor for a user whose MFA is ON: a 6-digit TOTP (claimed against
 * replay) or an unused backup code (burned). Throws InvalidMfaCodeError otherwise.
 */
export async function verifySecondFactor(
  db: PlatformTx,
  userId: string,
  code: string,
  context: VerifyContext,
): Promise<SecondFactorMethod> {
  const user = await db.user.findUnique({ where: { id: userId }, select: SECRET_SELECT });
  if (user === null || !user.mfaEnabled || !user.isActive) {
    throw new InvalidMfaCodeError();
  }
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const step = matchTotpStep(decryptSecret(user), trimmed);
    if (step === null || !(await claimTotpStep(db, user.id, step))) {
      throw new InvalidMfaCodeError();
    }
    return "TOTP";
  }
  const normalized = normalizeBackupCode(trimmed);
  if (normalized.length !== BACKUP_HALF * 2) {
    throw new InvalidMfaCodeError();
  }
  const burned = await db.mfaBackupCode.updateMany({
    where: { userId: user.id, codeHash: hashBackupCode(normalized), usedAt: null },
    data: { usedAt: new Date() },
  });
  if (burned.count !== 1) {
    throw new InvalidMfaCodeError();
  }
  const remaining = await db.mfaBackupCode.count({ where: { userId: user.id, usedAt: null } });
  await recordAudit(db, {
    action: "MFA_BACKUP_CODE_USED",
    actorUserId: user.id,
    targetUserId: user.id,
    tenantId: user.tenantId,
    ipAddress: context.ipAddress,
    metadata: { remaining },
  });
  return "BACKUP_CODE";
}

// ---- Enrolment -------------------------------------------------------------------

/**
 * Starts (or restarts) enrolment for a user whose MFA is OFF: a fresh secret, stored
 * encrypted but not yet active. Restarting replaces an unconfirmed secret. Refused while
 * MFA is ON — a second authenticator replaces the first only through a reset.
 */
export async function beginMfaEnrollment(db: PlatformTx, userId: string): Promise<MfaEnrollmentStart> {
  const user = await db.user.findUnique({ where: { id: userId }, select: SECRET_SELECT });
  if (user === null || !user.isActive) {
    throw new MfaStateError(404, "No such account.");
  }
  if (user.mfaEnabled) {
    throw new MfaStateError(409, "Two-step verification is already on for this account.");
  }
  const secret = authenticator.generateSecret(20);
  await db.user.update({
    where: { id: user.id },
    data: { ...encryptSecret(secret), mfaLastUsedStep: null },
  });
  return { secret, otpauthUri: authenticator.keyuri(user.email, PRODUCT_NAME, secret) };
}

/**
 * Confirms enrolment with a code from the new authenticator: MFA goes ON, ten backup
 * codes are issued (returned ONCE, stored hashed) and the enrolment is audited.
 */
export async function confirmMfaEnrollment(
  db: PlatformTx,
  userId: string,
  code: string,
  context: VerifyContext,
): Promise<string[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: SECRET_SELECT });
  if (user === null || !user.isActive) {
    throw new MfaStateError(404, "No such account.");
  }
  if (user.mfaEnabled) {
    throw new MfaStateError(409, "Two-step verification is already on for this account.");
  }
  if (user.mfaSecretCiphertext === null) {
    throw new MfaStateError(409, "Start setting up your authenticator first.");
  }
  const step = matchTotpStep(decryptSecret(user), code.trim());
  if (step === null || !(await claimTotpStep(db, user.id, step))) {
    throw new InvalidMfaCodeError();
  }
  await db.user.update({ where: { id: user.id }, data: { mfaEnabled: true, mfaEnrolledAt: new Date() } });
  const codes = await issueBackupCodes(db, user.id);
  await recordAudit(db, {
    action: "MFA_ENROLLED",
    actorUserId: user.id,
    targetUserId: user.id,
    tenantId: user.tenantId,
    ipAddress: context.ipAddress,
  });
  return codes;
}

// ---- Management (authenticated) ----------------------------------------------------

export interface MfaStatus {
  readonly enabled: boolean;
  readonly required: boolean;
  readonly enrolledAt: Date | null;
  readonly backupCodesRemaining: number;
}

export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const user = await platformDb.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true, mfaEnabled: true, mfaEnrolledAt: true },
  });
  const remaining = user.mfaEnabled
    ? await platformDb.mfaBackupCode.count({ where: { userId, usedAt: null } })
    : 0;
  return {
    enabled: user.mfaEnabled,
    required: mfaRequiredFor(user.role),
    enrolledAt: user.mfaEnrolledAt,
    backupCodesRemaining: remaining,
  };
}

/** Replaces the user's backup codes, after a fresh second factor. */
export async function regenerateBackupCodes(userId: string, code: string, context: VerifyContext): Promise<string[]> {
  return platformDb.$transaction(async (tx) => {
    await verifySecondFactor(tx, userId, code, context);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
    const codes = await issueBackupCodes(tx, userId);
    await recordAudit(tx, {
      action: "MFA_BACKUP_CODES_REGENERATED",
      actorUserId: userId,
      targetUserId: userId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
    });
    return codes;
  });
}

const CLEARED_MFA = {
  mfaEnabled: false,
  mfaEnrolledAt: null,
  mfaLastUsedStep: null,
  mfaSecretCiphertext: null,
  mfaSecretIv: null,
  mfaSecretAuthTag: null,
  mfaSecretKeyRef: null,
} as const;

/**
 * A user turns their OWN opt-in MFA off, with their password AND a second factor. An
 * administrator can never turn it off: for them it is not optional.
 */
export async function disableOwnMfa(
  userId: string,
  input: { currentPassword: string; code: string },
  context: VerifyContext,
): Promise<void> {
  const user = await platformDb.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true, passwordHash: true, mfaEnabled: true, tenantId: true },
  });
  if (mfaRequiredFor(user.role)) {
    throw new MfaStateError(403, "Two-step verification is required for your role and cannot be turned off.");
  }
  if (!user.mfaEnabled) {
    throw new MfaStateError(409, "Two-step verification is not on.");
  }
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new InvalidMfaCodeError();
  }
  await platformDb.$transaction(async (tx) => {
    await verifySecondFactor(tx, userId, input.code, context);
    await tx.mfaBackupCode.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: CLEARED_MFA });
    await recordAudit(tx, {
      action: "MFA_DISABLED",
      actorUserId: userId,
      targetUserId: userId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
    });
  });
}

/**
 * ADMIN-ASSISTED RECOVERY: clears a user's MFA (secret, backup codes, replay step) so they
 * enrol again at their next login, and signs them out everywhere. Exposes no secret.
 * Authorisation (who may do this to whom) is the caller's — see user-management.ts.
 */
export async function clearMfaWithinTransaction(tx: PlatformTx, userId: string): Promise<void> {
  await tx.mfaBackupCode.deleteMany({ where: { userId } });
  await tx.user.update({ where: { id: userId }, data: CLEARED_MFA });
}

export async function signOutEverywhere(userId: string): Promise<void> {
  await revokeAllUserSessions(userId);
}

// ---- Step-up ---------------------------------------------------------------------

/**
 * A fresh second factor on an EXISTING MFA-verified session, for a sensitive action:
 * stamps `sessions.stepUpAt`. The action checks the stamp is recent (requireStepUp).
 */
export async function stepUpSession(
  userId: string,
  sessionId: string,
  code: string,
  context: VerifyContext,
): Promise<Date> {
  return platformDb.$transaction(async (tx) => {
    const session = await tx.session.findUnique({ where: { id: sessionId }, select: { userId: true, mfaVerifiedAt: true, revokedAt: true } });
    if (session === null || session.userId !== userId || session.revokedAt !== null) {
      throw new MfaStateError(404, "No such session.");
    }
    if (session.mfaVerifiedAt === null) {
      throw new MfaStateError(409, "This session was not opened with two-step verification. Sign in again with your code first.");
    }
    const method = await verifySecondFactor(tx, userId, code, context);
    const now = new Date();
    await tx.session.update({ where: { id: sessionId }, data: { stepUpAt: now } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
    await recordAudit(tx, {
      action: "MFA_STEP_UP",
      actorUserId: userId,
      targetUserId: userId,
      tenantId: user.tenantId,
      ipAddress: context.ipAddress,
      metadata: { method },
    });
    return now;
  });
}
