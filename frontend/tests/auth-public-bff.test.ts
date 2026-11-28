import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as forgot } from "@/app/api/auth/password/forgot/route";
import { POST as reset } from "@/app/api/auth/password/reset/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as refresh } from "@/app/api/auth/refresh/route";
import { GET as previewInvitation } from "@/app/api/users/invitations/[token]/route";
import { POST as acceptInvitation } from "@/app/api/users/invitations/[token]/accept/route";

// The public auth flows' BFF routes: password recovery and the invitation. Each one checks the Origin, relays ONE backend call with the user's address in
// X-Forwarded-For, passes the backend's actionable refusals through in the one error shape, and
// sets NO cookie. The backend is stubbed at fetch.

const APP = "http://app.test";
const CLIENT_IP = "203.0.113.7";

interface BackendCall {
  path: string;
  method: string;
  forwardedFor: string | null;
  body: unknown;
}

let calls: BackendCall[];
let routes: Record<string, () => Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, error: string, message: string) => json(status, { statusCode: status, error, message });

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = await request.text();
    calls.push({ path, method: request.method, forwardedFor: request.headers.get("x-forwarded-for"), body: text ? JSON.parse(text) : undefined });
    const answer = routes[`${request.method} ${path}`];
    if (!answer) throw new TypeError(`fetch failed: no stub for ${request.method} ${path}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(
  path: string,
  opts: { method?: string; body?: unknown; origin?: string | null; secFetchSite?: string; cookies?: string; csrf?: string } = {},
): NextRequest {
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": `${CLIENT_IP}, 10.0.0.1` });
  const origin = opts.origin === undefined ? APP : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.secFetchSite) headers.set("sec-fetch-site", opts.secFetchSite);
  if (opts.cookies) headers.set("cookie", opts.cookies);
  if (opts.csrf) headers.set("x-csrf-token", opts.csrf);
  return new NextRequest(`${APP}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

/** Every response of these routes: no Set-Cookie at all. */
function expectNoCookies(response: Response) {
  expect(response.headers.getSetCookie()).toEqual([]);
}

const FORGOT_ACK = { message: "If an account exists for that email, a reset code has been sent." };

describe("POST /api/auth/password/forgot", () => {
  it("relays the email with the client's address and returns the backend's one acknowledgement", async () => {
    routes["POST /v1/auth/password/forgot"] = () => json(202, FORGOT_ACK);
    const response = await forgot(request("/api/auth/password/forgot", { body: { email: "amina@shop.co.ke" } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(FORGOT_ACK);
    expect(calls).toEqual([{ path: "/v1/auth/password/forgot", method: "POST", forwardedFor: CLIENT_IP, body: { email: "amina@shop.co.ke" } }]);
    expectNoCookies(response);
  });

  it("answers an unknown email exactly as a known one (it adds nothing of its own)", async () => {
    routes["POST /v1/auth/password/forgot"] = () => json(202, FORGOT_ACK);
    const known = await forgot(request("/api/auth/password/forgot", { body: { email: "owner@nakuru-hardware.co.ke" } }));
    const unknown = await forgot(request("/api/auth/password/forgot", { body: { email: "nobody@nowhere.test" } }));
    expect([known.status, await known.text()]).toEqual([unknown.status, await unknown.text()]);
  });

  it("refuses a cross-site or Origin-less request before calling the backend", async () => {
    for (const origin of ["https://evil.test", null]) {
      const response = await forgot(request("/api/auth/password/forgot", { body: { email: "a@b.co" }, origin }));
      expect(response.status).toBe(403);
      expectNoCookies(response);
    }
    expect(calls).toEqual([]);
  });

  it("passes a throttle through, and answers 502 when the backend is unreachable or odd", async () => {
    routes["POST /v1/auth/password/forgot"] = () => refusal(429, "TooManyRequests", "Rate limit exceeded, retry in 1 minute");
    const throttled = await forgot(request("/api/auth/password/forgot", { body: { email: "a@b.co" } }));
    expect([throttled.status, await throttled.json()]).toEqual([429, { statusCode: 429, error: "TooManyRequests", message: "Rate limit exceeded, retry in 1 minute" }]);

    routes["POST /v1/auth/password/forgot"] = () => json(500, { boom: true });
    expect((await forgot(request("/api/auth/password/forgot", { body: { email: "a@b.co" } }))).status).toBe(502);
    delete routes["POST /v1/auth/password/forgot"];
    expect((await forgot(request("/api/auth/password/forgot", { body: { email: "a@b.co" } }))).status).toBe(502);
  });

  it("refuses a malformed body with 400 and calls nothing", async () => {
    for (const body of ["not json", { email: 42 }, {}, [1]]) {
      expect((await forgot(request("/api/auth/password/forgot", { body }))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });
});

describe("POST /api/auth/password/reset", () => {
  it("spends the code for a new password and signs nobody in", async () => {
    routes["POST /v1/auth/password/reset"] = () => new Response(null, { status: 204 });
    const response = await reset(request("/api/auth/password/reset", { body: { token: "code-1", newPassword: "a long new password" } }));
    expect(response.status).toBe(204);
    expectNoCookies(response);
    expect(calls[0]).toEqual({ path: "/v1/auth/password/reset", method: "POST", forwardedFor: CLIENT_IP, body: { token: "code-1", newPassword: "a long new password" } });
  });

  it("passes the backend's one 400 for an unknown, used or expired code", async () => {
    routes["POST /v1/auth/password/reset"] = () => refusal(400, "BadRequest", "This reset code is invalid or has expired.");
    const response = await reset(request("/api/auth/password/reset", { body: { token: "used", newPassword: "a long new password" } }));
    expect([response.status, (await response.json()).message]).toEqual([400, "This reset code is invalid or has expired."]);
    expectNoCookies(response);
  });

  it("is Origin-checked", async () => {
    expect((await reset(request("/api/auth/password/reset", { body: { token: "t", newPassword: "p" }, origin: "https://evil.test" }))).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

const PREVIEW = { email: "kevin@test.co.ke", role: "CASHIER", businessName: "Nakuru Hardware", expiresAt: "2026-11-03T08:00:00.000Z" };

describe("GET /api/users/invitations/[token]", () => {
  it("returns what the invitation offers, uncached, for the app's own same-origin fetch", async () => {
    routes["GET /v1/users/invitations/tok-123"] = () => json(200, PREVIEW);
    const response = await previewInvitation(request("/api/users/invitations/tok-123", { method: "GET", origin: null, secFetchSite: "same-origin" }), params("tok-123"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PREVIEW);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls[0]).toMatchObject({ path: "/v1/users/invitations/tok-123", method: "GET", forwardedFor: CLIENT_IP });
    expectNoCookies(response);
  });

  it("accepts a matching Origin too, and refuses a cross-site or unmarked request", async () => {
    routes["GET /v1/users/invitations/tok-123"] = () => json(200, PREVIEW);
    expect((await previewInvitation(request("/api/users/invitations/tok-123", { method: "GET" }), params("tok-123"))).status).toBe(200);
    calls = [];
    for (const opts of [{ origin: "https://evil.test" }, { origin: null }, { origin: null, secFetchSite: "cross-site" }] as const) {
      expect((await previewInvitation(request("/api/users/invitations/tok-123", { method: "GET", ...opts }), params("tok-123"))).status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("passes the backend's one 400 for an invalid or expired invitation", async () => {
    routes["GET /v1/users/invitations/gone"] = () => refusal(400, "BadRequest", "This invitation is invalid or has expired. Ask for a new one.");
    const response = await previewInvitation(request("/api/users/invitations/gone", { method: "GET" }), params("gone"));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/users/invitations/[token]/accept", () => {
  it("creates the account, signs nobody in and returns only the email", async () => {
    routes["POST /v1/users/invitations/tok-123/accept"] = () =>
      json(201, { id: "u-9", email: PREVIEW.email, fullName: "Kevin Otieno", role: "CASHIER", tenantId: "t-1", isActive: true });
    const response = await acceptInvitation(
      request("/api/users/invitations/tok-123/accept", { body: { fullName: "Kevin Otieno", password: "a long password" } }),
      params("tok-123"),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ email: PREVIEW.email });
    expect(calls[0]).toEqual({
      path: "/v1/users/invitations/tok-123/accept",
      method: "POST",
      forwardedFor: CLIENT_IP,
      body: { fullName: "Kevin Otieno", password: "a long password" },
    });
    expectNoCookies(response);
  });

  it("passes 400 and 409 through, and is Origin-checked", async () => {
    routes["POST /v1/users/invitations/tok-123/accept"] = () => refusal(409, "Conflict", "A user with that email already exists.");
    const conflict = await acceptInvitation(request("/api/users/invitations/tok-123/accept", { body: { fullName: "K", password: "a long password" } }), params("tok-123"));
    expect([conflict.status, (await conflict.json()).message]).toEqual([409, "A user with that email already exists."]);
    calls = [];
    const cross = await acceptInvitation(
      request("/api/users/invitations/tok-123/accept", { body: { fullName: "K", password: "a long password" }, origin: "https://evil.test" }),
      params("tok-123"),
    );
    expect(cross.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("the sign-in calls carry the client's address too (T-B-PROXY)", () => {
  it("login and refresh forward X-Forwarded-For to the backend", async () => {
    routes["POST /v1/auth/login"] = () => refusal(401, "Unauthorized", "Invalid email or password.");
    await login(request("/api/auth/login", { body: { email: "a@b.co", password: "x" } }));
    routes["POST /v1/auth/refresh"] = () => refusal(401, "Unauthorized", "Refresh token is invalid.");
    await refresh(request("/api/auth/refresh", { cookies: "ag_refresh=r1; ag_csrf=c1", csrf: "c1" }));
    expect(calls.map((call) => [call.path, call.forwardedFor])).toEqual([
      ["/v1/auth/login", CLIENT_IP],
      ["/v1/auth/refresh", CLIENT_IP],
    ]);
  });
});
