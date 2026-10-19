// ===========================================================================
// HTTP helpers for the security suite (Task T-A2).
//
// Every test here drives the REAL app — `buildServer()` from src/server.ts, with
// helmet, the rate limiter, docs, auth and every route exactly as production
// wires them — through app.inject(). No socket is opened and no port is bound.
//
// RATE-LIMIT STATE IS IN-MEMORY AND PER APP, keyed by client IP. Each case that
// counts requests therefore uses its OWN `remoteAddress`, so cases never spend
// one another's budget.
//
// CLOSING THE APP CLOSES THIS FILE'S POOL. buildServer()'s onClose hook ends the
// platform client, the tenant clients and the pg pool, so `app.close()` is the
// LAST thing a file's afterAll does — after any cleanup that still needs the
// database.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../../src/auth/password";
import { platformDb } from "../../src/db/platform";
import type { UserRole } from "../../src/generated/platform/enums";
import { FIXTURE_SUBDOMAIN, tenantIdOf } from "../setup/tenant";

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

/** The exact app-wide headers the security plugin must put on every response. */
export const STRICT_HEADERS = {
  "content-security-policy": "default-src 'none';frame-ancestors 'none';base-uri 'none'",
  "strict-transport-security": "max-age=15552000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const;

let addressCounter = 0;

/** A fresh client IP, so a rate-limit case never shares a budget with another. */
export function freshIp(): string {
  addressCounter += 1;
  return `10.42.${Math.floor(addressCounter / 250).toString()}.${((addressCounter % 250) + 1).toString()}`;
}

function testPassword(): string {
  const seedPassword = process.env["SEED_PASSWORD"];
  if (seedPassword === undefined || seedPassword === "") {
    throw new Error("SEED_PASSWORD must be set in the test environment.");
  }
  return seedPassword;
}

/** A platform user on the fixture tenant. Delete it with deleteUsers() before app.close(). */
export async function createFixtureUser(role: UserRole): Promise<TestUser> {
  const email = `qa-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@test.invalid`;
  const password = testPassword();
  const user = await platformDb.user.create({
    data: {
      email,
      fullName: `QA ${role}`,
      role,
      tenantId: await tenantIdOf(FIXTURE_SUBDOMAIN),
      passwordHash: await hashPassword(password),
    },
  });
  return { id: user.id, email, password };
}

/** Sessions cascade with the user. */
export async function deleteUsers(users: readonly TestUser[]): Promise<void> {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
}

/** Logs in over HTTP from its own IP (so it never spends a test's AUTH budget). */
export async function accessTokenFor(app: FastifyInstance, user: TestUser): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    remoteAddress: freshIp(),
    payload: { email: user.email, password: user.password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed with ${response.statusCode.toString()}: ${response.body}`);
  }
  const body: unknown = response.json();
  if (typeof body !== "object" || body === null || !("accessToken" in body) || typeof body.accessToken !== "string") {
    throw new Error("login response carried no accessToken");
  }
  return body.accessToken;
}
