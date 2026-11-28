import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RATE_LIMITS } from "../plugins/security";
import { platformDb } from "../db/platform";
import { verifyPassword } from "../auth/password";
import {
  issueSession,
  rotateSession,
  listLiveSessions,
  revokeAllUserSessions,
  revokeSession,
  revokeUserSession,
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
import {
  beginLogin,
  ChallengePasswordError,
  completeMfaStage,
  completePasswordStage,
  confirmEnrollmentStage,
  InvalidChallengeError,
  startEnrollmentStage,
  type ChallengeStage,
  type StageOutcome,
} from "../services/identity/login-flow";
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableOwnMfa,
  getMfaStatus,
  InvalidMfaCodeError,
  MfaStateError,
  regenerateBackupCodes,
  stepUpSession,
} from "../services/identity/mfa";
import { recordAudit } from "../services/identity/audit";
import { env } from "../config/env";
import { zUserRole } from "../schemas/models";
import { badRequest, errorBody, errorResponses, forbidden, notFound, PUBLIC, SECURE, unauthorized } from "../schemas/common";
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
  status: z.literal("AUTHENTICATED").meta({ description: "A session was issued (M4.5 W1: the other answer is a challenge)." }),
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

// M4.5 W1 — a correct password that still owes a step answers with a CHALLENGE, never a session.
const zLoginChallenge = z
  .object({
    status: z.enum(["MFA_REQUIRED", "PASSWORD_RESET_REQUIRED", "MFA_ENROLLMENT_REQUIRED"]).meta({
      description:
        "The next step: MFA_REQUIRED (send a TOTP or backup code to /login/mfa), PASSWORD_RESET_REQUIRED (send a new password to /login/password), MFA_ENROLLMENT_REQUIRED (an administrator without MFA: /login/mfa-enrollment/start then /confirm).",
    }),
    challengeToken: z.string().meta({ description: "Single-use, short-lived; spent stage by stage. Never logged." }),
    expiresAt: z.string().meta({ description: "ISO-8601 expiry of the challenge." }),
  })
  .meta({ id: "LoginChallenge" });

const zLoginResult = z.union([zLoginResponse, zLoginChallenge]).meta({
  description: "Either a session (status AUTHENTICATED) or a challenge naming the next step.",
});

const zChallengeCodeBody = z.object({
  challengeToken: z.string().min(1).max(512),
  code: z.string().trim().min(6).max(32).meta({ description: "A 6-digit authenticator code or a backup code. Never logged." }),
});

const zChallengePasswordBody = z.object({
  challengeToken: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(1024).meta({ description: "At least 10 characters, and not the issued one. Never logged." }),
});

const zChallengeOnlyBody = z.object({ challengeToken: z.string().min(1).max(512) });

const zMfaEnrollmentStart = z.object({
  secret: z.string().meta({ description: "Base32 secret, shown ONCE for manual entry; never returned again. Never logged." }),
  otpauthUri: z.string().meta({ description: "otpauth://totp/… — render as a QR code. Never logged." }),
});

const zBackupCodes = z.object({
  backupCodes: z.array(z.string()).meta({ description: "Ten one-time recovery codes, shown ONCE (stored only as hashes). Never logged." }),
});

const zEnrollmentConfirmResult = zBackupCodes.extend({ result: zLoginResult });

const zCodeBody = z.object({
  code: z.string().trim().min(6).max(32).meta({ description: "A 6-digit authenticator code or a backup code. Never logged." }),
});

const zMfaStatus = z.object({
  enabled: z.boolean(),
  required: z.boolean().meta({ description: "True for SUPER_ADMIN and PROGRAM_OFFICER: MFA cannot be turned off." }),
  enrolledAt: z.date().nullable(),
  backupCodesRemaining: z.number().int(),
});

const zDisableMfaBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  code: z.string().trim().min(6).max(32),
});

const zStepUpResult = z.object({
  stepUpAt: z.date(),
  validUntil: z.date().meta({ description: "Sensitive actions accept this step-up until then." }),
});

