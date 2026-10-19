import { createHash, randomBytes } from "node:crypto";
import { platformDb } from "../db/platform";
import type { UserRole } from "../generated/platform/enums";
import { env } from "../config/env";

// Claims carried by the access token. `tid` is null for platform-scoped users
// (SUPER_ADMIN / PROGRAM_OFFICER) who belong to no tenant schema.
export interface AccessTokenClaims {
  sub: string; // userId
  tid: string | null; // tenantId
  role: UserRole;
  sid: string; // session id
}

// A closure supplied by the auth plugin that signs claims into an HS256 JWT
// with iat/exp set. Keeping this as an injected function keeps the token
// service free of any Fastify dependency.
export type SignAccessToken = (claims: AccessTokenClaims) => string;

export interface SessionUser {
  id: string;
  tenantId: string | null;
  role: UserRole;
}

export interface SessionMeta {
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date; // access-token expiry, i.e. when the client should refresh
  sessionId: string;
}

// Distinct, catchable error the refresh route maps to 401. A replay is flagged
// separately so callers can log it, though both surface as 401 to the client.
export class RefreshTokenError extends Error {
  readonly code: "INVALID" | "EXPIRED" | "REVOKED_REPLAY";
  constructor(code: "INVALID" | "EXPIRED" | "REVOKED_REPLAY", message: string) {
    super(message);
    this.name = "RefreshTokenError";
    this.code = code;
  }
}

const REFRESH_TOKEN_BYTES = 48;

function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function issueSession(
  signAccessToken: SignAccessToken,
  user: SessionUser,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const now = Date.now();
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const sessionExpiresAt = new Date(now + env.refreshTokenTtlSeconds * 1000);

  const session = await platformDb.session.create({
    data: {
      userId: user.id,
      refreshTokenHash,
      expiresAt: sessionExpiresAt,
      userAgent: meta.userAgent ?? null,
      ipAddress: meta.ipAddress ?? null,
    },
  });

  const accessToken = signAccessToken({
    sub: user.id,
    tid: user.tenantId,
    role: user.role,
    sid: session.id,
  });

  const accessTokenExpiresAt = new Date(
    now + env.accessTokenTtlSeconds * 1000,
  );

  return {
    accessToken,
    refreshToken,
    expiresAt: accessTokenExpiresAt,
    sessionId: session.id,
  };
}

export async function rotateSession(
  signAccessToken: SignAccessToken,
  refreshToken: string,
  meta: SessionMeta,
): Promise<IssuedSession> {
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const existing = await platformDb.session.findUnique({
    where: { refreshTokenHash },
  });

  if (existing === null) {
    throw new RefreshTokenError("INVALID", "Refresh token not recognised.");
  }

  // A refresh token that has already been rotated away (revoked) is being
  // presented again: this is the signature of a stolen-token replay. Revoke
  // every session for the user and refuse.
  if (existing.revokedAt !== null) {
    await revokeAllUserSessions(existing.userId);
    throw new RefreshTokenError(
      "REVOKED_REPLAY",
      "Refresh token has already been used; all sessions revoked.",
    );
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new RefreshTokenError("EXPIRED", "Refresh token has expired.");
  }

  const user = await platformDb.user.findUnique({
    where: { id: existing.userId },
    select: { id: true, tenantId: true, role: true, isActive: true },
  });
  if (user === null || !user.isActive) {
    // Revoke the presented session so a deactivated user cannot keep rotating.
    await revokeSession(existing.id);
    throw new RefreshTokenError(
      "INVALID",
      "User is no longer active.",
    );
  }

  const now = Date.now();
  const newRefreshToken = generateRefreshToken();
  const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
  const sessionExpiresAt = new Date(now + env.refreshTokenTtlSeconds * 1000);

  // Rotate atomically: revoke the presented session and create its successor in
  // one transaction so a crash cannot leave two live tokens or none.
  const created = await platformDb.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
    return tx.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: newRefreshTokenHash,
        expiresAt: sessionExpiresAt,
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
      },
    });
  });

  const accessToken = signAccessToken({
    sub: user.id,
    tid: user.tenantId,
    role: user.role,
    sid: created.id,
  });

  const accessTokenExpiresAt = new Date(now + env.accessTokenTtlSeconds * 1000);

  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: accessTokenExpiresAt,
    sessionId: created.id,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await platformDb.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await platformDb.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
