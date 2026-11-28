import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/headers and redirect need a live request; stand them in for requireSession.
const jar = new Map<string, string>();
const requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) as string } : undefined) }),
  headers: async () => requestHeaders,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

const { getSession, loginUrl, requireSession } = await import("@/lib/auth/session");

let meResponse: () => Response;
let meCalls: (string | null)[];

beforeEach(() => {
  jar.clear();
  for (const key of [...requestHeaders.keys()]) requestHeaders.delete(key);
  meCalls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(new URL(request.url).pathname).toBe("/v1/auth/me");
    meCalls.push(request.headers.get("authorization"));
    return meResponse();
  });
});

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("getSession", () => {
  it("normalizes /v1/auth/me to the one Session shape, dropping anything extra", async () => {
    meResponse = () =>
      json(200, {
        user: { id: "u1", fullName: "Amina Cashier", email: "amina@shop.co.ke", role: "CASHIER", isActive: true, extra: "x" },
        role: "CASHIER",
        tenant: { id: "t1", name: "Nakuru Hardware", subdomain: "nakuru-hardware", status: "ACTIVE", subscriptionTier: "MWANZO", secret: "no" },
        accessToken: "must-not-survive",
      });
    jar.set("ag_session", "access-1");
    const session = await getSession();
    expect(session).toEqual({
      user: { id: "u1", fullName: "Amina Cashier", email: "amina@shop.co.ke", role: "CASHIER", isActive: true },
      role: "CASHIER",
      actingAs: null,
      tenant: { id: "t1", name: "Nakuru Hardware", subdomain: "nakuru-hardware", status: "ACTIVE", subscriptionTier: "MWANZO" },
    });
    expect(meCalls).toEqual(["Bearer access-1"]);
  });

  it("reads the business name from /me, never from a cookie (T-B-ME-NAME)", async () => {
    meResponse = () =>
      json(200, {
        user: { id: "u1", fullName: "Owner", email: "o@shop.co.ke", role: "MSME_OWNER", isActive: true },
        role: "MSME_OWNER",
        tenant: { id: "t1", name: "Nakuru Hardware & Supplies", subdomain: "nakuru-hardware", status: "ACTIVE", subscriptionTier: "MWANZO" },
      });
    jar.set("ag_session", "access-1");
    // A stale legacy cookie is ignored: a renamed business shows its new name at once.
    jar.set("ag_tenant_name", "Old Name");
    expect((await getSession())?.tenant?.name).toBe("Nakuru Hardware & Supplies");
  });

  it("carries a null tenant for a platform user", async () => {
    meResponse = () =>
      json(200, { user: { id: "m1", fullName: "Mentor", email: "m@angaza.org", role: "MENTOR", isActive: true }, role: "MENTOR", tenant: null });
    jar.set("ag_session", "access-m");
    expect((await getSession())?.tenant).toBeNull();
  });

  it("is null without a cookie (no backend call) and null on a 401", async () => {
    expect(await getSession()).toBeNull();
    expect(meCalls).toHaveLength(0);
    meResponse = () => json(401, { statusCode: 401, error: "Unauthorized", message: "Authentication required." });
    jar.set("ag_session", "expired");
    expect(await getSession()).toBeNull();
  });

  it("throws on a backend failure rather than pretending the user is signed out", async () => {
    meResponse = () => json(500, { statusCode: 500, error: "InternalServerError", message: "boom" });
    jar.set("ag_session", "access-1");
    await expect(getSession()).rejects.toThrow("InternalServerError: boom");
  });
});

describe("requireSession", () => {
  it("redirects to /login with the protected path as returnTo", async () => {
    requestHeaders.set("x-angaza-pathname", "/inventory/products?page=2");
    await expect(requireSession()).rejects.toThrow(
      `REDIRECT /login?returnTo=${encodeURIComponent("/inventory/products?page=2")}`,
    );
  });

  it("marks a refused cookie as expired, which is what breaks the /login ↔ / loop", async () => {
    meResponse = () => json(401, { statusCode: 401, error: "Unauthorized", message: "Authentication required." });
    jar.set("ag_session", "stale");
    requestHeaders.set("x-angaza-pathname", "/pos");
    await expect(requireSession()).rejects.toThrow("REDIRECT /login?returnTo=%2Fpos&reason=expired");
  });

  it("ignores an unsafe path header", async () => {
    requestHeaders.set("x-angaza-pathname", "//evil.example");
    await expect(requireSession()).rejects.toThrow(/^REDIRECT \/login$/);
  });

  it("returns the session when there is one", async () => {
    meResponse = () =>
      json(200, { user: { id: "u1", fullName: "Owner", email: "o@shop.co.ke", role: "MSME_OWNER", isActive: true }, role: "MSME_OWNER", tenant: null });
    jar.set("ag_session", "access-1");
    expect((await requireSession()).role).toBe("MSME_OWNER");
  });
});

describe("loginUrl", () => {
  it("builds the login URL", () => {
    expect(loginUrl({})).toBe("/login");
    expect(loginUrl({ expired: true })).toBe("/login?reason=expired");
    expect(loginUrl({ returnTo: "https://evil.example" })).toBe("/login");
  });
});
