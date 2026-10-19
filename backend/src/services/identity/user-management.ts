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

import { assertPasswordPolicy, hashPassword } from "../../auth/password";
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
  return platformDb.auditLog.findMany({
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
}
