import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as resume } from "@/app/api/auth/refresh/continue/route";
import { isAccessTokenUsable, jwtExpiry } from "@/lib/auth/jwt";
import { proxy } from "@/proxy";

// SESSION CONTINUITY ON A FULL PAGE LOAD: an expired access token with a refreshable session is
// sent through /api/auth/refresh/continue (the refresh cookie's own path), refreshed there and
// returned to the page — no sign-in. A valid token passes untouched and calls nothing.

const APP = "http://app.test";
const now = () => Math.floor(Date.now() / 1000);

function jwt(exp: number, extra: Record<string, unknown> = {}): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", exp, ...extra })}.sig`;
}

const VALID = jwt(now() + 900);
const EXPIRED = jwt(now() - 60);
const NEW_ACCESS = jwt(now() + 900, { n: "rotated" });
const REFRESH = "refresh-token-r1-0123456789abcdef";
const NEW_REFRESH = "refresh-token-r2-fedcba9876543210";
const REFRESH_EXPIRES = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

let backendCalls: Array<{ path: string; body: unknown }>;
let refreshAnswer: () => Response | Promise<Response>;

beforeEach(() => {
  backendCalls = [];
  refreshAnswer = () =>
    new Response(JSON.stringify({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH, expiresAt: REFRESH_EXPIRES }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.text();
    backendCalls.push({ path: new URL(request.url).pathname, body: text ? JSON.parse(text) : undefined });
    return refreshAnswer();
  });
});
afterEach(() => vi.unstubAllGlobals());

function req(path: string, cookies: Record<string, string>): NextRequest {
  const headers = new Headers();
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (jar) headers.set("cookie", jar);
  return new NextRequest(`${APP}${path}`, { headers });
}

function setCookies(response: Response): Record<string, { value: string; attrs: Record<string, string | true> }> {
  const out: Record<string, { value: string; attrs: Record<string, string | true> }> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair = "", ...rest] = line.split(";").map((s) => s.trim());
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

const location = (response: Response) => response.headers.get("location");

describe("the access token's expiry, read locally", () => {
  it("decodes exp from a base64url payload (non-ASCII claims included) without verifying it", () => {
    const token = jwt(1_900_000_000, { name: "Wanjikũ Kamau — Nakuru" });
    expect(jwtExpiry(token)).toBe(1_900_000_000);
    expect(jwtExpiry("not-a-jwt")).toBeNull();
    expect(jwtExpiry("a.%%%.c")).toBeNull();
  });

  it("is usable until 30s before exp; absent is not; unreadable defers to the backend", () => {
    expect(isAccessTokenUsable(undefined)).toBe(false);
    expect(isAccessTokenUsable(VALID)).toBe(true);
    expect(isAccessTokenUsable(EXPIRED)).toBe(false);
    expect(isAccessTokenUsable(jwt(now() + 10))).toBe(false); // inside the skew
    expect(isAccessTokenUsable("opaque")).toBe(true);
  });
});

describe("proxy.ts on a protected page", () => {
  it("passes a VALID access token through and calls nothing", () => {
    const response = proxy(req("/dashboard", { ag_session: VALID, ag_csrf: "c" }));
    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
    expect(backendCalls).toEqual([]);
  });

  it("sends an EXPIRED access token with a refreshable session through the refresh path, keeping the page", () => {
    const response = proxy(req("/dashboard?month=10", { ag_session: EXPIRED, ag_csrf: "c" }));
    expect(response.status).toBe(307);
    expect(location(response)).toBe(`${APP}/api/auth/refresh/continue?returnTo=${encodeURIComponent("/dashboard?month=10")}`);
    expect(backendCalls).toEqual([]); // the proxy itself never calls the backend
  });

  it("does the same when the access cookie is gone but the session is refreshable", () => {
    const response = proxy(req("/payroll", { ag_csrf: "c", ag_persist: "1" }));
    expect(location(response)).toBe(`${APP}/api/auth/refresh/continue?returnTo=${encodeURIComponent("/payroll")}`);
  });

  it("sends an expired session that CANNOT be refreshed to /login?reason=expired", () => {
    const response = proxy(req("/dashboard", { ag_session: EXPIRED }));
    expect(response.status).toBe(307);
    expect(location(response)).toBe(`${APP}/login?reason=expired&returnTo=${encodeURIComponent("/dashboard")}`);
  });

  it("does not bounce /login to the workspace for an EXPIRED token", () => {
    expect(location(proxy(req("/login", { ag_session: EXPIRED, ag_csrf: "c" })))).toBeNull();
    expect(location(proxy(req("/login", { ag_session: VALID })))).toBe(`${APP}/workspace`);
  });
});

