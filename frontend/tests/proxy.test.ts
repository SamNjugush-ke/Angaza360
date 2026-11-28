import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PROTECTED_PREFIXES } from "@/lib/auth/landing";
import { config, proxy } from "@/proxy";

function visit(path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (jar) h.set("cookie", jar);
  return proxy(new NextRequest(`http://app.test${path}`, { headers: h }));
}

const location = (response: Response) => response.headers.get("location");

/** An access token that expired an hour ago (the proxy reads exp, unverified). */
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const EXPIRED = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "u", exp: Math.floor(Date.now() / 1000) - 3600 })}.sig`;

describe("proxy (the Next 16 middleware)", () => {
  it("sends an unauthenticated visitor to /login with a returnTo", () => {
    for (const path of PROTECTED_PREFIXES) {
      const response = visit(path);
      expect(response.status).toBe(307);
      expect(location(response)).toBe(`http://app.test/login?returnTo=${encodeURIComponent(path)}`);
    }
  });

  it("keeps the subpath and query in the returnTo", () => {
    const response = visit("/inventory/products?page=2");
    expect(location(response)).toBe(`http://app.test/login?returnTo=${encodeURIComponent("/inventory/products?page=2")}`);
  });

  it("lets a request with a session cookie through, handing the path to the layout", () => {
    const response = visit("/pos/shift", { ag_session: "x" }, { "x-angaza-pathname": "/admin" });
    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
    // The overridden request header carries OUR value, not the client's.
    expect(response.headers.get("x-middleware-request-x-angaza-pathname")).toBe("/pos/shift");
  });

  it("sends a signed-in visitor away from /login, straight to their workspace", () => {
    const response = visit("/login", { ag_session: "x" });
    expect(response.status).toBe(307);
    expect(location(response)).toBe("http://app.test/workspace");
  });

  it("shows the landing at / to an anonymous visitor", () => {
    const response = visit("/");
    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
  });

  it("sends a signed-in visitor's / to /workspace (the landing stays static)", () => {
    const response = visit("/", { ag_session: "x" });
    expect(response.status).toBe(307);
    expect(location(response)).toBe("http://app.test/workspace");
  });

  it("refreshes a session that has lapsed but can be refreshed before deciding what / shows", () => {
    const response = visit("/", { ag_session: EXPIRED, ag_csrf: "c" });
    expect(location(response)).toBe("http://app.test/api/auth/refresh/continue");
  });

  it("lets a refused (expired) session reach /login — no redirect loop", () => {
    const response = visit("/login?reason=expired", { ag_session: "stale" });
    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
  });

  it("lets an anonymous visitor reach /login", () => {
    expect(visit("/login").status).toBe(200);
  });

  it("matches only /, /login and the protected area — never /api, /_next or assets", () => {
    expect(config.matcher).toEqual(["/", "/login", ...PROTECTED_PREFIXES.map((prefix) => `${prefix}/:path*`)]);
    for (const pattern of config.matcher) expect(pattern).not.toMatch(/^\/(api|_next)|\.(svg|png|ico)/);
  });
});
