// ===========================================================================
// User / staff management (Task T-A5).
//
// Invite staff, accept an invitation, list a business's staff, change a role,
// deactivate and reactivate — every mutation audited in the ONE identity audit log
// (T-A4), in the same transaction as the change it records.
//
// THE ROLE-ASSIGNMENT RULES (held here AND by the database):
//   * PLATFORM roles — SUPER_ADMIN, PROGRAM_OFFICER, MENTOR, COACH — are tenantless and
//     may be granted ONLY by a SUPER_ADMIN.
//   * TENANT roles belong to exactly one tenant. A SUPER_ADMIN may grant one in any
//     tenant; an MSME_OWNER only in THEIR OWN tenant (co-owners included: equal is not
//     above). Nobody else grants anything. No actor can grant a role above their own.
//   * A user never moves between platform and tenant scope by a role change.
//
// SCOPE IS ISOLATION: an owner can see and act on their own tenant's users only. Any
// other user — another business's, or a platform user — is "not found" (404), never
// "forbidden", so the API does not confirm that a user id exists elsewhere.
//
// FAIL-CLOSED: the last active MSME_OWNER of a tenant can be neither deactivated nor
// demoted (LastActiveOwnerError, 409) — checked under a per-tenant lock here, and
// guaranteed by the `last_active_owner_guard` trigger for every writer.
//
// A deactivation or a role change REVOKES the target's sessions: an access token
// carries the role, so a demoted or deactivated user must not keep acting on the old
// one. Invitation tokens are single-use bearer secrets stored only as their sha256
// and delivered once through the notification channel (T-A3).
// ===========================================================================

import { randomInt } from "node:crypto";
import { assertPasswordPolicy, hashPassword } from "../../auth/password";
import { clearMfaWithinTransaction } from "./mfa";
import { revokeAllUserSessions } from "../../auth/tokens";
import { env } from "../../config/env";
import { platformDb } from "../../db/platform";
import type { AuditAction, InvitationStatus, UserRole } from "../../generated/platform/enums";
import { sendNotification } from "../notifications/notification-service";
import { recordAudit, type PlatformTx } from "./audit";
import { normalizeEmail } from "./password-lifecycle";
import { hashSecretToken, issueSecretToken } from "./secret-token";

export const PLATFORM_ROLES: readonly UserRole[] = ["SUPER_ADMIN", "PROGRAM_OFFICER", "MENTOR", "COACH"];

export function isPlatformRole(role: UserRole): boolean {
  return PLATFORM_ROLES.includes(role);
}

/** Every refusal carries the HTTP status the route answers with. */
export class UserManagementError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "UserManagementError";
    this.status = status;
  }
}

export class LastActiveOwnerError extends UserManagementError {
  constructor() {
    super(
      409,
      "This is the last active owner of the business, who can be neither deactivated nor demoted. Add or reactivate another owner first.",
    );
    this.name = "LastActiveOwnerError";
  }
}

/** The authenticated caller, from the verified session — never from a request body. */
export interface Actor {
  readonly userId: string;
  readonly role: UserRole;
  readonly tenantId: string | null;
  readonly ipAddress: string | null;
}

