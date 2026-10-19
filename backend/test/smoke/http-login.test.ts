// ===========================================================================
// THE HTTP LOGIN SMOKE: log a seeded user in over HTTP, against the REAL app.
//
// Since Task T-A2, src/server.ts exports buildServer() and listens only when it is
// the entrypoint, so this file imports the whole app — helmet, the rate limiter,
// docs, auth and every route, exactly as production wires them — and drives it with
// app.inject(). No socket is opened and no port is bound. (T-A1 had to assemble the
// auth surface by hand because importing server.ts used to listen on a port.)
//
// app.close() runs buildServer()'s onClose hook, which ends this file's pool, so it
// is the last thing afterAll does.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../../src/auth/password";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { FIXTURE_SUBDOMAIN, tenantIdOf } from "../setup/tenant";

const email = `qa-owner-${randomUUID().slice(0, 8)}@test.invalid`;
let password = "";
let userId = "";
let app: FastifyInstance;

beforeAll(async () => {
  const seedPassword = process.env["SEED_PASSWORD"];
  if (seedPassword === undefined || seedPassword === "") {
    throw new Error("SEED_PASSWORD must be set in the test environment.");
  }
  password = seedPassword;
  const user = await platformDb.user.create({
    data: {
      email,
      fullName: "QA Fixture Owner",
      role: "MSME_OWNER",
      tenantId: await tenantIdOf(FIXTURE_SUBDOMAIN),
      passwordHash: await hashPassword(password),
    },
  });
  userId = user.id;

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  // Sessions cascade with the user.
  await platformDb.user.delete({ where: { id: userId } });
  await app.close();
});

describe("POST /v1/auth/login", () => {
  it("authenticates a seeded tenant user and returns a token pair scoped to their tenant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    expect(body).toMatchObject({
      user: { id: userId, email, role: "MSME_OWNER" },
      tenant: { subdomain: FIXTURE_SUBDOMAIN },
    });
    expect(body).toHaveProperty("accessToken", expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/));
    expect(body).toHaveProperty("refreshToken", expect.any(String));
    const sessions = await platformDb.session.count({ where: { userId } });
    expect(sessions).toBe(1);
  });

  it("refuses a wrong password with the generic 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: `${password}-wrong` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ statusCode: 401, error: "Unauthorized" });
  });
});