const zSessionView = z.object({
  id: z.string(),
  issuedAt: z.date(),
  expiresAt: z.date(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  mfaVerified: z.boolean(),
  current: z.boolean(),
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
      name: z.string().meta({ description: "The business's display name (T-B-ME-NAME) — read now, so a renamed business shows its new name." }),
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

async function tenantIsActive(tenantId: string): Promise<boolean> {
  try {
    await resolveTenantContext(tenantId);
    return true;
  } catch (error) {
    if (error instanceof TenantUnavailableError) {
      return false;
    }
    throw error;
  }
}

function challengeBody(challenge: { status: ChallengeStage; challengeToken: string; expiresAt: Date }) {
  return { status: challenge.status, challengeToken: challenge.challengeToken, expiresAt: challenge.expiresAt.toISOString() };
}

/**
 * Issues the session once a login owes nothing more. Re-reads the user: still active, no
 * forced reset pending, tenant still ACTIVE. Returns null when that no longer holds.
 */
async function completeLogin(app: FastifyInstance, userId: string, mfaVerifiedAt: Date | null, request: FastifyRequest) {
  const user = await platformDb.user.findUnique({
    where: { id: userId },
    include: { tenant: { select: { id: true, name: true, subdomain: true } } },
  });
  if (user === null || !user.isActive || user.mustResetPassword) {
    return null;
  }
  if (user.tenantId !== null && !(await tenantIsActive(user.tenantId))) {
    return null;
  }
  const issued = await issueSession(
    app.signAccessToken,
    { id: user.id, tenantId: user.tenantId, role: user.role },
    { ...sessionMeta(request), mfaVerifiedAt },
  );
  await platformDb.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return {
    status: "AUTHENTICATED" as const,
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresAt: issued.expiresAt.toISOString(),
    user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role },
    tenant: user.tenant === null ? null : { id: user.tenant.id, name: user.tenant.name, subdomain: user.tenant.subdomain },
  };
}

async function stageResult(app: FastifyInstance, outcome: StageOutcome, request: FastifyRequest) {
  if (outcome.status !== "COMPLETE") {
    return challengeBody(outcome);
  }
  return completeLogin(app, outcome.userId, outcome.mfaVerifiedAt, request);
}

/** Maps a stage or MFA refusal to the one error shape; rethrows a defect. */
function sendMfaError(error: unknown, reply: FastifyReply) {
  if (error instanceof InvalidChallengeError) {
    return reply.code(401).send(errorBody(401, "ChallengeInvalid", error.message));
  }
  if (error instanceof InvalidMfaCodeError) {
    return reply.code(401).send(errorBody(401, "InvalidCode", error.message));
  }
  if (error instanceof ChallengePasswordError) {
    return reply.code(400).send(badRequest(error.message));
  }
  if (error instanceof MfaStateError) {
    const name = error.status === 409 ? "Conflict" : error.status === 403 ? "Forbidden" : error.status === 404 ? "NotFound" : "BadRequest";
    return reply.code(error.status).send(errorBody(error.status, name, error.message));
  }
  throw error;
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
      summary: "Log in — a token pair, or the next login step",
      description:
        "Public. Rate-limited per IP+email. When the account owes nothing more, a session (status AUTHENTICATED): the accessToken carries the user, role and tenant, and every other endpoint derives the tenant schema from it, never from a request field. Otherwise (M4.5 W1) a challenge naming the next step: MFA_REQUIRED, PASSWORD_RESET_REQUIRED (forced reset on first login) or MFA_ENROLLMENT_REQUIRED (a SUPER_ADMIN or PROGRAM_OFFICER without MFA — they can never sign in without a second factor).",
      security: PUBLIC,
      body: zLoginBody,
      response: {
        200: zLoginResult,
        ...errorResponses(400, 401, 403, 429),
      },
    },
    handler: async (request, reply) => {
      const { email, password } = request.body;

      const normalizedEmail = email.trim().toLowerCase();
      const user = await platformDb.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, role: true, tenantId: true, isActive: true, passwordHash: true, mfaEnabled: true, mustResetPassword: true },
      });

      // Always run a password verification (dummy when the user or hash is
      // absent) so response timing does not distinguish the failure modes.
      const passwordOk = await verifyPassword(password, user?.passwordHash ?? null);
      if (user === null || !passwordOk || !user.isActive) {
        return reply.code(401).send(unauthorized(GENERIC_LOGIN_FAILURE));
      }

      // A tenant-scoped user cannot log in if their tenant is not ACTIVE.
      if (user.tenantId !== null && !(await tenantIsActive(user.tenantId))) {
        return reply.code(403).send(forbidden("Your tenant is not active."));
      }

      // M4.5 W1: MFA, a forced reset or an admin enrolment still owed -> a challenge.
      const challenge = await beginLogin(user, request.ip);
      if (challenge !== null) {
        return reply.code(200).send(challengeBody(challenge));
      }
      const completed = await completeLogin(app, user.id, null, request);
      return completed === null
        ? reply.code(401).send(unauthorized(GENERIC_LOGIN_FAILURE))
        : reply.code(200).send(completed);
    },
  });

  // ---- The staged login (M4.5 W1) -----------------------------------------------
  // Each stage spends the challenge /login issued. All are public and on the AUTH tier.

  api.route({
    method: "POST",
    url: "/login/mfa",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Auth"],
      summary: "Login stage: prove the second factor",
      description:
        "Public, rate-limited per IP. A 6-digit authenticator code (each code is accepted ONCE — a replay is refused) or an unused backup code (burned on use). A wrong code counts against the challenge; after LOGIN_CHALLENGE_MAX_ATTEMPTS it is burned and the user signs in again with their password.",
      security: PUBLIC,
      body: zChallengeCodeBody,
      response: { 200: zLoginResult, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        const outcome = await completeMfaStage(request.body.challengeToken, request.body.code, request.ip);
        const result = await stageResult(app, outcome, request);
        return result === null ? reply.code(401).send(unauthorized(GENERIC_LOGIN_FAILURE)) : reply.code(200).send(result);
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/login/password",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Auth"],
      summary: "Login stage: set a new password (forced reset on first login)",
      description:
        "Public, rate-limited per IP. The account must choose a new password (at least 10 characters, not the issued one) before ANY access. Every existing session of the account is revoked.",
      security: PUBLIC,
      body: zChallengePasswordBody,
      response: { 200: zLoginResult, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        const outcome = await completePasswordStage(request.body.challengeToken, request.body.newPassword, request.ip);
        const result = await stageResult(app, outcome, request);
        return result === null ? reply.code(401).send(unauthorized(GENERIC_LOGIN_FAILURE)) : reply.code(200).send(result);
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/login/mfa-enrollment/start",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Auth"],
      summary: "Login stage: start the required MFA enrolment",
      description:
        "Public, rate-limited per IP. For a SUPER_ADMIN or PROGRAM_OFFICER without MFA: a fresh authenticator secret (stored encrypted; shown ONCE) and its otpauth URI. Calling it again replaces an unconfirmed secret.",
      security: PUBLIC,
      body: zChallengeOnlyBody,
      response: { 200: zMfaEnrollmentStart, ...errorResponses(400, 401, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await startEnrollmentStage(request.body.challengeToken));
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/login/mfa-enrollment/confirm",
    config: { rateLimit: RATE_LIMITS.AUTH },
    schema: {
      tags: ["Auth"],
      summary: "Login stage: confirm the MFA enrolment",
      description:
        "Public, rate-limited per IP. A code from the new authenticator turns MFA on, returns ten one-time backup codes (shown ONCE) and continues the login.",
      security: PUBLIC,
      body: zChallengeCodeBody,
      response: { 200: zEnrollmentConfirmResult, ...errorResponses(400, 401, 403, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        const { backupCodes, next } = await confirmEnrollmentStage(request.body.challengeToken, request.body.code, request.ip);
        const result = await stageResult(app, next, request);
        return result === null
          ? reply.code(401).send(unauthorized(GENERIC_LOGIN_FAILURE))
          : reply.code(200).send({ backupCodes, result });
      } catch (error) {
        return sendMfaError(error, reply);
      }
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

      const found = await platformDb.user.findUnique({
        where: { id: auth.userId },
        select: { id: true, fullName: true, email: true, role: true, isActive: true, tenant: { select: { name: true } } },
      });
      if (found === null) {
        return reply.code(401).send(unauthorized("Account no longer exists."));
      }
      const { tenant: business, ...user } = found;

      return reply.code(200).send({
        user,
        role: auth.role,
        tenant:
          auth.tenant === null
            ? null
            : {
                id: auth.tenant.tenantId,
                name: business?.name ?? auth.tenant.subdomain,
                subdomain: auth.tenant.subdomain,
                status: auth.tenant.status,
                subscriptionTier: auth.tenant.subscriptionTier,
              },
      });
    },
  });

  // ---- MFA management (M4.5 W1) ---------------------------------------------------
  // For a signed-in user: status, opt-in enrolment, backup codes, turning it off (not for
  // an administrator) and the step-up a sensitive action requires.

  const currentAuth = (request: FastifyRequest) => {
    const auth = request.auth;
    if (auth === null) {
      throw new Error("requireAuth guarantees an authenticated request here.");
    }
    return auth;
  };

  api.route({
    method: "GET",
    url: "/mfa",
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Your two-step verification status",
      security: SECURE,
      response: { 200: zMfaStatus, ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => reply.code(200).send(await getMfaStatus(currentAuth(request).userId)),
  });

  api.route({
    method: "POST",
    url: "/mfa/setup",
    config: { rateLimit: RATE_LIMITS.AUTH },
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Start setting up an authenticator (opt-in)",
      description:
        "A fresh authenticator secret (stored encrypted; shown ONCE) and its otpauth URI. Refused while MFA is already on. Calling it again replaces an unconfirmed secret.",
      security: SECURE,
      response: { 200: zMfaEnrollmentStart, ...errorResponses(401, 403, 404, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send(await beginMfaEnrollment(platformDb, currentAuth(request).userId));
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/mfa/confirm",
    config: { rateLimit: RATE_LIMITS.AUTH },
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Confirm the authenticator and turn two-step verification on",
      description:
        "A code from the new authenticator turns MFA on and returns ten one-time backup codes (shown ONCE). Every OTHER session of the account is revoked; this one is marked MFA-verified.",
      security: SECURE,
      body: zCodeBody,
      response: { 200: zBackupCodes, ...errorResponses(400, 401, 403, 404, 409, 429) },
    },
    handler: async (request, reply) => {
      const auth = currentAuth(request);
      try {
        const backupCodes = await platformDb.$transaction(async (tx) => {
          const codes = await confirmMfaEnrollment(tx, auth.userId, request.body.code, { ipAddress: request.ip });
          const now = new Date();
          await tx.session.update({ where: { id: auth.sessionId }, data: { mfaVerifiedAt: now } });
          await tx.session.updateMany({
            where: { userId: auth.userId, revokedAt: null, id: { not: auth.sessionId } },
            data: { revokedAt: now },
          });
          return codes;
        });
        return reply.code(200).send({ backupCodes });
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/mfa/disable",
    config: { rateLimit: RATE_LIMITS.AUTH },
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Turn your opt-in two-step verification off",
      description:
        "Requires your password AND a current code. Refused (403) for SUPER_ADMIN and PROGRAM_OFFICER, for whom MFA is not optional.",
      security: SECURE,
      body: zDisableMfaBody,
      response: { 204: z.void().meta({ description: "MFA is off." }), ...errorResponses(400, 401, 403, 409, 429) },
    },
    handler: async (request, reply) => {
      try {
        await disableOwnMfa(currentAuth(request).userId, request.body, { ipAddress: request.ip });
        return reply.code(204).send();
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/mfa/backup-codes",
    config: { rateLimit: RATE_LIMITS.AUTH },
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Replace your backup codes",
      description: "After a fresh code: ten new one-time backup codes (shown ONCE); the old set stops working.",
      security: SECURE,
      body: zCodeBody,
      response: { 200: zBackupCodes, ...errorResponses(400, 401, 403, 429) },
    },
    handler: async (request, reply) => {
      try {
        return reply.code(200).send({ backupCodes: await regenerateBackupCodes(currentAuth(request).userId, request.body.code, { ipAddress: request.ip }) });
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  api.route({
    method: "POST",
    url: "/mfa/step-up",
    config: { rateLimit: RATE_LIMITS.AUTH },
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Step up: prove a fresh code before a sensitive action",
      description:
        "On a session opened with two-step verification: a fresh code (each TOTP accepted once) opens a short window (STEP_UP_TTL_SECONDS) in which sensitive administrator actions — creating a support-access grant, resetting someone's MFA or password — are accepted.",
      security: SECURE,
      body: zCodeBody,
      response: { 200: zStepUpResult, ...errorResponses(400, 401, 403, 404, 409, 429) },
    },
    handler: async (request, reply) => {
      const auth = currentAuth(request);
      try {
        const stepUpAt = await stepUpSession(auth.userId, auth.sessionId, request.body.code, { ipAddress: request.ip });
        return reply.code(200).send({ stepUpAt, validUntil: new Date(stepUpAt.getTime() + env.stepUpTtlSeconds * 1000) });
      } catch (error) {
        return sendMfaError(error, reply);
      }
    },
  });

  // ---- Your sessions (M4.5 W1) ----------------------------------------------------

  api.route({
    method: "GET",
    url: "/sessions",
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Your signed-in sessions",
      security: SECURE,
      response: { 200: z.object({ data: z.array(zSessionView) }), ...errorResponses(401, 403) },
    },
    handler: async (request, reply) => {
      const auth = currentAuth(request);
      const sessions = await listLiveSessions(auth.userId);
      return reply.code(200).send({
        data: sessions.map(({ mfaVerifiedAt, ...rest }) => ({ ...rest, mfaVerified: mfaVerifiedAt !== null, current: rest.id === auth.sessionId })),
      });
    },
  });

  api.route({
    method: "DELETE",
    url: "/sessions/:id",
    preHandler: app.requireAuth,
    schema: {
      tags: ["Auth"],
      summary: "Sign one of your sessions out",
      description: "Revokes ONE of your own live sessions at once. Another account's session id is 404.",
      security: SECURE,
      params: z.object({ id: z.string().min(1) }),
      response: { 204: z.void().meta({ description: "Revoked." }), ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const auth = currentAuth(request);
      if (!(await revokeUserSession(auth.userId, request.params.id))) {
        return reply.code(404).send(notFound("No such live session on your account."));
      }
      await recordAudit(platformDb, {
        action: "SESSION_REVOKED",
        actorUserId: auth.userId,
        targetUserId: auth.userId,
        tenantId: auth.tenantId,
        ipAddress: request.ip,
        metadata: { sessionId: request.params.id },
      });
      return reply.code(204).send();
    },
  });
}
