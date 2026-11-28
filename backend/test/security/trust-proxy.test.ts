// ===========================================================================
// X-FORWARDED-FOR IS HONOURED ONLY FROM THE TRUSTED PROXY (Task T-B-PROXY).
//
// The BFF signs users in on their behalf, so without proxy trust every user shares the BFF's
// address — one login budget for the whole business. With TRUST_PROXY naming the BFF, req.ip is
// the real client from X-Forwarded-For, and so is every rate-limit key; a caller that is NOT the
// trusted proxy cannot claim an address by sending the header. Observed through the login
// limiter (LOGIN_RATE_LIMIT_MAX = 5 per IP+email in the suite).
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTrustedProxies } from "../../src/config/env";

const saved = process.env["TRUST_PROXY"];
let built: FastifyInstance | null = null;

async function appWith(trustProxy: string | undefined): Promise<FastifyInstance> {
  if (trustProxy === undefined) delete process.env["TRUST_PROXY"];
  else process.env["TRUST_PROXY"] = trustProxy;
  vi.resetModules();
  const fresh = await import("../../src/server");
  const app = await fresh.buildServer();
  await app.ready();
  built = app;
  return app;
}

afterEach(async () => {
  if (built !== null) {
    await built.close();
    built = null;
  }
  if (saved === undefined) delete process.env["TRUST_PROXY"];
  else process.env["TRUST_PROXY"] = saved;
  vi.resetModules();
});

/** Six failed logins for one email, each claiming a different client address. */
async function sixLogins(app: FastifyInstance, remoteAddress: string, email: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 1; i <= 6; i += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress,
      headers: { "x-forwarded-for": `203.0.113.${i.toString()}` },
      payload: { email, password: "definitely-not-the-password" },
    });
    statuses.push(response.statusCode);
  }
  return statuses;
}

describe("TRUST_PROXY parsing", () => {
  it("accepts exact addresses and ranges, and trusts nothing when unset", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("  ")).toEqual([]);
    expect(parseTrustedProxies("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(parseTrustedProxies("10.0.0.0/8, ::1 ,172.16.5.4")).toEqual(["10.0.0.0/8", "::1", "172.16.5.4"]);
  });

  it("refuses to trust everything, and refuses what is not an address", () => {
    for (const blind of ["true", "*", "0.0.0.0/0", "::/0", "127.0.0.1,true"]) {
      expect(() => parseTrustedProxies(blind)).toThrow(/would trust every address/);
    }
    for (const bad of ["localhost", "999.1.1.1", "10.0.0.0/40", "10.0.0.0/", "1.2.3.4/8/9"]) {
      expect(() => parseTrustedProxies(bad)).toThrow(/not an IP address or CIDR/);
    }
  });
});

describe("the client address behind the BFF", () => {
  it("is taken from X-Forwarded-For when the request comes FROM the trusted proxy", async () => {
    const app = await appWith("127.0.0.1");
    // Six different clients behind the BFF: each has its own budget, so none is throttled.
    const statuses = await sixLogins(app, "127.0.0.1", "proxied-client@example.test");
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401]);
  });

  it("is IGNORED from anyone else — a forged header does not dodge the limit", async () => {
    const app = await appWith("127.0.0.1");
    const statuses = await sixLogins(app, "10.77.0.1", "forger@example.test");
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it("is ignored from everyone when no proxy is configured (the default)", async () => {
    const app = await appWith(undefined);
    const statuses = await sixLogins(app, "127.0.0.1", "untrusted-bff@example.test");
    expect(statuses[5]).toBe(429);
  });
});
