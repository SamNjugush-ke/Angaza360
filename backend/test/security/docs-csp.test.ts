// ===========================================================================
// /docs UNDER THE T-A2 HEADERS (src/plugins/docs.ts).
//
// The app-wide CSP is default-src 'none', which would render swagger-ui as a blank
// page. The swagger-ui subtree carries its own relaxed policy — and ONLY that
// subtree: the raw OpenAPI JSON is still served, and a non-docs route keeps the
// strict policy.
//
// The /docs ACCESS CONTROL is unchanged by T-A2 and is proven here in all three
// modes: outside production with API_DOCS_ENABLED unset (open — the default),
// production with docs disabled (404) and production with docs enabled
// (authenticated only).
//
// HOW EACH MODE IS BUILT. env.ts reads NODE_ENV / API_DOCS_ENABLED ONCE, at import,
// and the suite's own environment pins API_DOCS_ENABLED=false (.env.test and the CI
// workflow). So every mode builds the app from a FRESH module graph
// (vi.resetModules) under the variables it needs, and restores them afterwards.
// Closing such an app ends ITS module graph's pool, never this file's.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accessTokenFor, createFixtureUser, deleteUsers, STRICT_HEADERS, type TestUser } from "./http-app";

const RELAXED_DIRECTIVES = [
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
] as const;

const saved = {
  NODE_ENV: process.env["NODE_ENV"],
  API_DOCS_ENABLED: process.env["API_DOCS_ENABLED"],
};

let owner: TestUser;
let built: FastifyInstance | null = null;

/** Builds the real app from a fresh module graph; `docsEnabled` undefined = the variable is UNSET. */
async function buildAppUnder(
  nodeEnv: "test" | "production",
  docsEnabled: "true" | "false" | undefined,
): Promise<FastifyInstance> {
  process.env["NODE_ENV"] = nodeEnv;
  if (docsEnabled === undefined) {
    delete process.env["API_DOCS_ENABLED"];
  } else {
    process.env["API_DOCS_ENABLED"] = docsEnabled;
  }
  vi.resetModules();
  const fresh = await import("../../src/server");
  const app = await fresh.buildServer();
  await app.ready();
  built = app;
  return app;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function expectRelaxedCsp(header: string | number | string[] | undefined): void {
  expect(typeof header).toBe("string");
  const csp = String(header);
  for (const directive of RELAXED_DIRECTIVES) {
    expect(csp).toContain(directive);
  }
  expect(csp).not.toContain("default-src 'none'");
}

beforeAll(async () => {
  owner = await createFixtureUser("MSME_OWNER");
});

afterEach(async () => {
  if (built !== null) {
    await built.close();
    built = null;
  }
  restoreEnv();
  vi.resetModules();
});

afterAll(async () => {
  await deleteUsers([owner]);
});

describe("outside production, API_DOCS_ENABLED unset: docs are served (the dev-open default)", () => {
  it("GET /docs is 200 HTML with the RELAXED swagger-ui CSP; the rest of the strict set still applies", async () => {
    const app = await buildAppUnder("test", undefined);
    const response = await app.inject({ method: "GET", url: "/docs" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/html/);
    expect(response.body).toContain("swagger-ui");
    expectRelaxedCsp(response.headers["content-security-policy"]);
    expect(response.headers["x-frame-options"]).toBe(STRICT_HEADERS["x-frame-options"]);
    expect(response.headers["strict-transport-security"]).toBe(STRICT_HEADERS["strict-transport-security"]);
    expect(response.headers["x-content-type-options"]).toBe(STRICT_HEADERS["x-content-type-options"]);

    // swagger-ui's own script asset is under the relaxed policy too.
    const asset = await app.inject({ method: "GET", url: "/docs/static/swagger-initializer.js" });
    expect(asset.statusCode).toBe(200);
    expectRelaxedCsp(asset.headers["content-security-policy"]);
  });

  it("the raw OpenAPI document is still served", async () => {
    const app = await buildAppUnder("test", undefined);
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    expect(response.statusCode).toBe(200);
    const document = response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toContain("/v1/auth/login");
  });

  it("the relaxation is scoped to /docs: a non-docs route keeps default-src 'none'", async () => {
    const app = await buildAppUnder("test", undefined);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["content-security-policy"]).toBe(STRICT_HEADERS["content-security-policy"]);
  });
});

describe("docs access control in production (unchanged by T-A2)", () => {
  it("disabled (the production default): the docs routes do not exist — 404", async () => {
    const prod = await buildAppUnder("production", "false");
    expect((await prod.inject({ method: "GET", url: "/docs" })).statusCode).toBe(404);
    expect((await prod.inject({ method: "GET", url: "/docs/json" })).statusCode).toBe(404);
  });

  it("enabled: anonymous is 401; an authenticated session gets the docs under the relaxed CSP", async () => {
    const prod = await buildAppUnder("production", "true");
    expect((await prod.inject({ method: "GET", url: "/docs/json" })).statusCode).toBe(401);
    expect((await prod.inject({ method: "GET", url: "/docs" })).statusCode).toBe(401);

    const token = await accessTokenFor(prod, owner);
    const page = await prod.inject({
      method: "GET",
      url: "/docs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(page.statusCode).toBe(200);
    expectRelaxedCsp(page.headers["content-security-policy"]);
    const document = await prod.inject({
      method: "GET",
      url: "/docs/json",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(document.statusCode).toBe(200);
  });
});
