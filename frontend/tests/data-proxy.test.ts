import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, GET, PATCH, POST, PUT } from "@/app/api/v1/[...path]/route";

const APP = "http://app.test";
const CSRF = "csrf-token-value-0123456789";
const ACCESS = "access-token-value-abc";

interface Forwarded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

let forwarded: Forwarded[];
let answer: () => Response;

beforeEach(() => {
  forwarded = [];
  answer = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    forwarded.push({ url: request.url, method: request.method, headers: request.headers, body: await request.text() });
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function call(
  handler: typeof GET,
  method: string,
  path: string[],
  opts: { query?: string; body?: string; csrf?: string; origin?: string | null; cookies?: Record<string, string>; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(opts.headers);
  const origin = opts.origin === undefined ? APP : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.csrf) headers.set("x-csrf-token", opts.csrf);
  const cookies = opts.cookies ?? { ag_session: ACCESS, ag_csrf: CSRF };
  headers.set("cookie", Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const request = new NextRequest(`${APP}/api/v1/${path.join("/")}${opts.query ?? ""}`, { method, headers, body: opts.body });
  return handler(request, { params: Promise.resolve({ path }) });
}

describe("the /api/v1 data proxy", () => {
  it("forwards a GET with the bearer from the cookie, the query and the client IP", async () => {
    const response = await call(GET, "GET", ["dashboard"], {
      query: "?year=2026&month=10",
      headers: { "x-forwarded-for": "41.90.1.2, 10.0.0.1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toBe("http://localhost:4000/v1/dashboard?year=2026&month=10");
    expect(forwarded[0].headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(forwarded[0].headers.get("x-forwarded-for")).toBe("41.90.1.2");
    // The browser's cookies are never sent on to the backend.
    expect(forwarded[0].headers.get("cookie")).toBeNull();
  });

  it("forwards the act-as tenant id while a SUPER_ADMIN is acting as a business — never on an auth path", async () => {
    const acting = { ag_session: ACCESS, ag_csrf: CSRF, ag_act_as: JSON.stringify({ id: "t-9", name: "Nakuru" }) };
    await call(GET, "GET", ["products"], { cookies: acting });
    expect(forwarded[0].headers.get("x-act-as-tenant")).toBe("t-9");
    // Not on an auth path (the admin's own MFA settings stay the admin's).
    await call(POST, "POST", ["auth", "mfa", "step-up"], { cookies: acting, csrf: CSRF, body: "{}" });
    expect(forwarded[1].headers.get("x-act-as-tenant")).toBeNull();
    // Without the cookie, nothing is forwarded.
    await call(GET, "GET", ["products"]);
    expect(forwarded[2].headers.get("x-act-as-tenant")).toBeNull();
  });

  it("passes an idempotency key through — and never the job trigger's machine secret", async () => {
    await call(POST, "POST", ["jobs", "expire-tokens", "run"], {
      csrf: CSRF,
      body: "{}",
      headers: { "idempotency-key": "console-0123456789", "x-job-trigger-secret": "a".repeat(40) },
    });
    expect(forwarded[0].headers.get("idempotency-key")).toBe("console-0123456789");
    expect(forwarded[0].headers.get("x-job-trigger-secret")).toBeNull();
    // A malformed key is dropped, not passed on.
    await call(POST, "POST", ["jobs", "expire-tokens", "run"], { csrf: CSRF, body: "{}", headers: { "idempotency-key": "bad key with space" } });
    expect(forwarded[1].headers.get("idempotency-key")).toBeNull();
  });

  it("falls back to X-Real-IP, and to API_BASE_URL", async () => {
    vi.stubEnv("API_BASE_URL", "https://api.internal");
    await call(GET, "GET", ["reports", "trial-balance"], { headers: { "x-real-ip": "41.90.3.4" } });
    expect(forwarded[0].url).toBe("https://api.internal/v1/reports/trial-balance");
    expect(forwarded[0].headers.get("x-forwarded-for")).toBe("41.90.3.4");
  });

  it("forwards mutations with their body when the CSRF check passes", async () => {
    for (const [handler, method] of [[POST, "POST"], [PUT, "PUT"], [PATCH, "PATCH"], [DELETE, "DELETE"]] as const) {
      forwarded = [];
      const response = await call(handler, method, ["expenses"], { csrf: CSRF, body: '{"amount":"6300"}' });
      expect(response.status).toBe(200);
      expect(forwarded[0].method).toBe(method);
      expect(forwarded[0].body).toBe('{"amount":"6300"}');
      expect(forwarded[0].headers.get("content-type")).toBe("application/json");
    }
  });

  it("refuses a mutation without the CSRF token, with a bad one, or cross-site — before the backend", async () => {
    for (const opts of [{}, { csrf: "wrong" }, { csrf: CSRF, origin: "https://evil.example" }, { csrf: CSRF, origin: null }]) {
      const response = await call(POST, "POST", ["expenses"], { ...opts, body: "{}" });
      expect(response.status).toBe(403);
    }
    expect(forwarded).toHaveLength(0);
  });

  it("never proxies /v1/auth/*", async () => {
    for (const path of [["auth", "me"], ["auth", "login"], ["Auth", "refresh"], ["auth"]]) {
      const response = await call(GET, "GET", path);
      expect(response.status).toBe(404);
      const posted = await call(POST, "POST", path, { csrf: CSRF, body: "{}" });
      expect(posted.status).toBe(404);
    }
    expect(forwarded).toHaveLength(0);
  });

  it("refuses dot segments that could climb out of /v1", async () => {
    for (const path of [["..", "health"], ["reports", "."], ["reports", ""]]) {
      expect((await call(GET, "GET", path)).status).toBe(400);
    }
    expect(forwarded).toHaveLength(0);
  });

  it("passes a 401 straight through — it does not refresh", async () => {
    answer = () =>
      new Response(JSON.stringify({ statusCode: 401, error: "Unauthorized", message: "Authentication required." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const response = await call(GET, "GET", ["dashboard"]);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ statusCode: 401, error: "Unauthorized", message: "Authentication required." });
    expect(forwarded).toHaveLength(1);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("passes status and body through, but never a backend Set-Cookie", async () => {
    answer = () =>
      new Response(JSON.stringify({ statusCode: 429, error: "TooManyRequests", message: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60", "set-cookie": "evil=1" },
      });
    const response = await call(GET, "GET", ["reports", "trial-balance"]);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("answers a 204 with no body", async () => {
    answer = () => new Response(null, { status: 204 });
    const response = await call(DELETE, "DELETE", ["expenses", "e1"], { csrf: CSRF });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("forwards without a bearer when there is no session, leaving the 401 to the backend", async () => {
    await call(GET, "GET", ["dashboard"], { cookies: {} });
    expect(forwarded[0].headers.get("authorization")).toBeNull();
  });

  it("answers 502 when the backend is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await call(GET, "GET", ["dashboard"])).status).toBe(502);
  });
});
