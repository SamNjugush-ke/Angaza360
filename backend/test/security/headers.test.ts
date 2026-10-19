// ===========================================================================
// SECURITY HEADERS (Task T-A2): every response — public, authenticated and error —
// carries the strict JSON-API policy from src/plugins/security.ts, value for value.
// ===========================================================================

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server";
import { accessTokenFor, createFixtureUser, deleteUsers, STRICT_HEADERS, type TestUser } from "./http-app";

let app: FastifyInstance;
let owner: TestUser;
let token = "";

function expectStrictHeaders(response: LightMyRequestResponse): void {
  for (const [name, value] of Object.entries(STRICT_HEADERS)) {
    expect(response.headers[name], name).toBe(value);
  }
  // COEP is deliberately NOT enabled (it breaks swagger-ui).
  expect(response.headers["cross-origin-embedder-policy"]).toBeUndefined();
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  owner = await createFixtureUser("MSME_OWNER");
  token = await accessTokenFor(app, owner);
});

afterAll(async () => {
  await deleteUsers([owner]);
  await app.close();
});

describe("strict security headers", () => {
  it("a public response (GET /health) carries every strict header", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expectStrictHeaders(response);
  });

  it("an authenticated JSON response (GET /v1/auth/me) carries every strict header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toMatchObject({ user: { id: owner.id }, role: "MSME_OWNER" });
    expectStrictHeaders(response);
  });

  it("an error response (401 and an unknown route's 404) carries them too", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(unauthenticated.statusCode).toBe(401);
    expectStrictHeaders(unauthenticated);

    const missing = await app.inject({ method: "GET", url: "/v1/no-such-route" });
    expect(missing.statusCode).toBe(404);
    expectStrictHeaders(missing);
  });
});