export interface StaffView {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly role: UserRole;
  readonly tenantId: string | null;
  readonly isActive: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

const STAFF_SELECT = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  role: true,
  tenantId: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly tenantId: string | null;
  readonly status: InvitationStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

const INVITATION_SELECT = {
  id: true,
  email: true,
  role: true,
  tenantId: true,
  status: true,
  expiresAt: true,
  createdAt: true,
} as const;

// ---- The role-assignment rule ---------------------------------------------

/** Which tenant a grant of `role` by `actor` lands in, or a refusal. */
function resolveGrantTenant(actor: Actor, role: UserRole, requestedTenantId: string | null): string | null {
  if (actor.role === "SUPER_ADMIN") {
    if (isPlatformRole(role)) {
      if (requestedTenantId !== null) {
        throw new UserManagementError(400, `${role} is a platform role and belongs to no tenant; omit tenantId.`);
      }
      return null;
    }
    if (requestedTenantId === null) {
      throw new UserManagementError(400, `${role} is a tenant role; name the tenant with tenantId.`);
    }
    return requestedTenantId;
  }
  if (actor.role === "MSME_OWNER" && actor.tenantId !== null) {
    if (isPlatformRole(role)) {
      throw new UserManagementError(403, `Only a SUPER_ADMIN may grant the platform role ${role}.`);
    }
    if (requestedTenantId !== null && requestedTenantId !== actor.tenantId) {
      throw new UserManagementError(403, "An owner may grant roles only in their own business.");
    }
    return actor.tenantId;
  }
  throw new UserManagementError(403, "Your role does not permit granting roles.");
}

/** The target of a staff action, if the actor may see it — otherwise 404, never 403. */
async function loadVisibleUser(db: PlatformTx, actor: Actor, userId: string): Promise<StaffView> {
  const user = await db.user.findUnique({ where: { id: userId }, select: STAFF_SELECT });
  const visible =
    user !== null &&
    (actor.role === "SUPER_ADMIN" || (actor.role === "MSME_OWNER" && actor.tenantId !== null && user.tenantId === actor.tenantId));
  if (!visible || user === null) {
    throw new UserManagementError(404, "No such user in your business.");
  }
  return user;
}

/**
 * Refuses (LastActiveOwnerError) when `target` is an active owner whose change would
 * leave its tenant with no active owner. Takes the per-tenant lock the database guard
 * takes, so two concurrent changes cannot both pass.
 */
async function assertNotLastActiveOwner(db: PlatformTx, target: StaffView): Promise<void> {
  if (target.tenantId === null || target.role !== "MSME_OWNER" || !target.isActive) {
    return;
  }
  await db.$queryRaw`SELECT 1 FROM public."tenants" WHERE "id" = ${target.tenantId} FOR NO KEY UPDATE`;
  const others = await db.user.count({
    where: { tenantId: target.tenantId, role: "MSME_OWNER", isActive: true, id: { not: target.id } },
  });
  if (others === 0) {
    throw new LastActiveOwnerError();
  }
}

function audit(db: PlatformTx, actor: Actor, action: AuditAction, target: { id: string | null; tenantId: string | null }, metadata?: Record<string, string | null>) {
  return recordAudit(db, {
    action,
    actorUserId: actor.userId,
    targetUserId: target.id,
    tenantId: target.tenantId,
    ipAddress: actor.ipAddress,
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

// ---- Invitations -----------------------------------------------------------

export interface InviteInput {
  readonly email: string;
  readonly role: UserRole;
  /** Honoured only for a SUPER_ADMIN; an owner's invitations always land in their own tenant. */
  readonly tenantId: string | null;
  /** Also deliver the invitation by SMS to this number. */
  readonly phone: string | null;
  /**
   * Onboarding (Task T-A6.1): the invitee's National ID, carried on the invitation and
   * copied onto their user when they accept. Unique among users (partial unique index).
   */
  readonly nationalId?: string | null;
}

export interface InviteResult {
  readonly invitation: InvitationView;
  readonly delivery: { readonly email: InvitationStatusOfSend; readonly sms: InvitationStatusOfSend | null };
}

type InvitationStatusOfSend = "SENT" | "SIMULATED" | "FAILED" | "QUEUED";

export async function inviteUser(actor: Actor, input: InviteInput): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  const tenantId = resolveGrantTenant(actor, input.role, input.tenantId);

  const tenant = tenantId === null ? null : await platformDb.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
  if (tenantId !== null && tenant === null) {
    throw new UserManagementError(404, "No such tenant.");
  }
  if ((await platformDb.user.count({ where: { email } })) > 0) {
    throw new UserManagementError(409, "A user with that email already exists.");
  }
  const inviter = await platformDb.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { fullName: true } });

  const token = issueSecretToken();
  const now = new Date();
  const invitation = await platformDb.$transaction(async (tx) => {
    // An open invitation past its expiry no longer blocks a fresh one.
    await tx.userInvitation.updateMany({ where: { email, status: "PENDING", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
    if ((await tx.userInvitation.count({ where: { email, status: "PENDING" } })) > 0) {
      throw new UserManagementError(409, "That email already has an open invitation. Revoke it first to send a new one.");
    }
    const created = await tx.userInvitation.create({
      data: {
        email,
        role: input.role,
        tenantId,
        invitedById: actor.userId,
        nationalId: input.nationalId ?? null,
        tokenHash: token.hash,
        expiresAt: new Date(now.getTime() + env.invitationTtlHours * 3_600_000),
      },
      select: INVITATION_SELECT,
    });
    await audit(tx, actor, "USER_INVITED", { id: null, tenantId }, { invitationId: created.id, email, role: input.role });
    return created;
  });

  const template = {
    key: "user-invitation" as const,
    token: token.raw,
    // The accept page with the code filled in (T-B-INVITE-LINK). The code travels ONLY in the
    // message to the invitee — never in an API response.
    link: `${env.appBaseUrl}/invite/${encodeURIComponent(token.raw)}`,
    role: input.role,
    businessName: tenant?.name ?? null,
    inviterName: inviter.fullName,
    expiresInHours: env.invitationTtlHours,
  };
  const related = { type: "UserInvitation", id: invitation.id };
  const emailSend = await sendNotification({ channel: "EMAIL", to: email, template, related });
  const smsSend = input.phone === null ? null : await sendNotification({ channel: "SMS", to: input.phone, template, related });
  return { invitation, delivery: { email: emailSend.status, sms: smsSend?.status ?? null } };
}

export interface AcceptInvitationInput {
  readonly token: string;
  readonly fullName: string;
  readonly password: string;
  readonly phone: string | null;
  readonly ipAddress: string | null;
}

/** The one answer for an unknown, used, revoked or expired invitation — never which. */
const INVITATION_INVALID = "This invitation is invalid or has expired. Ask for a new one.";

/** What the invitee is shown before accepting: what they were offered, and nothing else. */
export interface InvitationPreview {
  readonly email: string;
  readonly role: UserRole;
  /** The business the role is in; null for a (tenantless) platform role. */
  readonly businessName: string | null;
  readonly expiresAt: Date;
}

/**
 * The accept page's preview of a PENDING, unexpired invitation (Task T-B-INVITE-PREVIEW). The
 * token is the same single-use bearer secret the accept call consumes, so whoever holds it may
 * see what it offers. It WRITES NOTHING (an expired invitation is recorded EXPIRED only by an
 * accept attempt) and gives an unknown, used, revoked or expired token the accept call's ONE
 * 400 — never which.
 */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const invitation = await platformDb.userInvitation.findUnique({
    where: { tokenHash: hashSecretToken(token) },
    select: { email: true, role: true, status: true, expiresAt: true, tenantId: true },
  });
  if (invitation === null || invitation.status !== "PENDING" || invitation.expiresAt.getTime() <= Date.now()) {
    throw new UserManagementError(400, INVITATION_INVALID);
  }
  const tenant =
    invitation.tenantId === null
      ? null
      : await platformDb.tenant.findUnique({ where: { id: invitation.tenantId }, select: { name: true } });
  return { email: invitation.email, role: invitation.role, businessName: tenant?.name ?? null, expiresAt: invitation.expiresAt };
}

export async function acceptInvitation(input: AcceptInvitationInput): Promise<StaffView> {
  try {
    assertPasswordPolicy(input.password);
  } catch (error) {
    throw new UserManagementError(400, error instanceof Error ? error.message : "Password does not meet policy.");
  }
  const passwordHash = await hashPassword(input.password);
  const tokenHash = hashSecretToken(input.token);

  const outcome = await platformDb.$transaction(async (tx) => {
    const invitation = await tx.userInvitation.findUnique({ where: { tokenHash } });
    if (invitation === null || invitation.status !== "PENDING") {
      return { kind: "invalid" as const };
    }
    const now = new Date();
    if (invitation.expiresAt.getTime() <= now.getTime()) {
      // Record the expiry (it commits), then refuse.
      await tx.userInvitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
      return { kind: "invalid" as const };
    }
    if ((await tx.user.count({ where: { email: invitation.email } })) > 0) {
      throw new UserManagementError(409, "A user with that email already exists.");
    }
    if (input.phone !== null && (await tx.user.count({ where: { phone: input.phone } })) > 0) {
      throw new UserManagementError(409, "That phone number already belongs to a user.");
    }
    if (invitation.nationalId !== null && (await tx.user.count({ where: { nationalId: invitation.nationalId } })) > 0) {
      throw new UserManagementError(409, "That National ID already belongs to a user.");
    }
    const user = await tx.user.create({
      data: {
        email: invitation.email,
        fullName: input.fullName,
        phone: input.phone,
        nationalId: invitation.nationalId,
        role: invitation.role,
        tenantId: invitation.tenantId,
        passwordHash,
        passwordUpdatedAt: now,
      },
      select: STAFF_SELECT,
    });
    // SINGLE USE: conditional on the invitation still being PENDING.
    const accepted = await tx.userInvitation.updateMany({
      where: { id: invitation.id, status: "PENDING" },
      data: { status: "ACCEPTED", acceptedAt: now, acceptedUserId: user.id },
    });
    if (accepted.count !== 1) {
      throw new UserManagementError(400, INVITATION_INVALID);
    }
    await recordAudit(tx, {
      action: "INVITATION_ACCEPTED",
      actorUserId: user.id,
      targetUserId: user.id,
      tenantId: user.tenantId,
      ipAddress: input.ipAddress,
      metadata: { invitationId: invitation.id, role: user.role },
    });
    return { kind: "accepted" as const, user };
  });

  if (outcome.kind === "invalid") {
    throw new UserManagementError(400, INVITATION_INVALID);
  }
  return outcome.user;
}

/**
 * The OPEN invitations (PENDING and not yet expired) the caller may revoke (Task T-B-INVITE-LIST): an
 * owner's own business's; a SUPER_ADMIN's anywhere, optionally one business's. Newest first. The
 * code is never part of it — only its hash is stored.
 */
export async function listPendingInvitations(actor: Actor, options: { tenantId: string | null }): Promise<InvitationView[]> {
  let tenantFilter: { tenantId?: string | null } = {};
  if (actor.role === "SUPER_ADMIN") {
    tenantFilter = options.tenantId === null ? {} : { tenantId: options.tenantId };
  } else if (actor.role === "MSME_OWNER" && actor.tenantId !== null) {
    if (options.tenantId !== null && options.tenantId !== actor.tenantId) {
      throw new UserManagementError(403, "An owner may list only their own business's invitations.");
    }
    tenantFilter = { tenantId: actor.tenantId };
  } else {
    throw new UserManagementError(403, "Your role does not permit listing invitations.");
  }
  return platformDb.userInvitation.findMany({
    where: { ...tenantFilter, status: "PENDING", expiresAt: { gt: new Date() } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: INVITATION_SELECT,
  });
}

export async function revokeInvitation(actor: Actor, invitationId: string): Promise<InvitationView> {
  return platformDb.$transaction(async (tx) => {
    const invitation = await tx.userInvitation.findUnique({ where: { id: invitationId }, select: INVITATION_SELECT });
    const visible =
      invitation !== null &&
      (actor.role === "SUPER_ADMIN" || (actor.role === "MSME_OWNER" && actor.tenantId !== null && invitation.tenantId === actor.tenantId));
    if (!visible || invitation === null) {
      throw new UserManagementError(404, "No such invitation in your business.");
    }
    if (invitation.status !== "PENDING") {
      throw new UserManagementError(409, `The invitation is ${invitation.status}; only a PENDING invitation can be revoked.`);
    }
    const revoked = await tx.userInvitation.update({ where: { id: invitation.id }, data: { status: "REVOKED" }, select: INVITATION_SELECT });
    await audit(tx, actor, "INVITATION_REVOKED", { id: null, tenantId: invitation.tenantId }, { invitationId: invitation.id, email: invitation.email });
    return revoked;
  });
}

// ---- Staff ------------------------------------------------------------------

/** The caller's OWN tenant's users. There is no parameter that names a tenant. */
export async function listStaff(actor: Actor): Promise<StaffView[]> {
  if (actor.tenantId === null) {
    throw new UserManagementError(403, "Listing staff needs a business context.");
  }
  return platformDb.user.findMany({
    where: { tenantId: actor.tenantId },
    orderBy: [{ createdAt: "asc" }],
    select: STAFF_SELECT,
  });
}

export async function changeUserRole(actor: Actor, userId: string, role: UserRole): Promise<StaffView> {
  if (actor.role !== "SUPER_ADMIN" && isPlatformRole(role)) {
    throw new UserManagementError(403, `Only a SUPER_ADMIN may grant the platform role ${role}.`);
  }
  const updated = await platformDb.$transaction(async (tx) => {
    const target = await loadVisibleUser(tx, actor, userId);
    if ((target.tenantId === null) !== isPlatformRole(role)) {
      throw new UserManagementError(
        400,
        target.tenantId === null
          ? `${role} is a tenant role; a platform user cannot take it.`
          : `${role} is a platform role; a business's user cannot take it.`,
      );
    }
    if (target.role === role) {
      throw new UserManagementError(409, `The user already has the role ${role}.`);
    }
    if (role !== "MSME_OWNER") {
      await assertNotLastActiveOwner(tx, target);
    }
    const changed = await tx.user.update({ where: { id: target.id }, data: { role }, select: STAFF_SELECT });
    await audit(tx, actor, "ROLE_CHANGED", target, { fromRole: target.role, toRole: role });
    return changed;
  });
  // The old role is in every live access token: end them.
  await revokeAllUserSessions(updated.id);
  return updated;
}

export async function deactivateUser(actor: Actor, userId: string): Promise<StaffView> {
  const updated = await platformDb.$transaction(async (tx) => {
    const target = await loadVisibleUser(tx, actor, userId);
    if (!target.isActive) {
      throw new UserManagementError(409, "The user is already deactivated.");
    }
    await assertNotLastActiveOwner(tx, target);
    const changed = await tx.user.update({ where: { id: target.id }, data: { isActive: false }, select: STAFF_SELECT });
    await audit(tx, actor, "USER_DEACTIVATED", target);
    return changed;
  });
  // A deactivated user cannot authenticate: every session ends now (login already
  // refuses an inactive user, and refresh refuses one too).
  await revokeAllUserSessions(updated.id);
  return updated;
}

export async function reactivateUser(actor: Actor, userId: string): Promise<StaffView> {
  return platformDb.$transaction(async (tx) => {
    const target = await loadVisibleUser(tx, actor, userId);
    if (target.isActive) {
      throw new UserManagementError(409, "The user is already active.");
    }
    const changed = await tx.user.update({ where: { id: target.id }, data: { isActive: true }, select: STAFF_SELECT });
    await audit(tx, actor, "USER_REACTIVATED", target);
    return changed;
  });
}

// ---- Admin-assisted recovery (M4.5 W1) -------------------------------------------
//
// Both are for a user who has lost access, and both END every session of the target and
// expose NO secret: the MFA reset clears the factor (they enrol again at their next
// login — for an administrator that is mandatory), and the password reset sets a random
// TEMPORARY password, delivered only to the user's own email (and phone), never in the
// response, with mustResetPassword set so the first login must replace it.
//
// Who: a SUPER_ADMIN for any user (the route also demands a fresh step-up), an
// MSME_OWNER for their own business's users (the 404-scoping of every staff action).
// Nobody resets their OWN factor or password this way — the self-service paths exist.

function assertNotSelf(actor: Actor, target: StaffView): void {
  if (actor.userId === target.id) {
    throw new UserManagementError(403, "Use your own security settings for your account; this is for helping someone else.");
  }
}

function assertMayRecover(actor: Actor): void {
  if (actor.role !== "SUPER_ADMIN" && actor.role !== "MSME_OWNER") {
    throw new UserManagementError(403, "Your role does not permit resetting another user's sign-in.");
  }
}

export async function resetUserMfa(actor: Actor, userId: string): Promise<StaffView> {
  assertMayRecover(actor);
  const target = await platformDb.$transaction(async (tx) => {
    const found = await loadVisibleUser(tx, actor, userId);
    assertNotSelf(actor, found);
    const before = await tx.user.findUniqueOrThrow({ where: { id: found.id }, select: { mfaEnabled: true } });
    await clearMfaWithinTransaction(tx, found.id);
    await audit(tx, actor, "MFA_RESET", found, { wasEnabled: before.mfaEnabled ? "true" : "false" });
    return found;
  });
  await revokeAllUserSessions(target.id);
  return target;
}

const TEMP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const TEMP_LENGTH = 16;

function temporaryPassword(): string {
  return Array.from({ length: TEMP_LENGTH }, () => TEMP_ALPHABET[randomInt(0, TEMP_ALPHABET.length)] ?? "x").join("");
}

export interface AdminPasswordResetResult {
  readonly user: StaffView;
  readonly delivery: { readonly email: InvitationStatusOfSend; readonly sms: InvitationStatusOfSend | null };
}

export async function adminResetPassword(actor: Actor, userId: string): Promise<AdminPasswordResetResult> {
  assertMayRecover(actor);
  const temporary = temporaryPassword();
  const passwordHash = await hashPassword(temporary);
  const target = await platformDb.$transaction(async (tx) => {
    const found = await loadVisibleUser(tx, actor, userId);
    assertNotSelf(actor, found);
    await tx.user.update({
      where: { id: found.id },
      data: { passwordHash, passwordUpdatedAt: new Date(), mustResetPassword: true },
    });
    // Any outstanding self-service reset code is moot now.
    await tx.passwordResetToken.updateMany({ where: { userId: found.id, usedAt: null }, data: { usedAt: new Date() } });
    await audit(tx, actor, "PASSWORD_ADMIN_RESET", found);
    return found;
  });
  await revokeAllUserSessions(target.id);
  const template = {
    key: "temporary-password" as const,
    fullName: target.fullName,
    temporaryPassword: temporary,
    loginUrl: `${env.appBaseUrl}/login`,
  };
  const related = { type: "User", id: target.id };
  const emailSend = await sendNotification({ channel: "EMAIL", to: target.email, template, related });
  const smsSend = target.phone === null ? null : await sendNotification({ channel: "SMS", to: target.phone, template, related });
  return { user: target, delivery: { email: emailSend.status, sms: smsSend?.status ?? null } };
}

// ---- The audit log ------------------------------------------------------------

export interface AuditView {
  readonly id: string;
  readonly action: AuditAction;
  readonly actorUserId: string | null;
  readonly targetUserId: string | null;
  readonly tenantId: string | null;
  readonly ipAddress: string | null;
  readonly metadata: unknown;
  readonly occurredAt: Date;
  /** The actor's and target's names at read time (T-B-ADMIN-USER-LIST); null for no user or a removed one. */
  readonly actorName: string | null;
  readonly targetName: string | null;
}

/** id -> full name for the given user ids (unknown ids are simply absent). */
export async function userNames(ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await platformDb.user.findMany({ where: { id: { in: wanted } }, select: { id: true, fullName: true } });
  return new Map(rows.map((row) => [row.id, row.fullName]));
}

/**
 * An owner reads their OWN tenant's audit trail; a SUPER_ADMIN or PROGRAM_OFFICER reads
 * every tenant's (optionally narrowed to one). Newest first.
 */
export async function listAuditLog(actor: Actor, options: { limit: number; tenantId: string | null }): Promise<AuditView[]> {
  let tenantFilter: string | null;
  if (actor.role === "SUPER_ADMIN" || actor.role === "PROGRAM_OFFICER") {
    tenantFilter = options.tenantId;
  } else if (actor.role === "MSME_OWNER" && actor.tenantId !== null) {
    if (options.tenantId !== null && options.tenantId !== actor.tenantId) {
      throw new UserManagementError(403, "An owner may read only their own business's audit log.");
    }
    tenantFilter = actor.tenantId;
  } else {
    throw new UserManagementError(403, "Your role does not permit reading the audit log.");
  }
  const rows = await platformDb.auditLog.findMany({
    where: tenantFilter === null ? {} : { tenantId: tenantFilter },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: options.limit,
    select: {
      id: true,
      action: true,
      actorUserId: true,
      targetUserId: true,
      tenantId: true,
      ipAddress: true,
      metadata: true,
      occurredAt: true,
    },
  });
  // OWNER-VISIBLE MASKING (M4.5 W5). A standing-god-mode action (OPERATOR_ACTED) is TRUTHFULLY shown
  // to the business owner — the owner always sees that an operator acted and what they did — but the
  // individual operator is never NAMED to them: they are "Platform operator", and the operator's own
  // user id and address are withheld. Platform staff (reading the internal log) see the real actor.
  const ownerView = actor.role !== "SUPER_ADMIN" && actor.role !== "PROGRAM_OFFICER";
  const names = await userNames(rows.flatMap((row) => [row.actorUserId, row.targetUserId]));
  return rows.map((row) => {
    if (ownerView && row.action === "OPERATOR_ACTED") {
      return { ...row, actorUserId: null, ipAddress: null, actorName: "Platform operator", targetName: null };
    }
    return {
      ...row,
      actorName: row.actorUserId === null ? null : (names.get(row.actorUserId) ?? null),
      targetName: row.targetUserId === null ? null : (names.get(row.targetUserId) ?? null),
    };
  });
}

export interface OperatorActivityEntry {
  readonly id: string;
  readonly at: Date;
  readonly method: string;
  readonly route: string;
}

/**
 * THE OWNER-VISIBLE OPERATOR ACTIVITY (M4.5 W5): every standing-god-mode action on this business,
 * newest first, attributed to the platform operator and NEVER to a named individual. This is the
 * truthful record the owner always has that an operator acted and what they did — there is nothing
 * to approve or revoke. The route (template, no ids) and method say WHAT was done.
 */
export async function listOperatorActivity(tenantId: string, limit: number): Promise<OperatorActivityEntry[]> {
  const rows = await platformDb.auditLog.findMany({
    where: { action: "OPERATOR_ACTED", tenantId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { id: true, occurredAt: true, metadata: true },
  });
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as { method?: unknown; route?: unknown };
    return {
      id: row.id,
      at: row.occurredAt,
      method: typeof meta.method === "string" ? meta.method : "",
      route: typeof meta.route === "string" ? meta.route : "",
    };
  });
}

// ---- The platform directory (Task T-B-ADMIN-USER-LIST) ----------------------------

export interface DirectoryFilters {
  readonly q: string | null;
  readonly role: UserRole | null;
  readonly tenantId: string | null;
  readonly active: boolean | null;
  readonly take: number;
  readonly skip: number;
}

export interface DirectoryUser extends StaffView {
  readonly businessName: string | null;
}

/**
 * Every user on the platform, searchable — for platform staff only (SUPER_ADMIN, PROGRAM_OFFICER):
 * the admin user screen and the mentor picker. A programme officer READS it (they invite mentors);
 * changing a user stays the SUPER_ADMIN's (the role / deactivate routes). Ordered by name, then id,
 * so pages never overlap.
 */
export async function listPlatformUsers(actor: Actor, filters: DirectoryFilters): Promise<{ data: DirectoryUser[]; total: number }> {
  if (actor.role !== "SUPER_ADMIN" && actor.role !== "PROGRAM_OFFICER") {
    throw new UserManagementError(403, "Only platform staff may read the user directory.");
  }
  const q = filters.q?.trim() ?? "";
  const where = {
    ...(q !== "" ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { email: { contains: q, mode: "insensitive" as const } }] } : {}),
    ...(filters.role !== null ? { role: filters.role } : {}),
    ...(filters.tenantId !== null ? { tenantId: filters.tenantId } : {}),
    ...(filters.active !== null ? { isActive: filters.active } : {}),
  };
  const [rows, total] = await Promise.all([
    platformDb.user.findMany({
      where,
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      take: filters.take,
      skip: filters.skip,
      select: { ...STAFF_SELECT, tenant: { select: { name: true } } },
    }),
    platformDb.user.count({ where }),
  ]);
  return { data: rows.map(({ tenant, ...user }) => ({ ...user, businessName: tenant?.name ?? null })), total };
}
