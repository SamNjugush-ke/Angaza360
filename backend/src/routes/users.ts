// ===========================================================================
// User / staff management routes (Task T-A5), mounted at /v1/users.
//
// The RBAC rules live in ONE place — src/services/identity/user-management.ts — and
// the database holds the ones that matter most (who may grant which role; never
// losing the last owner). The route guards here only give a clean 403 to roles that
// can never act. The caller's identity and tenant come from the verified session;
// no route accepts a tenant id except the SUPER_ADMIN-only invite field and the
// admin audit filter, both refused for anyone else.
//
// THE INVITATION TOKEN TRAVELS IN THE ACCEPT URL, so src/server.ts masks that path
// segment in every request log line.
// ===========================================================================

import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from "fastify";
import { mfaRequiredFor } from "../auth/mfa-policy";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import {
  acceptInvitation,
  previewInvitation,
  changeUserRole,
  deactivateUser,
  inviteUser,
  listAuditLog,
  listPendingInvitations,
  listPlatformUsers,
  listStaff,
  reactivateUser,
  resetUserMfa,
  adminResetPassword,
  revokeInvitation,
  UserManagementError,
  type Actor,
} from "../services/identity/user-management";
import { zUserRole } from "../schemas/models";
import { errorBody, errorResponses, PUBLIC, SECURE, unauthorized, zTimestamp, zTimestampNullable } from "../schemas/common";

const zInvitationStatus = z.enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]);
const zDeliveryStatus = z.enum(["QUEUED", "SENT", "FAILED", "SIMULATED"]);

const zStaff = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  phone: z.string().nullable(),
  role: zUserRole,
  tenantId: z.string().nullable(),
  isActive: z.boolean(),
  lastLoginAt: zTimestampNullable,
  createdAt: zTimestamp,
});

const zInvitation = z.object({
  id: z.string(),
  email: z.string(),
  role: zUserRole,
  tenantId: z.string().nullable(),
  status: zInvitationStatus,
  expiresAt: zTimestamp,
  createdAt: zTimestamp,
});

const zInviteBody = z.object({
  email: z.email().max(320),
  role: zUserRole,
  tenantId: z.string().min(1).optional().meta({
    description: "SUPER_ADMIN only, for a tenant role. An owner's invitation always lands in their own business.",
  }),
  phone: z.string().trim().min(7).max(20).optional().meta({ description: "Also send the invitation by SMS." }),
});

const zAcceptBody = z.object({
  fullName: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(1024).meta({ description: "At least 10 characters. Never logged." }),
  phone: z.string().trim().min(7).max(20).optional(),
});

const zAudit = z.object({
  id: z.string(),
  action: z.string(),
  actorUserId: z.string().nullable(),
  targetUserId: z.string().nullable(),
  tenantId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  metadata: z.unknown(),
  occurredAt: zTimestamp,
  actorName: z.string().nullable().meta({ description: "The actor's name (null: anonymous, or the user is gone)." }),
  targetName: z.string().nullable().meta({ description: "The target user's name (null: none, or the user is gone)." }),
});

const zDirectoryUser = zStaff.extend({ businessName: z.string().nullable().meta({ description: "The user's business; null for a platform user." }) });

const zUserIdParams = z.object({ id: z.string().min(1) });

const ERROR_NAMES = { 400: "BadRequest", 403: "Forbidden", 404: "NotFound", 409: "Conflict" } as const;

