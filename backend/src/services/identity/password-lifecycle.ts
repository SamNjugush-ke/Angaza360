// ===========================================================================
// Account recovery + the password lifecycle (Task T-A4).
//
// THREE OPERATIONS, each audited:
//
//   requestPasswordReset  PUBLIC, ENUMERATION-SAFE. The caller learns NOTHING about
//                         whether the email belongs to an account: the route answers
//                         the same 202 either way, a miss does comparable work (a
//                         token is still generated and hashed, an audit row is still
//                         written), and delivery runs OFF the request path so provider
//                         latency cannot tell a hit from a miss.
//   resetPassword         PUBLIC. Consumes a valid, unexpired, unused token — ONCE —
//                         sets the new password, invalidates every other open token of
//                         the user and revokes ALL their sessions. No auto-login.
//   changePassword        AUTHENTICATED. Requires the CURRENT password, sets the new
//                         one and revokes every OTHER session (the caller's own stays).
//
// A reset token is stored only as its sha256 hex (./secret-token.ts); the raw value
// goes to its owner through the notification channel (T-A3) and nowhere else. Its
// single use is held twice: by the conditional consume below and by the
// `password_reset_token_guard` trigger, which refuses to touch a used token.
//
// Users are platform rows (public.users), so this module touches no tenant schema.
// ===========================================================================

import { assertPasswordPolicy, hashPassword, verifyPassword } from "../../auth/password";
import { revokeAllUserSessions } from "../../auth/tokens";
import { env } from "../../config/env";
import { platformDb } from "../../db/platform";
import { sendNotification, type NotificationOutcome } from "../notifications/notification-service";
import { recordAudit } from "./audit";
import { hashSecretToken, issueSecretToken } from "./secret-token";

/** The one answer for an unknown, expired or already-used reset code — never which. */
export class InvalidResetTokenError extends Error {
  constructor() {
    super("This reset code is invalid or has expired. Request a new one.");
    this.name = "InvalidResetTokenError";
  }
}

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

export class CurrentPasswordIncorrectError extends Error {
  constructor() {
    super("The current password is incorrect.");
    this.name = "CurrentPasswordIncorrectError";
  }
}

function enforcePolicy(plain: string): void {
  try {
    assertPasswordPolicy(plain);
  } catch (error) {
    throw new PasswordPolicyError(error instanceof Error ? error.message : "Password does not meet policy.");
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---- Request ---------------------------------------------------------------

export interface PasswordResetRequest {
  readonly email: string;
  readonly ipAddress: string | null;
}

export interface PasswordResetRequested {
  /**
   * The off-request delivery of the code, or null when there was no account to send
   * it to. The ROUTE must not await it or let it change the response.
   */
  readonly delivery: Promise<NotificationOutcome[]> | null;
}

export async function requestPasswordReset(request: PasswordResetRequest): Promise<PasswordResetRequested> {
  const email = normalizeEmail(request.email);
  const user = await platformDb.user.findUnique({
    where: { email },
    select: { id: true, fullName: true, phone: true, tenantId: true, isActive: true },
  });
  // A token is issued (and hashed) on EVERY request, so a hit and a miss do the same
  // cryptographic work; only a hit stores it.
  const token = issueSecretToken();

  if (user === null || !user.isActive) {
    await recordAudit(platformDb, {
      action: "PASSWORD_RESET_REQUESTED",
      actorUserId: null,
      targetUserId: null,
      tenantId: null,
      ipAddress: request.ipAddress,
      metadata: { email, matched: false },
    });
    return { delivery: null };
  }

  const expiresAt = new Date(Date.now() + env.passwordResetTtlMinutes * 60_000);
  const created = await platformDb.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: token.hash, expiresAt },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "PASSWORD_RESET_REQUESTED",
      actorUserId: null,
      targetUserId: user.id,
      tenantId: user.tenantId,
      ipAddress: request.ipAddress,
      metadata: { email, matched: true },
    });
    return row;
  });

  // The same single code goes to the account's email and — SMS being first-class — to
  // its phone when one is on file. Either delivered copy redeems it, once.
  const template = {
    key: "password-reset" as const,
    fullName: user.fullName,
    token: token.raw,
    expiresInMinutes: env.passwordResetTtlMinutes,
  };
  const related = { type: "PasswordResetToken", id: created.id };
  const sends = [sendNotification({ channel: "EMAIL", to: email, template, related })];
  if (user.phone !== null) {
    sends.push(sendNotification({ channel: "SMS", to: user.phone, template, related }));
  }
  const delivery = Promise.all(sends);
  return { delivery };
}

// ---- Reset -----------------------------------------------------------------

export interface PasswordResetInput {
  readonly token: string;
  readonly newPassword: string;
  readonly ipAddress: string | null;
}

export async function resetPassword(input: PasswordResetInput): Promise<{ userId: string }> {
  enforcePolicy(input.newPassword);
  const tokenHash = hashSecretToken(input.token);
  // The slow scrypt runs before the transaction, never while holding it open.
  const passwordHash = await hashPassword(input.newPassword);

  const userId = await platformDb.$transaction(async (tx) => {
    const row = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, usedAt: true, expiresAt: true, user: { select: { isActive: true, tenantId: true } } },
    });
    const now = new Date();
    if (row === null || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime() || !row.user.isActive) {
      throw new InvalidResetTokenError();
    }
    // SINGLE USE: the consume is conditional on the token still being unused, so two
    // concurrent resets with the same code cannot both succeed.
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) {
      throw new InvalidResetTokenError();
    }
    await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash, passwordUpdatedAt: now },
    });
    // Any other code the user requested is now moot: retire it.
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: now },
    });
    await recordAudit(tx, {
      action: "PASSWORD_RESET_COMPLETED",
      actorUserId: row.userId,
      targetUserId: row.userId,
      tenantId: row.user.tenantId,
      ipAddress: input.ipAddress,
    });
    return row.userId;
  });

  // Whoever held the old password holds no session any more. No auto-login: the user
  // signs in again with the new password.
  await revokeAllUserSessions(userId);
  return { userId };
}

// ---- Change ----------------------------------------------------------------

export interface PasswordChangeInput {
  readonly userId: string;
  /** The caller's own session, which survives; every other session is revoked. */
  readonly sessionId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly ipAddress: string | null;
}

export async function changePassword(input: PasswordChangeInput): Promise<void> {
  const user = await platformDb.user.findUnique({
    where: { id: input.userId },
    select: { id: true, passwordHash: true, tenantId: true },
  });
  // verifyPassword runs a full scrypt even for a missing hash, so this path's timing
  // does not distinguish the cases.
  const currentOk = await verifyPassword(input.currentPassword, user?.passwordHash ?? null);
  if (user === null || !currentOk) {
    throw new CurrentPasswordIncorrectError();
  }
  enforcePolicy(input.newPassword);
  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();

  await platformDb.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordUpdatedAt: now } });
    // Every OTHER session ends; the one making this change stays signed in.
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: input.sessionId } },
      data: { revokedAt: now },
    });
    await recordAudit(tx, {
      action: "PASSWORD_CHANGED",
      actorUserId: user.id,
      targetUserId: user.id,
      tenantId: user.tenantId,
      ipAddress: input.ipAddress,
    });
  });
}
