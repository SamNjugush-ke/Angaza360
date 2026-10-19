import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { platformDb } from "../db/platform";
import { verifyPassword } from "../auth/password";
import {
  issueSession,
  rotateSession,
  revokeAllUserSessions,
  revokeSession,
  RefreshTokenError,
  type SessionMeta,
} from "../auth/tokens";
import {
  resolveTenantContext,
  TenantUnavailableError,
} from "../auth/tenant-registry";
import {
  changePassword,
  CurrentPasswordIncorrectError,
  InvalidResetTokenError,
  PasswordPolicyError,
  requestPasswordReset,
  resetPassword,
} from "../services/identity/password-lifecycle";
import { zUserRole } from "../schemas/models";
import { badRequest, errorResponses, forbidden, PUBLIC, SECURE, unauthorized } from "../schemas/common";
import { TenantStatus, SubscriptionTier } from "../generated/platform/enums";

const GENERIC_LOGIN_FAILURE = "Invalid email or password";

const zLoginBody = z.object({
  email: z.string().min(1).meta({ examples: ["owner@nakuru-hardware.co.ke"] }),
  password: z.string().min(1).meta({ description: "Never logged; redacted from request logs." }),
});

const zRefreshBody = z.object({
  refreshToken: z.string().min(1),
});

const zTokenPair = z.object({
  accessToken: z.string().meta({ description: "Short-lived JWT for the Authorization header." }),
  refreshToken: z.string().meta({ description: "Single-use; rotated on every refresh." }),
  expiresAt: z.string().meta({ description: "ISO-8601 expiry of the refresh token." }),
});

const zLoginResponse = zTokenPair.extend({
  user: z.object({
    id: z.string(),
    fullName: z.string(),
    email: z.string(),
    role: zUserRole,
  }),
  tenant: z
    .object({ id: z.string(), name: z.string(), subdomain: z.string() })
    .nullable()
    .meta({ description: "null for platform-scoped Angaza staff." }),
});

const zMeResponse = z.object({
  user: z.object({
    id: z.string(),
    fullName: z.string(),
    email: z.string(),
    role: zUserRole,
    isActive: z.boolean(),
  }),
  role: zUserRole,
  tenant: z
    .object({
      id: z.string(),
      subdomain: z.string(),
      status: z.enum(TenantStatus),
      subscriptionTier: z.enum(SubscriptionTier),
    })
    .nullable(),
});

// The ONE answer to a reset request, whether or not the email has an account.
const PASSWORD_RESET_REQUESTED_MESSAGE =
  "If an account exists for that email, a reset code has been sent to it.";

const zForgotPasswordBody = z.object({
  email: z.string().trim().min(1).max(320).meta({ examples: ["owner@nakuru-hardware.co.ke"] }),
});

const zForgotPasswordResponse = z.object({
  message: z.string().meta({ description: "Always the same text: it never reveals whether the account exists." }),
});

const zResetPasswordBody = z.object({
  token: z.string().min(1).max(512).meta({ description: "The reset code from the notification. Never logged." }),
  newPassword: z.string().min(1).max(1024).meta({ description: "At least 10 characters. Never logged." }),
});

const zChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024).meta({ description: "Never logged." }),
  newPassword: z.string().min(1).max(1024).meta({ description: "At least 10 characters. Never logged." }),
});