function sendManagementError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof UserManagementError) {
    return reply.code(error.status).send(errorBody(error.status, ERROR_NAMES[error.status], error.message));
  }
  throw error;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const manageRoles = app.requireRole("SUPER_ADMIN", "MSME_OWNER");

  function actorOf(request: { auth: { userId: string; role: Actor["role"]; tenantId: string | null } | null; ip: string }): Actor | null {
    return request.auth === null
      ? null
      : { userId: request.auth.userId, role: request.auth.role, tenantId: request.auth.tenantId, ipAddress: request.ip };
  }

  api.route({
    method: "POST",
    url: "/invite",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [app.requireAuth, manageRoles],
    schema: {
      tags: ["Users"],
      summary: "Invite a user to a role",
      description:
        "A SUPER_ADMIN may invite to any role (a platform role is tenantless; a tenant role needs `tenantId`). An MSME_OWNER may invite to a TENANT role in their own business only. The single-use invitation code (valid for INVITATION_TTL_HOURS) is delivered by email — and by SMS when `phone` is given — and is never returned here.",
      security: SECURE,
      body: zInviteBody,
      response: {
        201: z.object({
          invitation: zInvitation,
          delivery: z.object({ email: zDeliveryStatus, sms: zDeliveryStatus.nullable() }),
        }),
        ...errorResponses(400, 401, 403, 404, 409, 429),
      },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const result = await inviteUser(actor, {
          email: request.body.email,
          role: request.body.role,
          tenantId: request.body.tenantId ?? null,
          phone: request.body.phone ?? null,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/invitations/:token",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Users"],
      summary: "Preview an invitation before accepting it",
      description:
        "Public, rate-limited per IP. For a valid, unexpired, PENDING invitation, what it offers: the invited email, the role and the business (null for a platform role). Writes nothing. An unknown, used, revoked or expired invitation gets the same 400 as accepting it. The token is masked in request logs.",
      security: PUBLIC,
      params: z.object({ token: z.string().min(1).max(512) }),
      response: {
        200: z.object({
          email: z.string(),
          role: zUserRole,
          businessName: z.string().nullable(),
          expiresAt: zTimestamp,
        }),
        ...errorResponses(400, 429),
      },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await previewInvitation(request.params.token));
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/invitations/:token/accept",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Users"],
      summary: "Accept an invitation and create your account",
      description:
        "Public, rate-limited per IP. Consumes a valid, unexpired, PENDING invitation ONCE and creates the user with the invited role and business. Signs nobody in: log in afterwards. An unknown, used, revoked or expired invitation gets the same 400.",
      security: PUBLIC,
      params: z.object({ token: z.string().min(1).max(512) }),
      body: zAcceptBody,
      response: { 201: zStaff, ...errorResponses(400, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        const user = await acceptInvitation({
          token: request.params.token,
          fullName: request.body.fullName,
          password: request.body.password,
          phone: request.body.phone ?? null,
          ipAddress: request.ip,
        });
        return reply.code(201).send(user);
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/invitations",
    preHandler: [app.requireAuth, manageRoles],
    schema: {
      tags: ["Users"],
      summary: "The open invitations you may revoke",
      description:
        "PENDING, unexpired invitations, newest first: an owner's own business's; a SUPER_ADMIN's anywhere, or one business's with `tenantId`. The invitation code is never returned.",
      security: SECURE,
      querystring: z.object({ tenantId: z.string().min(1).optional() }),
      response: { 200: z.object({ data: z.array(zInvitation) }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send({ data: await listPendingInvitations(actor, { tenantId: request.query.tenantId ?? null }) });
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/invitations/:id/revoke",
    preHandler: [app.requireAuth, manageRoles],
    schema: {
      tags: ["Users"],
      summary: "Revoke a pending invitation",
      security: SECURE,
      params: zUserIdParams,
      response: { 200: zInvitation, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await revokeInvitation(actor, request.params.id));
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/",
    preHandler: [app.requireAuth, app.requireTenant, app.requireRole("MSME_OWNER", "MSME_MANAGER")],
    schema: {
      tags: ["Users"],
      summary: "List your business's staff",
      description: "Only the caller's own business. There is no parameter that names a tenant.",
      security: SECURE,
      response: { 200: z.object({ data: z.array(zStaff) }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send({ data: await listStaff(actor) });
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/directory",
    preHandler: [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER")],
    schema: {
      tags: ["Users"],
      summary: "The platform user directory (SUPER_ADMIN / PROGRAM_OFFICER)",
      description:
        "Every user on the platform, searchable by name or email and filterable by role, business and active state, ordered by name then id. Platform staff only: a programme officer reads it (to invite mentors); changing a user stays the SUPER_ADMIN's.",
      security: SECURE,
      querystring: z.object({
        q: z.string().trim().max(200).optional(),
        role: zUserRole.optional(),
        tenantId: z.string().min(1).optional(),
        active: z.enum(["true", "false"]).optional(),
        take: z.coerce.number().int().min(1).max(200).optional(),
        skip: z.coerce.number().int().min(0).optional(),
      }),
      response: { 200: z.object({ data: z.array(zDirectoryUser), total: z.number().int() }), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const q = request.query;
        return reply.code(200).send(
          await listPlatformUsers(actor, {
            q: q.q ?? null,
            role: q.role ?? null,
            tenantId: q.tenantId ?? null,
            active: q.active === undefined ? null : q.active === "true",
            take: q.take ?? 50,
            skip: q.skip ?? 0,
          }),
        );
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "GET",
    url: "/audit",
    preHandler: [app.requireAuth, app.requireRole("SUPER_ADMIN", "PROGRAM_OFFICER", "MSME_OWNER")],
    schema: {
      tags: ["Users"],
      summary: "Read the identity audit log",
      description:
        "An owner reads their own business's trail; a SUPER_ADMIN or PROGRAM_OFFICER reads every business's, optionally narrowed by `tenantId`. Newest first. The log is append-only.",
      security: SECURE,
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        tenantId: z.string().min(1).optional(),
      }),
      response: { 200: z.object({ data: z.array(zAudit) }), ...errorResponses(400, 401, 403) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        const data = await listAuditLog(actor, { limit: request.query.limit ?? 50, tenantId: request.query.tenantId ?? null });
        return reply.code(200).send({ data });
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/:id/role",
    preHandler: [app.requireAuth, manageRoles],
    schema: {
      tags: ["Users"],
      summary: "Change a user's role",
      description:
        "Same rules as inviting. The last active owner cannot be demoted (409). The user's sessions are revoked, because the old role is in their access token.",
      security: SECURE,
      params: zUserIdParams,
      body: z.object({ role: zUserRole }),
      response: { 200: zStaff, ...errorResponses(400, 401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await changeUserRole(actor, request.params.id, request.body.role));
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/deactivate",
    preHandler: [app.requireAuth, manageRoles],
    schema: {
      tags: ["Users"],
      summary: "Deactivate a user",
      description: "Revokes every session; the user can no longer log in. The last active owner cannot be deactivated (409).",
      security: SECURE,
      params: zUserIdParams,
      response: { 200: zStaff, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await deactivateUser(actor, request.params.id));
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/reactivate",
    preHandler: [app.requireAuth, manageRoles],
    schema: {
      tags: ["Users"],
      summary: "Reactivate a user",
      security: SECURE,
      params: zUserIdParams,
      response: { 200: zStaff, ...errorResponses(401, 403, 404, 409) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await reactivateUser(actor, request.params.id));
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });
  // ---- Admin-assisted recovery (M4.5 W1) ------------------------------------------
  // A SUPER_ADMIN must have stepped up (a fresh authenticator code) within
  // STEP_UP_TTL_SECONDS; an owner (who may have no MFA) acts on their own staff only.
  const stepUpForAdmins: preHandlerHookHandler = async function (request, reply) {
    if (request.auth !== null && mfaRequiredFor(request.auth.role)) {
      return app.requireStepUp.call(this, request, reply, () => undefined);
    }
    return undefined;
  };

  api.route({
    method: "POST",
    url: "/:id/mfa/reset",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [app.requireAuth, manageRoles, stepUpForAdmins],
    schema: {
      tags: ["Users"],
      summary: "Reset a user's two-step verification",
      description:
        "Recovery for someone who lost their authenticator and backup codes: clears their factor (no secret is exposed) and signs them out everywhere; they enrol again at their next sign-in (mandatory for an administrator). SUPER_ADMIN (after a step-up) for anyone; an owner for their own business's users. Never your own account. Audited.",
      security: SECURE,
      params: zUserIdParams,
      response: { 200: zStaff, ...errorResponses(401, 403, 404, 429) },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await resetUserMfa(actor, request.params.id));
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/:id/password/reset",
    config: { rateLimit: RATE_LIMITS.SENSITIVE },
    preHandler: [app.requireAuth, manageRoles, stepUpForAdmins],
    schema: {
      tags: ["Users"],
      summary: "Reset a user's password to a temporary one",
      description:
        "Sets a random temporary password, delivered ONLY to the user's own email (and phone) — never in this response — and requires them to choose a new one at their next sign-in. Every session is revoked. SUPER_ADMIN (after a step-up) for anyone; an owner for their own business's users. Never your own account. Audited.",
      security: SECURE,
      params: zUserIdParams,
      response: {
        200: z.object({
          user: zStaff,
          delivery: z.object({ email: zDeliveryStatus, sms: zDeliveryStatus.nullable() }),
        }),
        ...errorResponses(401, 403, 404, 429),
      },
    },
    handler: async (request, reply) => {
      const actor = actorOf(request);
      if (actor === null) return reply.code(401).send(unauthorized("Authentication required."));
      try {
        return reply.code(200).send(await adminResetPassword(actor, request.params.id));
      } catch (error) {
        return sendManagementError(reply, error);
      }
    },
  });
}