describe("GET /api/auth/refresh/continue", () => {
  it("spends the refresh cookie, rotates every cookie and returns to the page (303)", async () => {
    const response = await resume(
      req(`/api/auth/refresh/continue?returnTo=${encodeURIComponent("/dashboard?month=10")}`, {
        ag_session: EXPIRED,
        ag_refresh: REFRESH,
        ag_csrf: "old-csrf",
      }),
    );
    expect(response.status).toBe(303);
    expect(location(response)).toBe(`${APP}/dashboard?month=10`);
    expect(backendCalls).toEqual([{ path: "/v1/auth/refresh", body: { refreshToken: REFRESH } }]);
    const cookies = setCookies(response);
    expect(cookies.ag_session?.value).toBe(NEW_ACCESS);
    expect(cookies.ag_session?.attrs).toMatchObject({ httponly: true, path: "/" });
    expect(cookies.ag_refresh?.value).toBe(NEW_REFRESH);
    expect(cookies.ag_refresh?.attrs).toMatchObject({ httponly: true, path: "/api/auth/refresh", samesite: "strict" });
    expect(cookies.ag_csrf?.value).not.toBe("old-csrf");
    // A browser-session (not "keep me signed in") session stays one: no max-age.
    expect(cookies.ag_session?.attrs["max-age"]).toBeUndefined();

    // …and the page then passes the proxy with the new token, refreshing nothing more.
    const next = proxy(req("/dashboard?month=10", { ag_session: NEW_ACCESS, ag_csrf: cookies.ag_csrf?.value ?? "" }));
    expect(next.status).toBe(200);
    expect(location(next)).toBeNull();
  });

  it("keeps a 'keep me signed in' session persistent across the rotation", async () => {
    const response = await resume(req("/api/auth/refresh/continue?returnTo=%2Fdashboard", { ag_refresh: REFRESH, ag_persist: "1" }));
    const cookies = setCookies(response);
    expect(Number(cookies.ag_session?.attrs["max-age"])).toBeGreaterThan(0);
    expect(Number(cookies.ag_refresh?.attrs["max-age"])).toBeGreaterThan(0);
    expect(cookies.ag_persist?.value).toBe("1");
  });

  it("signs out to /login?reason=expired when the backend refuses the token", async () => {
    refreshAnswer = () => new Response(JSON.stringify({ statusCode: 401, error: "Unauthorized", message: "x" }), { status: 401, headers: { "content-type": "application/json" } });
    const response = await resume(req("/api/auth/refresh/continue?returnTo=%2Fsales", { ag_refresh: REFRESH, ag_csrf: "c" }));
    expect(response.status).toBe(303);
    expect(location(response)).toBe(`${APP}/login?reason=expired&returnTo=${encodeURIComponent("/sales")}`);
    const cookies = setCookies(response);
    for (const name of ["ag_session", "ag_refresh", "ag_csrf", "ag_persist"]) expect([name, cookies[name]?.attrs["max-age"]]).toEqual([name, "0"]);
  });

  it("signs out without calling the backend when there is no refresh cookie", async () => {
    const response = await resume(req("/api/auth/refresh/continue?returnTo=%2Fsales", { ag_csrf: "c" }));
    expect(location(response)).toBe(`${APP}/login?reason=expired&returnTo=${encodeURIComponent("/sales")}`);
    expect(backendCalls).toEqual([]);
  });

  it("keeps the session (the token was never spent) when the backend is unreachable", async () => {
    refreshAnswer = () => {
      throw new TypeError("fetch failed");
    };
    const response = await resume(req("/api/auth/refresh/continue?returnTo=%2Fsales", { ag_refresh: REFRESH, ag_csrf: "c" }));
    expect(location(response)).toBe(`${APP}/login?reason=expired&returnTo=${encodeURIComponent("/sales")}`);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("never returns anywhere but this site's protected area", async () => {
    for (const evil of ["https://evil.example/x", "//evil.example", "/login", "/api/v1/whatever"]) {
      const response = await resume(req(`/api/auth/refresh/continue?returnTo=${encodeURIComponent(evil)}`, { ag_refresh: REFRESH }));
      expect([evil, location(response)]).toEqual([evil, `${APP}/`]);
    }
  });
});
