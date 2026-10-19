// ===========================================================================
// Staff-management fixtures (Task T-A5).
//
// Two businesses — the shared fixture tenant A and a tenant B this file's callers
// provision for themselves — plus users created straight into the platform table, so
// a test controls EXACTLY who is an owner where (the last-owner guard depends on it).
// Users are removed by the caller; tenant B is dropped with its users (cascade).
// Audit rows the tests write stay, by design (append-only, no foreign keys).
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../../src/auth/password";
import { platformDb } from "../../src/db/platform";
import type { UserRole } from "../../src/generated/platform/enums";
import { accessTokenFor, type TestUser } from "../security/http-app";

export interface StaffUser extends TestUser {
  readonly role: UserRole;
  readonly tenantId: string | null;
}

let passwordHashCache: { plain: string; hash: string } | null = null;

async function seedPasswordHash(): Promise<{ plain: string; hash: string }> {
  const plain = process.env["SEED_PASSWORD"];
  if (plain === undefined || plain === "") {
    throw new Error("SEED_PASSWORD must be set in the test environment.");
  }
  if (passwordHashCache === null || passwordHashCache.plain !== plain) {
    passwordHashCache = { plain, hash: await hashPassword(plain) };
  }
  return passwordHashCache;
}

export async function createStaffUser(role: UserRole, tenantId: string | null): Promise<StaffUser> {
  const { plain, hash } = await seedPasswordHash();
  const email = `qa-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.invalid`;
  const user = await platformDb.user.create({
    data: { email, fullName: `QA ${role}`, role, tenantId, passwordHash: hash },
  });
  return { id: user.id, email, password: plain, role, tenantId };
}

export interface SignedIn {
  readonly user: StaffUser;
  readonly token: string;
}

export async function signIn(app: FastifyInstance, user: StaffUser): Promise<SignedIn> {
  return { user, token: await accessTokenFor(app, user) };
}

export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
