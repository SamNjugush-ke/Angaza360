import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as refresh } from "@/app/api/auth/refresh/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as logoutAll } from "@/app/api/auth/logout-all/route";
import { GET as me } from "@/app/api/auth/me/route";

// ---------------------------------------------------------------------------------------------
// The backend, stubbed at fetch (the F0.2-C pattern): each test queues what each path answers.

const APP = "http://app.test";

interface BackendCall {
  path: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

let calls: BackendCall[];
let routes: Record<string, () => Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = await request.text();
    calls.push({
      path,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: text ? JSON.parse(text) : undefined,
    });
    const answer = routes[path];
    if (!answer) throw new TypeError(`fetch failed: no stub for ${path}`);
    return answer();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// A JWT-shaped token whose payload carries `exp`. The BFF never verifies it.
function jwt(expEpochSeconds: number, nonce: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", exp: expEpochSeconds, n: nonce })}.sig-${nonce}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const ACCESS = jwt(nowSeconds() + 900, "a1");
const REFRESH = "refresh-token-r1-0123456789abcdef";
const REFRESH_EXPIRES = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

const USER = { id: "user-1", fullName: "Wanjiku Owner", email: "owner@nakuru-hardware.co.ke", role: "MSME_OWNER" as const };
const LOGIN_TENANT = { id: "tenant-1", name: "Nakuru Hardware", subdomain: "nakuru-hardware" };
const ME = {
  user: { ...USER, isActive: true },
  role: "MSME_OWNER",
  tenant: { id: "tenant-1", subdomain: "nakuru-hardware", status: "ACTIVE", subscriptionTier: "MWANZO" },
};

function backendLoginOk(): void {
  routes["/v1/auth/login"] = () =>
    json(200, { status: "AUTHENTICATED", accessToken: ACCESS, refreshToken: REFRESH, expiresAt: REFRESH_EXPIRES, user: USER, tenant: LOGIN_TENANT });
}

// ---------------------------------------------------------------------------------------------
// Requests and Set-Cookie parsing.

function request(
  path: string,
  opts: { method?: string; body?: unknown; cookies?: Record<string, string>; origin?: string | null; csrf?: string } = {},
): NextRequest {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = opts.origin === undefined ? APP : opts.origin;
  if (origin !== null) headers.set("origin", origin);
  if (opts.csrf !== undefined) headers.set("x-csrf-token", opts.csrf);
  if (opts.cookies) {
    headers.set(
      "cookie",
      Object.entries(opts.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  return new NextRequest(`${APP}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

interface SetCookie {
  value: string;
  attrs: Record<string, string | true>;
}

function setCookies(response: Response): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...rest] = line.split(";").map((s) => s.trim());
    const eq = pair.indexOf("=");
    const attrs: Record<string, string | true> = {};
    for (const attr of rest) {
      const i = attr.indexOf("=");
      if (i === -1) attrs[attr.toLowerCase()] = true;
      else attrs[attr.slice(0, i).toLowerCase()] = attr.slice(i + 1);
    }
    out[pair.slice(0, eq)] = { value: decodeURIComponent(pair.slice(eq + 1)), attrs };
  }
  return out;
}

const isExpired = (c: SetCookie | undefined) => c !== undefined && c.value === "" && c.attrs["max-age"] === "0";

async function signIn(remember: boolean): Promise<{ response: Response; cookies: Record<string, SetCookie> }> {
  backendLoginOk();
  const response = await login(request("/api/auth/login", { body: { email: USER.email, password: "correct horse", remember } }));
  return { response, cookies: setCookies(response) };
}

// ---------------------------------------------------------------------------------------------

describe("POST /api/auth/login", () => {
  it("sets the session cookies and returns who signed in — never a token", async () => {
    const { response, cookies } = await signIn(false);
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { path: "/v1/auth/login", method: "POST", authorization: null, body: { email: USER.email, password: "correct horse" } },
    ]);

    const body = await response.json();
    expect(body).toEqual({ status: "AUTHENTICATED", user: USER, role: "MSME_OWNER", tenant: LOGIN_TENANT });
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("refreshToken");

    expect(cookies.ag_session.value).toBe(ACCESS);
    expect(cookies.ag_session.attrs).toMatchObject({ httponly: true, path: "/", samesite: "lax" });
    expect(cookies.ag_refresh.value).toBe(REFRESH);
    expect(cookies.ag_refresh.attrs).toMatchObject({ httponly: true, path: "/api/auth/refresh", samesite: "strict" });
    expect(cookies.ag_csrf.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookies.ag_csrf.attrs.httponly).toBeUndefined();
    expect(cookies.ag_csrf.attrs).toMatchObject({ path: "/", samesite: "lax" });
    // Not Secure outside production (the dev server is plain http).
    expect(cookies.ag_session.attrs.secure).toBeUndefined();
  });

  it("remember=true sets persistent cookies sized from the token expiries", async () => {
    const { cookies } = await signIn(true);
    const sessionAge = Number(cookies.ag_session.attrs["max-age"]);
    const refreshAge = Number(cookies.ag_refresh.attrs["max-age"]);
    expect(sessionAge).toBeGreaterThan(890);
    expect(sessionAge).toBeLessThanOrEqual(900); // the access JWT's exp
    expect(refreshAge).toBeGreaterThan(30 * 24 * 3600 - 10);
    expect(refreshAge).toBeLessThanOrEqual(30 * 24 * 3600); // expiresAt
    expect(Number(cookies.ag_csrf.attrs["max-age"])).toBe(refreshAge);
    expect(cookies.ag_persist.value).toBe("1");
    expect(cookies.ag_persist.attrs.httponly).toBeUndefined();
    expect(Number(cookies.ag_persist.attrs["max-age"])).toBe(refreshAge);
  });

  it("remember=false sets browser-session cookies", async () => {
    const { cookies } = await signIn(false);
    for (const name of ["ag_session", "ag_refresh", "ag_csrf"]) {
      expect(cookies[name].attrs["max-age"]).toBeUndefined();
      expect(cookies[name].attrs.expires).toBeUndefined();
    }
    expect(isExpired(cookies.ag_persist)).toBe(true);
  });

  it("answers bad credentials with the generic 401 and sets no session", async () => {
    routes["/v1/auth/login"] = () =>
      json(401, { statusCode: 401, error: "Unauthorized", message: "Invalid email or password." });
    const response = await login(request("/api/auth/login", { body: { email: USER.email, password: "wrong" } }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ statusCode: 401, error: "Unauthorized", message: "Invalid email or password." });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("passes the backend's 403 and 429 through without a session", async () => {
    routes["/v1/auth/login"] = () => json(403, { statusCode: 403, error: "Forbidden", message: "Your tenant is not active." });
    const forbidden = await login(request("/api/auth/login", { body: { email: USER.email, password: "x" } }));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).message).toBe("Your tenant is not active.");

    routes["/v1/auth/login"] = () => json(429, { statusCode: 429, error: "TooManyRequests", message: "Rate limit exceeded, retry in 1 minute" });
    const throttled = await login(request("/api/auth/login", { body: { email: USER.email, password: "x" } }));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a cross-site or Origin-less login before calling the backend", async () => {
    backendLoginOk();
    const crossSite = await login(request("/api/auth/login", { origin: "https://evil.example", body: { email: USER.email, password: "x" } }));
    const noOrigin = await login(request("/api/auth/login", { origin: null, body: { email: USER.email, password: "x" } }));
    expect(crossSite.status).toBe(403);
    expect(noOrigin.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(crossSite.headers.getSetCookie()).toEqual([]);
  });

  it("refuses a malformed body with 400", async () => {
    const missing = await login(request("/api/auth/login", { body: { email: USER.email } }));
    const badRemember = await login(request("/api/auth/login", { body: { email: USER.email, password: "x", remember: "yes" } }));
    expect(missing.status).toBe(400);
    expect(badRemember.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 502 when the backend is unreachable", async () => {
    const response = await login(request("/api/auth/login", { body: { email: USER.email, password: "x" } }));
    expect(response.status).toBe(502);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("POST /api/auth/refresh", () => {
  const CSRF = "csrf-token-value-0123456789";
  const ACCESS2 = jwt(nowSeconds() + 900, "a2");
  const REFRESH2 = "refresh-token-r2-fedcba9876543210";

  function backendRefreshOk(): void {
    routes["/v1/auth/refresh"] = () => json(200, { accessToken: ACCESS2, refreshToken: REFRESH2, expiresAt: REFRESH_EXPIRES });
  }

  it("spends the refresh cookie and rotates every cookie", async () => {
    backendRefreshOk();
    const response = await refresh(
      request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_refresh: REFRESH, ag_csrf: CSRF, ag_session: ACCESS } }),
    );
    expect(response.status).toBe(204);
    expect(calls).toEqual([{ path: "/v1/auth/refresh", method: "POST", authorization: null, body: { refreshToken: REFRESH } }]);

    const cookies = setCookies(response);
    expect(cookies.ag_session.value).toBe(ACCESS2);
    expect(cookies.ag_refresh.value).toBe(REFRESH2);
    expect(cookies.ag_refresh.attrs).toMatchObject({ httponly: true, path: "/api/auth/refresh", samesite: "strict" });
    expect(cookies.ag_csrf.value).not.toBe(CSRF); // rotated
    // No ag_persist on the request: a browser-session sign-in stays a browser-session one.
    expect(cookies.ag_session.attrs["max-age"]).toBeUndefined();
    expect(cookies.ag_refresh.attrs["max-age"]).toBeUndefined();
  });

  it("keeps a remembered session persistent", async () => {
    backendRefreshOk();
    const response = await refresh(
      request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_refresh: REFRESH, ag_csrf: CSRF, ag_persist: "1" } }),
    );
    const cookies = setCookies(response);
    expect(Number(cookies.ag_session.attrs["max-age"])).toBeGreaterThan(0);
    expect(Number(cookies.ag_refresh.attrs["max-age"])).toBeGreaterThan(0);
    expect(cookies.ag_persist.value).toBe("1");
  });

  it("refuses a missing or mismatched CSRF token, or a cross-site Origin, with 403", async () => {
    backendRefreshOk();
    const jar = { ag_refresh: REFRESH, ag_csrf: CSRF };
    const missing = await refresh(request("/api/auth/refresh", { cookies: jar }));
    const mismatched = await refresh(request("/api/auth/refresh", { csrf: "not-the-token", cookies: jar }));
    const noCookie = await refresh(request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_refresh: REFRESH } }));
    const crossSite = await refresh(request("/api/auth/refresh", { csrf: CSRF, cookies: jar, origin: "https://evil.example" }));
    for (const response of [missing, mismatched, noCookie, crossSite]) {
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it("signs the browser out when the backend refuses the token", async () => {
    routes["/v1/auth/refresh"] = () => json(401, { statusCode: 401, error: "Unauthorized", message: "Invalid refresh token." });
    const response = await refresh(request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_refresh: REFRESH, ag_csrf: CSRF } }));
    expect(response.status).toBe(401);
    const cookies = setCookies(response);
    for (const name of ["ag_session", "ag_refresh", "ag_csrf", "ag_persist"]) expect(isExpired(cookies[name])).toBe(true);
    expect(cookies.ag_refresh.attrs.path).toBe("/api/auth/refresh");
  });

  it("signs the browser out when there is no refresh cookie", async () => {
    const response = await refresh(request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_csrf: CSRF } }));
    expect(response.status).toBe(401);
    expect(isExpired(setCookies(response).ag_session)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("keeps the session when the backend is unavailable (the token was never spent)", async () => {
    routes["/v1/auth/refresh"] = () => json(503, { statusCode: 503, error: "ServiceUnavailable", message: "down" });
    const response = await refresh(request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_refresh: REFRESH, ag_csrf: CSRF } }));
    expect(response.status).toBe(502);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("POST /api/auth/logout and /logout-all", () => {
  const CSRF = "csrf-token-value-0123456789";
  const jar = { ag_session: ACCESS, ag_csrf: CSRF, ag_persist: "1" };

  it("revokes at the backend with the access token and clears every cookie", async () => {
    routes["/v1/auth/logout"] = () => new Response(null, { status: 204 });
    const response = await logout(request("/api/auth/logout", { csrf: CSRF, cookies: jar }));
    expect(response.status).toBe(204);
    expect(calls).toEqual([{ path: "/v1/auth/logout", method: "POST", authorization: `Bearer ${ACCESS}`, body: undefined }]);
    const cookies = setCookies(response);
    for (const name of ["ag_session", "ag_refresh", "ag_csrf", "ag_persist"]) expect(isExpired(cookies[name])).toBe(true);
    expect(cookies.ag_refresh.attrs.path).toBe("/api/auth/refresh");
  });

  it("logout-all revokes every session", async () => {
    routes["/v1/auth/logout-all"] = () => new Response(null, { status: 204 });
    const response = await logoutAll(request("/api/auth/logout-all", { csrf: CSRF, cookies: jar }));
    expect(response.status).toBe(204);
    expect(calls.map((c) => c.path)).toEqual(["/v1/auth/logout-all"]);
    expect(isExpired(setCookies(response).ag_session)).toBe(true);
  });

  it("still clears the cookies when the backend cannot be reached", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await logout(request("/api/auth/logout", { csrf: CSRF, cookies: jar }));
    expect(response.status).toBe(204);
    expect(isExpired(setCookies(response).ag_session)).toBe(true);
  });

  it("refuses without the CSRF token", async () => {
    const response = await logout(request("/api/auth/logout", { cookies: jar }));
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the session shape from the backend", async () => {
    routes["/v1/auth/me"] = () => json(200, ME);
    const response = await me(request("/api/auth/me", { method: "GET", cookies: { ag_session: ACCESS } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...ME, actingAs: null });
    expect(calls[0].authorization).toBe(`Bearer ${ACCESS}`);
  });

  it("is 401 when the backend refuses the token", async () => {
    routes["/v1/auth/me"] = () => json(401, { statusCode: 401, error: "Unauthorized", message: "Authentication required." });
    const response = await me(request("/api/auth/me", { method: "GET", cookies: { ag_session: ACCESS } }));
    expect(response.status).toBe(401);
  });

  it("is 401 without a session cookie, and never calls the backend", async () => {
    const response = await me(request("/api/auth/me", { method: "GET" }));
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("tokens never leave the HttpOnly cookies", () => {
  it("no token appears in any response body or any readable cookie, across every flow", async () => {
    const CSRF = "csrf-token-value-0123456789";
    const ACCESS2 = jwt(nowSeconds() + 900, "leak-a2");
    const REFRESH2 = "refresh-token-leak-r2-0011223344";
    const secrets = [ACCESS, REFRESH, ACCESS2, REFRESH2];

    backendLoginOk();
    routes["/v1/auth/refresh"] = () => json(200, { accessToken: ACCESS2, refreshToken: REFRESH2, expiresAt: REFRESH_EXPIRES });
    routes["/v1/auth/me"] = () => json(200, ME);
    routes["/v1/auth/logout"] = () => new Response(null, { status: 204 });

    const responses = [
      await login(request("/api/auth/login", { body: { email: USER.email, password: "correct horse", remember: true } })),
      await refresh(request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_refresh: REFRESH, ag_csrf: CSRF, ag_persist: "1" } })),
      await me(request("/api/auth/me", { method: "GET", cookies: { ag_session: ACCESS2 } })),
      await logout(request("/api/auth/logout", { csrf: CSRF, cookies: { ag_session: ACCESS2, ag_csrf: CSRF } })),
    ];

    for (const response of responses) {
      const body = await response.text();
      for (const secret of secrets) expect(body).not.toContain(secret);
      for (const [name, cookie] of Object.entries(setCookies(response))) {
        if (cookie.attrs.httponly !== true) {
          for (const secret of secrets) expect(cookie.value, `readable cookie ${name}`).not.toContain(secret);
        }
      }
    }
    // And the tokens that ARE set, are set only on the two HttpOnly cookies.
    const issued = setCookies(responses[0]);
    expect(Object.entries(issued).filter(([, c]) => secrets.includes(c.value)).map(([n, c]) => [n, c.attrs.httponly])).toEqual([
      ["ag_session", true],
      ["ag_refresh", true],
    ]);
  });
});

describe("production cookies", () => {
  it("are Secure when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { POST: prodLogin } = await import("@/app/api/auth/login/route");
    backendLoginOk();
    const response = await prodLogin(request("/api/auth/login", { body: { email: USER.email, password: "x", remember: true } }));
    const cookies = setCookies(response);
    for (const name of ["ag_session", "ag_refresh", "ag_csrf", "ag_persist"]) expect(cookies[name].attrs.secure).toBe(true);
  });
});

describe("APP_ORIGIN", () => {
  it("is the origin the CSRF check compares against when set", async () => {
    vi.stubEnv("APP_ORIGIN", "https://app.angaza360.co.ke");
    backendLoginOk();
    // The request reaches the app on an internal host behind a proxy; the browser's Origin is public.
    const publicOrigin = await login(
      request("/api/auth/login", { origin: "https://app.angaza360.co.ke", body: { email: USER.email, password: "x" } }),
    );
    expect(publicOrigin.status).toBe(200);
    // The request's own host no longer counts once APP_ORIGIN names the public origin.
    const internalOrigin = await login(request("/api/auth/login", { body: { email: USER.email, password: "x" } }));
    expect(internalOrigin.status).toBe(403);
  });
});

describe("the retired business-name cookie (ag_tenant_name, T-B-ME-NAME)", () => {
  const CSRF = "csrf-token-value-0123456789";

  it("is never set any more: login and refresh only expire a leftover one", async () => {
    const { cookies } = await signIn(true);
    expect(isExpired(cookies.ag_tenant_name)).toBe(true);
    routes["/v1/auth/refresh"] = () => json(200, { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: REFRESH_EXPIRES });
    const refreshed = setCookies(
      await refresh(
        request("/api/auth/refresh", { csrf: CSRF, cookies: { ag_refresh: REFRESH, ag_csrf: CSRF, ag_tenant_name: "Mama%20Mboga's" } }),
      ),
    );
    expect(isExpired(refreshed.ag_tenant_name)).toBe(true);
  });

  it("is cleared on logout", async () => {

    routes["/v1/auth/logout"] = () => new Response(null, { status: 204 });
    const out = setCookies(await logout(request("/api/auth/logout", { csrf: CSRF, cookies: { ag_session: ACCESS, ag_csrf: CSRF } })));
    expect(isExpired(out.ag_tenant_name)).toBe(true);
  });
});

describe("sign-out hygiene", () => {
  it("expires the working-location cookie too", async () => {
    const CSRF = "csrf-token-value-0123456789";
    routes["/v1/auth/logout"] = () => new Response(null, { status: 204 });
    const out = setCookies(await logout(request("/api/auth/logout", { csrf: CSRF, cookies: { ag_session: ACCESS, ag_csrf: CSRF, ag_location: "loc-1" } })));
    expect(isExpired(out.ag_location)).toBe(true);
  });
});
