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
import { forbidden, unauthorized } from "../schemas/common";

// Resolved, verified identity for a request. tenantId/tenant are null for
// platform-scoped users (SUPER_ADMIN / PROGRAM_OFFICER).
export interface AuthContext {
  userId: string;
  role: UserRole;
  tenantId: string | null;
  sessionId: string;
  tenant: TenantContext | null;
}

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
      select: { id: true, userId: true, revokedAt: true, expiresAt: true },
    });
    if (
      session === null ||
      session.userId !== claims.sub ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      return reply.code(401).send(unauthorized("Session is no longer valid."));
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
    };
    return undefined;
  };
  app.decorate("requireAuth", requireAuth);

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
}
