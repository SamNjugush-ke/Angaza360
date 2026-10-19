// ===========================================================================
// CHANGING YOUR OWN PASSWORD (Task T-A4), through the REAL app.
//
// POST /v1/auth/password/change requires the CURRENT password, enforces the policy,
// sets the new hash and passwordUpdatedAt, and ROTATES sessions: every other session
// of the user is revoked while the one making the change stays signed in. Audited.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { errorBody } from "../../src/schemas/common";
import { buildServer } from "../../src/server";
import { captureOutput } from "../support/log-capture";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";

let app: FastifyInstance;
const users: TestUser[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await deleteUsers(users);
  await app.close();
});

async function newUser(): Promise<TestUser> {
  const user = await createFixtureUser("ACCOUNTANT");
  users.push(user);
  return user;
}

function change(token: string, currentPassword: string, newPassword: string) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/password/change",
    remoteAddress: freshIp(),
    headers: { authorization: `Bearer ${token}` },
    payload: { currentPassword, newPassword },
  });
}

function me(token: string) {
  return app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
}

describe("POST /v1/auth/password/change", () => {
  it("refuses a wrong current password, changing nothing", async () => {
    const user = await newUser();
    const token = await accessTokenFor(app, user);
    const response = await change(token, `${user.password}-wrong`, `New-${randomUUID()}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toStrictEqual(errorBody(400, "BadRequest", "The current password is incorrect."));
    const row = await platformDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordUpdatedAt).toBeNull();
    expect(await platformDb.auditLog.count({ where: { action: "PASSWORD_CHANGED", targetUserId: user.id } })).toBe(0);
  });

  it("enforces the 10-character policy", async () => {
    const user = await newUser();
    const token = await accessTokenFor(app, user);
    const response = await change(token, user.password, "too-short");
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(/at least 10 characters/);
  });

  it("changes the password, keeps THIS session, revokes every OTHER session, and audits it", async () => {
    const user = await newUser();
    const current = await accessTokenFor(app, user);
    const other = await accessTokenFor(app, user);
    expect((await me(other)).statusCode).toBe(200);

    const newPassword = `Changed-${randomUUID()}`;
    const { result: response, output } = await captureOutput(() => change(current, user.password, newPassword));
    expect(response.statusCode).toBe(204);

    expect((await me(current)).statusCode).toBe(200);
    expect((await me(other)).statusCode).toBe(401);
    const row = await platformDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordUpdatedAt).toBeInstanceOf(Date);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: freshIp(),
      payload: { email: user.email, password: user.password },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: freshIp(),
      payload: { email: user.email, password: newPassword },
    });
    expect(newLogin.statusCode).toBe(200);

    const audit = await platformDb.auditLog.findFirstOrThrow({ where: { action: "PASSWORD_CHANGED", targetUserId: user.id } });
    expect(audit).toMatchObject({ actorUserId: user.id, tenantId: row.tenantId });
    expect(output).toContain("/v1/auth/password/change");
    expect(output).not.toContain(newPassword);
    expect(output).not.toContain(user.password);
  });

  it("is refused without a session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/password/change",
      remoteAddress: freshIp(),
      payload: { currentPassword: "x", newPassword: "y" },
    });
    expect(response.statusCode).toBe(401);
  });
});
