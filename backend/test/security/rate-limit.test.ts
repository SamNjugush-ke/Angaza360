// ===========================================================================
// THE RATE-LIMIT FRAMEWORK (Task T-A2, src/plugins/security.ts).
//
// One limiter, registered once with `global: false`; routes opt in by tier. Proven:
//   * AUTH      — login throttles at exactly its max per IP+email (and the key really
//                 includes the email); refresh throttles at its max per IP.
//   * SENSITIVE — a report route and the credential write throttle at exactly their
//                 max; the credential write counts BEFORE authentication.
//   * WEBHOOK   — the public callback throttles at 60 per IP.
//   * A throttled response is the ONE error shape, errorBody(429, "TooManyRequests",
//     …), with Retry-After.
//   * CONTROL   — routes that did not opt in are never throttled.
// Each case uses its own client IP, so no case spends another's budget.
// ===========================================================================

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/config/env";
import { RATE_LIMITS } from "../../src/plugins/security";
import { errorBody } from "../../src/schemas/common";
import { buildServer } from "../../src/server";
import { FIXTURE_SUBDOMAIN } from "../setup/tenant";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "./http-app";

let app: FastifyInstance;
let owner: TestUser;
let token = "";

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

/** Fires `count` identical requests in order and returns every status code. */
async function statuses(count: number, send: () => Promise<LightMyRequestResponse>): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    codes.push((await send()).statusCode);
  }
  return codes;
}

function repeat(status: number, count: number): number[] {
  return Array.from({ length: count }, () => status);
}

/** The throttled response is the project's one error shape, with Retry-After. */
function expectThrottled(response: LightMyRequestResponse, max: number): void {
  expect(response.statusCode).toBe(429);
  const body = response.json<Record<string, unknown>>();
  const message = typeof body["message"] === "string" ? body["message"] : "";
  expect(message).toMatch(/^Rate limit exceeded, retry in .+\.$/);
  // Exactly errorBody(429, "TooManyRequests", message) — no extra key, nothing missing.
  expect(body).toStrictEqual(errorBody(429, "TooManyRequests", message));
  const retryAfter = Number(response.headers["retry-after"]);
  expect(Number.isInteger(retryAfter) && retryAfter > 0).toBe(true);
  expect(response.headers["x-ratelimit-limit"]).toBe(max.toString());
}

describe("AUTH tier", () => {
  it(`login allows exactly ${RATE_LIMITS.AUTH.max.toString()} attempts per IP+email, then 429 in the one error shape`, async () => {
    expect(RATE_LIMITS.AUTH).toEqual({ max: env.loginRateLimitMax, timeWindow: env.loginRateLimitWindowMs });
    const ip = freshIp();
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: ip,
        payload: { email: "nobody-t-a2@test.invalid", password: "wrong-password" },
      });
    expect(await statuses(RATE_LIMITS.AUTH.max, attempt)).toEqual(repeat(401, RATE_LIMITS.AUTH.max));
    expectThrottled(await attempt(), RATE_LIMITS.AUTH.max);

    // The key is IP+email (unchanged from before T-A2): another email from the same IP
    // still has its own budget.
    const other = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: ip,
      payload: { email: "somebody-else-t-a2@test.invalid", password: "wrong-password" },
    });
    expect(other.statusCode).toBe(401);
  });

  it(`refresh allows exactly ${RATE_LIMITS.AUTH.max.toString()} attempts per IP, then 429`, async () => {
    const ip = freshIp();
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/refresh",
        remoteAddress: ip,
        payload: { refreshToken: "not-a-real-refresh-token" },
      });
    expect(await statuses(RATE_LIMITS.AUTH.max, attempt)).toEqual(repeat(401, RATE_LIMITS.AUTH.max));
    expectThrottled(await attempt(), RATE_LIMITS.AUTH.max);
  });
});

describe("SENSITIVE tier", () => {
  it(`a report route serves exactly ${RATE_LIMITS.SENSITIVE.max.toString()} requests per IP, then 429`, async () => {
    expect(RATE_LIMITS.SENSITIVE).toEqual({
      max: env.sensitiveRateLimitMax,
      timeWindow: env.sensitiveRateLimitWindowMs,
    });
    const ip = freshIp();
    const attempt = () =>
      app.inject({
        method: "GET",
        url: "/v1/reports/trial-balance?comparative=false",
        remoteAddress: ip,
        headers: { authorization: `Bearer ${token}` },
      });
    expect(await statuses(RATE_LIMITS.SENSITIVE.max, attempt)).toEqual(repeat(200, RATE_LIMITS.SENSITIVE.max));
    expectThrottled(await attempt(), RATE_LIMITS.SENSITIVE.max);
  });

  it("the credential write throttles at its max, counting requests BEFORE authentication", async () => {
    const ip = freshIp();
    const attempt = () =>
      app.inject({
        method: "PUT",
        url: "/v1/integrations/MPESA/credentials",
        remoteAddress: ip,
        payload: { environment: "SANDBOX", fields: {} },
      });
    expect(await statuses(RATE_LIMITS.SENSITIVE.max, attempt)).toEqual(repeat(401, RATE_LIMITS.SENSITIVE.max));
    expectThrottled(await attempt(), RATE_LIMITS.SENSITIVE.max);
  });
});

describe("WEBHOOK tier", () => {
  it(`the public M-Pesa callback allows ${RATE_LIMITS.WEBHOOK.max.toString()} calls per IP, then 429`, async () => {
    expect(RATE_LIMITS.WEBHOOK).toEqual({ max: 60, timeWindow: 60_000 });
    const ip = freshIp();
    const attempt = () =>
      app.inject({
        method: "POST",
        url: `/v1/webhooks/mpesa/not-the-secret/${FIXTURE_SUBDOMAIN}`,
        remoteAddress: ip,
        payload: {},
      });
    expect(await statuses(RATE_LIMITS.WEBHOOK.max, attempt)).toEqual(repeat(404, RATE_LIMITS.WEBHOOK.max));
    expectThrottled(await attempt(), RATE_LIMITS.WEBHOOK.max);
  });
});

describe("control: routes that did not opt in are never throttled", () => {
  const beyondEveryTier = Math.max(RATE_LIMITS.AUTH.max, RATE_LIMITS.SENSITIVE.max, RATE_LIMITS.WEBHOOK.max) + 10;

  it(`GET /health answers ${beyondEveryTier.toString()} requests from one IP without a limit`, async () => {
    const ip = freshIp();
    const responses: LightMyRequestResponse[] = [];
    for (let i = 0; i < beyondEveryTier; i += 1) {
      responses.push(await app.inject({ method: "GET", url: "/health", remoteAddress: ip }));
    }
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(responses.every((response) => response.headers["x-ratelimit-limit"] === undefined)).toBe(true);
  });

  it(`an authenticated route that did not opt in (GET /v1/auth/me) answers ${beyondEveryTier.toString()} requests`, async () => {
    const ip = freshIp();
    const responses: LightMyRequestResponse[] = [];
    for (let i = 0; i < beyondEveryTier; i += 1) {
      responses.push(
        await app.inject({
          method: "GET",
          url: "/v1/auth/me",
          remoteAddress: ip,
          headers: { authorization: `Bearer ${token}` },
        }),
      );
    }
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(responses.every((response) => response.headers["x-ratelimit-limit"] === undefined)).toBe(true);
  });
});
