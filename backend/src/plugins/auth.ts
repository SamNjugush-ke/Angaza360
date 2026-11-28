import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { env } from "../config/env";
import { platformDb } from "../db/platform";
import { getTenantDb } from "../db/tenant";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { UserRole } from "../generated/platform/enums";
import {
  resolveTenantContext,
  TenantUnavailableError,
  type TenantContext,
} from "../auth/tenant-registry";
import type { AccessTokenClaims, SignAccessToken } from "../auth/tokens";
import { errorBody, forbidden, notFound, unauthorized } from "../schemas/common";
import { mfaRequiredFor } from "../auth/mfa-policy";
import { recordAudit } from "../services/identity/audit";

// Resolved, verified identity for a request. tenantId/tenant are null for
// platform-scoped users (SUPER_ADMIN / PROGRAM_OFFICER).
export interface AuthContext {
  userId: string;
  role: UserRole;
  tenantId: string | null;
  sessionId: string;
  tenant: TenantContext | null;
  /** When this session's second factor was proven (M4.5 W1); null for a password-only session. */
  mfaVerifiedAt: Date | null;
  /** The session's last step-up (a fresh code for a sensitive action), if any. */
  stepUpAt: Date | null;
  /**
   * STANDING GOD-MODE (M4.5 W5): set only when a SUPER_ADMIN is ACTING AS a tenant. The session is
   * then presented to every tenant route as an owner of that business (role MSME_OWNER, its tenant
   * context), so the operator operates THROUGH the existing services and every DB integrity and
   * isolation guard stays in force — but the real platform operator is recorded here, and `userId`
   * stays the operator's, so the action is attributed to them. Null for an ordinary request.
   */
  operator: { userId: string; role: UserRole } | null;
}

/** The header a SUPER_ADMIN sends to act as a tenant. Its value is the target business's id. */
export const ACT_AS_TENANT_HEADER = "x-act-as-tenant";

type VerifiedClaims = AccessTokenClaims & { iat: number; exp: number };

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenClaims;
    user: VerifiedClaims;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    signAccessToken: SignAccessToken;
    requireAuth: preHandlerHookHandler;
    requireTenant: preHandlerHookHandler;
    requireRole: (...roles: UserRole[]) => preHandlerHookHandler;
    requireStepUp: preHandlerHookHandler;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
    // Tenant-scoped Prisma client for the authenticated tenant. Throws if the
    // request is unauthenticated or the user is platform-scoped. Never falls
    // back to a default schema.
    tenantDb: TenantPrismaClient;
  }
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined) {
    return null;
  }
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token === undefined || token === "") {
    return null;
  }
  return token;
}