function sessionMeta(request: FastifyRequest): SessionMeta {
  const userAgent = request.headers["user-agent"];
  return {
    userAgent: typeof userAgent === "string" ? userAgent : null,
    ipAddress: request.ip,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  // Login and refresh opt into the AUTH tier (src/plugins/security.ts registers
  // the rate limiter once, app-wide). Login's hook runs at preHandler so the parsed
  // body (email) is available to its key generator: the budget is per IP+email.
  api.route({
    method: "POST",
    url: "/login",
    config: {
      rateLimit: {
        ...RATE_LIMITS.AUTH,
        hook: "preHandler",
        keyGenerator: (request: FastifyRequest): string => {
          const body = request.body as { email?: unknown } | undefined;
          const email =
            typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
          return `${request.ip}:${email}`;
        },
      },
    },
    schema: {
      tags: ["Auth"],
      summary: "Log in and receive a token pair",
      description:
        "Public. Rate-limited per IP+email. The response's accessToken carries the user, role and tenant; every other endpoint derives the tenant schema from it, never from a request field.",
      security: PUBLIC,
      body: zLoginBody,
      response: {
        200: zLoginResponse,
        ...errorResponses(400, 401, 403, 429),
      },
    },
    handler: async (request, reply) => {
      const { email, password } = request.body;

      const normalizedEmail = email.trim().toLowerCase();
      const user = await platformDb.user.findUnique({
        where: { email: normalizedEmail },
        include: { tenant: { select: { id: true, name: true, subdomain: true } } },
      });

      // Always run a password verification (dummy when the user or hash is
      // absent) so response timing does not distinguish the failure modes.
      const passwordOk = await verifyPassword(password, user?.passwordHash ?? null);
      if (user === null || !passwordOk || !user.isActive) {
        return reply.code(401).send(unauthorized(GENERIC_LOGIN_FAILURE));
      }

      // A tenant-scoped user cannot log in if their tenant is not ACTIVE.
      if (user.tenantId !== null) {
        try {
          await resolveTenantContext(user.tenantId);
        } catch (error) {
          if (error instanceof TenantUnavailableError) {
            return reply.code(403).send(forbidden("Your tenant is not active."));
          }
          throw error;
        }
      }

      const issued = await issueSession(
        app.signAccessToken,
        { id: user.id, tenantId: user.tenantId, role: user.role },
        sessionMeta(request),
      );

      await platformDb.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      return reply.code(200).send({
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: issued.expiresAt.toISOString(),
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          role: user.role,
        },
        tenant:
          user.tenant === null
            ? null
            : { id: user.tenant.id, name: user.tenant.name, subdomain: user.tenant.subdomain },
      });
    },
  });

  api.route({
    method: "POST",
    url: "/refresh",
    // Per client IP: a refresh token is a bearer secret, so token-guessing and
    // replay floods are throttled exactly like password guessing.
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Auth"],
      summary: "Rotate a refresh token",
      description:
        "Public. Rate-limited per IP. Exchanges a refresh token for a new pair; the presented token is revoked. Reusing a revoked token fails.",
      security: PUBLIC,
      body: zRefreshBody,
      response: { 200: zTokenPair, ...errorResponses(400, 401, 429) },
    },
    handler: async (request, reply) => {
      try {
        const rotated = await rotateSession(
          app.signAccessToken,
          request.body.refreshToken,
          sessionMeta(request),
        );
        return reply.code(200).send({
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
          expiresAt: rotated.expiresAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof RefreshTokenError) {
          return reply.code(401).send(unauthorized("Invalid refresh token."));
        }
        throw error;
      }
    },
  });

  // ---- Account recovery + password lifecycle (Task T-A4) ------------------
  // All three are on the AUTH rate-limit tier (per client IP).

  api.route({
    method: "POST",
    url: "/password/forgot",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Auth"],
      summary: "Request a password reset code",
      description:
        "Public, rate-limited per IP. **Enumeration-safe:** always answers 202 with the same body, whether or not the email belongs to an account. When it does, a single-use code (valid for PASSWORD_RESET_TTL_MINUTES) is sent to the account's email; the code is stored only as a hash.",
      security: PUBLIC,
      body: zForgotPasswordBody,
      response: { 202: zForgotPasswordResponse, ...errorResponses(400, 429) },
    },
    handler: async (request, reply) => {
      const { delivery } = await requestPasswordReset({ email: request.body.email, ipAddress: request.ip });
      // Delivery runs OFF the request path, so its latency cannot distinguish a real
      // account from a miss. Its outcome is recorded in notification_logs; an
      // unexpected failure is logged here by NAME only (never the body).
      if (delivery !== null) {
        delivery.catch((error: unknown) => {
          request.log.error(
            { errorName: error instanceof Error ? error.name : "unknown" },
            "password reset notification could not be dispatched",
          );
        });
      }
      return reply.code(202).send({ message: PASSWORD_RESET_REQUESTED_MESSAGE });
    },
  });

  api.route({
    method: "POST",
    url: "/password/reset",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Auth"],
      summary: "Set a new password with a reset code",
      description:
        "Public, rate-limited per IP. Consumes a valid, unexpired, unused code ONCE, sets the new password (at least 10 characters) and signs the account out everywhere — every session is revoked and nobody is signed in by this call. An unknown, expired or used code gets the same 400.",
      security: PUBLIC,
      body: zResetPasswordBody,
      response: { 204: z.void().meta({ description: "Password reset." }), ...errorResponses(400, 429) },
    },
    handler: async (request, reply) => {
      try {
        await resetPassword({ token: request.body.token, newPassword: request.body.newPassword, ipAddress: request.ip });
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof InvalidResetTokenError || error instanceof PasswordPolicyError) {
          return reply.code(400).send(badRequest(error.message));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "POST",
    url: "/password/change",
    config: { rateLimit: RATE_LIMITS.AUTH },
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Change your own password",
      description:
        "Requires the current password. Sets the new one (at least 10 characters) and revokes every OTHER session of the user; the session making the change stays signed in.",
      security: SECURE,
      body: zChangePasswordBody,
      response: { 204: z.void().meta({ description: "Password changed." }), ...errorResponses(400, 401, 429) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(unauthorized("Authentication required."));
      }
      try {
        await changePassword({
          userId: auth.userId,
          sessionId: auth.sessionId,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
          ipAddress: request.ip,
        });
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof CurrentPasswordIncorrectError || error instanceof PasswordPolicyError) {
          return reply.code(400).send(badRequest(error.message));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "POST",
    url: "/logout",
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Revoke the current session",
      security: SECURE,
      response: { 204: z.void().meta({ description: "No content." }), ...errorResponses(401) },
    },
    handler: async (request, reply) => {
      // requireAuth guarantees auth is non-null here.
      const auth = request.auth;
      if (auth !== null) {
        await revokeSession(auth.sessionId);
      }
      return reply.code(204).send();
    },
  });

  api.route({
    method: "POST",
    url: "/logout-all",
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Revoke every session for the current user",
      security: SECURE,
      response: { 204: z.void().meta({ description: "No content." }), ...errorResponses(401) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth !== null) {
        await revokeAllUserSessions(auth.userId);
      }
      return reply.code(204).send();
    },
  });

  api.route({
    method: "GET",
    url: "/me",
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "The current session's user and tenant",
      security: SECURE,
      response: { 200: zMeResponse, ...errorResponses(401) },
    },
    handler: async (request, reply) => {
      const auth = request.auth;
      if (auth === null) {
        return reply.code(401).send(unauthorized("Authentication required."));
      }

      const user = await platformDb.user.findUnique({
        where: { id: auth.userId },
        select: { id: true, fullName: true, email: true, role: true, isActive: true },
      });
      if (user === null) {
        return reply.code(401).send(unauthorized("Account no longer exists."));
      }

      return reply.code(200).send({
        user,
        role: auth.role,
        tenant:
          auth.tenant === null
            ? null
            : {
                id: auth.tenant.tenantId,
                subdomain: auth.tenant.subdomain,
                status: auth.tenant.status,
                subscriptionTier: auth.tenant.subscriptionTier,
              },
      });
    },
  });
}