// Registered directly against the root instance (not via `.register()`), so its
// decorators are visible app-wide without fastify-plugin — this is the
// encapsulate:false pattern the task calls for.
export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: env.jwtSecret,
    sign: { algorithm: "HS256" },
  });

  app.decorate("signAccessToken", ((claims: AccessTokenClaims): string =>
    app.jwt.sign(claims, { expiresIn: env.accessTokenTtlSeconds })) as SignAccessToken);

  app.decorateRequest("auth", null);

  app.decorateRequest("tenantDb", {
    getter(this: FastifyRequest): TenantPrismaClient {
      const auth = this.auth;
      if (auth === null) {
        throw new Error(
          "request.tenantDb accessed on an unauthenticated request. Guard the route with requireAuth first.",
        );
      }
      if (auth.tenant === null) {
        throw new Error(
          "request.tenantDb accessed by a platform-scoped user (no tenant schema). Guard the route with requireTenant.",
        );
      }
      return getTenantDb(auth.tenant.dbSchema);
    },
  });

  const requireAuth: preHandlerHookHandler = async (request, reply) => {
    const token = readBearerToken(request);
    if (token === null) {
      return reply.code(401).send(unauthorized("Missing or malformed Authorization header."));
    }

    let claims: VerifiedClaims;
    try {
      claims = await request.jwtVerify<VerifiedClaims>();
    } catch {
      return reply.code(401).send(unauthorized("Invalid or expired access token."));
    }

    // A logout or revocation must invalidate an access token that has not yet
    // reached its JWT expiry — so re-check the session on every request.
    const session = await platformDb.session.findUnique({
      where: { id: claims.sid },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        mfaVerifiedAt: true,
        stepUpAt: true,
        user: { select: { role: true, isActive: true, mustResetPassword: true } },
      },
    });
    if (
      session === null ||
      session.userId !== claims.sub ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now() ||
      !session.user.isActive
    ) {
      return reply.code(401).send(unauthorized("Session is no longer valid."));
    }

    // M4.5 W1. A forced reset is owed before ANY access — a session should not exist for
    // such an account (login issues a challenge, and setting the flag revokes sessions),
    // so this is the backstop that makes the reset un-skippable.
    if (session.user.mustResetPassword) {
      return reply
        .code(403)
        .send(errorBody(403, "PasswordResetRequired", "You must set a new password before continuing. Sign in again."));
    }
    // NO PRIVILEGED ROUTE WITHOUT MFA: an administrator's session must have been opened
    // with a proven second factor. Checked against the account's CURRENT role, not the
    // token's, so a promotion cannot slip an unverified session through.
    if ((mfaRequiredFor(session.user.role) || mfaRequiredFor(claims.role)) && session.mfaVerifiedAt === null) {
      return reply
        .code(403)
        .send(errorBody(403, "MfaRequired", "Two-step verification is required for your role. Sign in again with your authenticator code."));
    }

    let tenant: TenantContext | null = null;
    if (claims.tid !== null) {
      try {
        tenant = await resolveTenantContext(claims.tid);
      } catch (error) {
        if (error instanceof TenantUnavailableError) {
          return reply.code(403).send(forbidden("Your tenant is not active."));
        }
        throw error;
      }
    }

    request.auth = {
      userId: claims.sub,
      role: claims.role,
      tenantId: claims.tid,
      sessionId: claims.sid,
      tenant,
      mfaVerifiedAt: session.mfaVerifiedAt,
      stepUpAt: session.stepUpAt,
      operator: null,
    };

    // STANDING GOD-MODE (M4.5 W5). A SUPER_ADMIN — and ONLY a SUPER_ADMIN — may act as any active
    // business by sending its id in the act-as header. We resolve that tenant through the SAME
    // registry every tenant session uses and present the request to the downstream routes as an
    // OWNER of it (userId stays the operator's, so writes are attributed to them). There is no
    // grant, no prompt, no expiry: the operator has standing access. The admin's own MFA was already
    // enforced above, against the SUPER_ADMIN role in the token — this override happens after it.
    const actAs = request.headers[ACT_AS_TENANT_HEADER];
    if (claims.role === "SUPER_ADMIN" && typeof actAs === "string" && actAs.trim() !== "") {
      let target: TenantContext;
      try {
        target = await resolveTenantContext(actAs.trim());
      } catch (error) {
        if (error instanceof TenantUnavailableError) {
          return reply.code(404).send(notFound("No such active business to act as."));
        }
        throw error;
      }
      request.auth = {
        ...request.auth,
        role: "MSME_OWNER",
        tenantId: target.tenantId,
        tenant: target,
        operator: { userId: claims.sub, role: "SUPER_ADMIN" },
      };
    }
    return undefined;
  };
  app.decorate("requireAuth", requireAuth);

  // STEP-UP (M4.5 W1): a sensitive action needs a fresh second factor on THIS session,
  // proven within STEP_UP_TTL_SECONDS (POST /v1/auth/mfa/step-up). Runs after requireAuth.
  const requireStepUp: preHandlerHookHandler = async (request, reply) => {
    const auth = request.auth;
    if (auth === null) {
      return reply.code(401).send(unauthorized("Authentication required."));
    }
    const fresh =
      auth.mfaVerifiedAt !== null &&
      auth.stepUpAt !== null &&
      Date.now() - auth.stepUpAt.getTime() <= env.stepUpTtlSeconds * 1000;
    if (!fresh) {
      return reply
        .code(403)
        .send(
          errorBody(
            403,
            "StepUpRequired",
            "Confirm it is you: enter a fresh authenticator code (POST /v1/auth/mfa/step-up), then try again.",
          ),
        );
    }
    return undefined;
  };
  app.decorate("requireStepUp", requireStepUp);

  const requireTenant: preHandlerHookHandler = async (request, reply) => {
    if (request.auth === null || request.auth.tenantId === null) {
      return reply
        .code(403)
        .send(
          forbidden("This route requires a tenant context; the current user is platform-scoped."),
        );
    }
    return undefined;
  };
  app.decorate("requireTenant", requireTenant);

  app.decorate("requireRole", (...roles: UserRole[]): preHandlerHookHandler => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.auth === null) {
        return reply.code(401).send(unauthorized("Authentication required."));
      }
      if (!roles.includes(request.auth.role)) {
        return reply.code(403).send(forbidden("Your role does not permit this action."));
      }
      return undefined;
    };
  });

  // GOD-MODE ATTRIBUTION (M4.5 W5). Every request an operator makes while acting as a tenant that
  // the backend did NOT refuse is one OPERATOR_ACTED row: which operator, which business, which
  // route (the template, never ids or a body — no secret), the method and the status. It lands in
  // the internal platform audit log AND, filtered to its tenant, in the OWNER-VISIBLE activity log —
  // where the operator is shown as "Platform operator", never named (`listAuditLog` masks it). The
  // owner cannot approve or block, but always has a truthful record that an operator acted and what
  // they did. Recorded post-response so it never changes what the operation itself did.
  app.addHook("onResponse", async (request, reply) => {
    const operator = request.auth?.operator ?? null;
    const tenantId = request.auth?.tenantId ?? null;
    if (operator === null || tenantId === null || reply.statusCode >= 400) return;
    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? request.url;
    try {
      await recordAudit(platformDb, {
        action: "OPERATOR_ACTED",
        actorUserId: operator.userId,
        targetUserId: null,
        tenantId,
        ipAddress: request.ip,
        metadata: { method: request.method, route, status: reply.statusCode },
      });
    } catch (error) {
      request.log.error({ err: error }, "failed to record an operator (god-mode) action");
    }
  });
}
