// ===========================================================================
// INTEGRATION LIVE-VERIFY + HEALTH (M4.5 Wave 1, T-B1), through the REAL app.
//
// * POST /v1/integrations/{provider}/verify tests the STORED credentials (ACTIVE or still
//   PENDING) through the provider and records healthStatus / lastHealthCheckAt /
//   lastHealthError (and lastVerifiedAt on success) on the business's own row, mirrored
//   for the platform's Command Center in the same transaction.
// * NO SECRET LEAKS: not in the response, not in the stored error, not in the mirror —
//   even when the provider's own words echo a credential back.
// * A rotation returns the health to UNVERIFIED; RBAC holds; the CHECKs refuse an
//   incoherent health record from raw SQL.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config/env";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { scrubSecrets } from "../../src/services/credentials/scrub";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { dropTenant, provisionFixture, tenantDb, tenantIdOf, withTenantTx } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";

const T = "qa-health";
const SECRET_KEY = "CONSUMER-KEY-very-secret-001";
const SECRET_SECRET = "CONSUMER-SECRET-very-secret-002";
const PASSKEY = "PASSKEY-very-secret-003";
const TIN = "P051234567X";

let app: FastifyInstance;
const users: StaffUser[] = [];
let owner: SignedIn;
let manager: SignedIn;
let cashier: SignedIn;
let admin: SignedIn;
let tenantId = "";

async function putMpesa(): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: "/v1/integrations/MPESA/credentials",
    headers: bearer(owner.token),
    payload: { environment: "SANDBOX", fields: { consumerKey: SECRET_KEY, consumerSecret: SECRET_SECRET, shortcode: "174379", passkey: PASSKEY } },
  });
  expect(response.statusCode, response.body).toBe(200);
}

function verify(provider: "MPESA" | "ETIMS", as: SignedIn = owner) {
  return app.inject({ method: "POST", url: `/v1/integrations/${provider}/verify`, headers: bearer(as.token), payload: { environment: "SANDBOX" } });
}

function expectNoSecret(text: string): void {
  for (const secret of [SECRET_KEY, SECRET_SECRET, PASSKEY]) {
    expect(text).not.toContain(secret);
  }
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await dropTenant(T);
  await provisionFixture(T, "QA Health");
  tenantId = await tenantIdOf(T);
  const make = async (role: StaffUser["role"], tenant: string | null) => {
    const user = await createStaffUser(role, tenant);
    users.push(user);
    return signIn(app, user);
  };
  owner = await make("MSME_OWNER", tenantId);
  manager = await make("MSME_MANAGER", tenantId);
  cashier = await make("CASHIER", tenantId);
  admin = await make("SUPER_ADMIN", null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await platformDb.integrationHealth.deleteMany({ where: { tenantId } });
  await platformDb.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await dropTenant(T);
  await app.close();
});

describe("live verify", () => {
  it("nothing stored is a 404", async () => {
    expect((await verify("MPESA")).statusCode).toBe(404);
  });

  it("verifies a stored (still PENDING) M-Pesa credential: HEALTHY, lastVerifiedAt, mirrored — no secret anywhere", async () => {
    await putMpesa();
    const response = await verify("MPESA");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ provider: "MPESA", environment: "SANDBOX", ok: true, credential: { status: "PENDING", healthStatus: "HEALTHY", lastHealthError: null } });
    expectNoSecret(response.body);
    const row = await tenantDb(T).tenantIntegrationCredential.findUniqueOrThrow({ where: { provider_environment: { provider: "MPESA", environment: "SANDBOX" } } });
    expect(row.healthStatus).toBe("HEALTHY");
    expect(row.lastVerifiedAt).not.toBeNull();
    const mirror = await platformDb.integrationHealth.findUniqueOrThrow({ where: { tenantId_provider_environment: { tenantId, provider: "MPESA", environment: "SANDBOX" } } });
    expect(mirror.status).toBe("HEALTHY");
    expect(mirror.lastError).toBeNull();
  });

  it("an uninitialized eTIMS device is FAILING, with the reason in words, mirrored", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/integrations/ETIMS/credentials",
      headers: bearer(owner.token),
      payload: { environment: "SANDBOX", fields: { tin: TIN, bhfId: "00", dvcSrlNo: "DEV-HEALTH-01", apiBaseUrl: "https://etims.example.invalid" } },
    });
    expect(put.statusCode, put.body).toBe(200);
    const response = await verify("ETIMS");
    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; detail: string; credential: { healthStatus: string; lastHealthError: string } }>();
    expect(body.ok).toBe(false);
    expect(body.credential.healthStatus).toBe("FAILING");
    expect(body.detail).toMatch(/not been initialized/);
    expect(response.body).not.toContain(TIN);
    const mirror = await platformDb.integrationHealth.findUniqueOrThrow({ where: { tenantId_provider_environment: { tenantId, provider: "ETIMS", environment: "SANDBOX" } } });
    expect(mirror.status).toBe("FAILING");
  });

  it("scrubs a secret the provider echoes back — from the response, the stored error and the mirror", async () => {
    const mpesa = env.mpesa as { provider: string; callbackBaseUrl: string | null };
    const saved = { provider: mpesa.provider, callbackBaseUrl: mpesa.callbackBaseUrl };
    mpesa.provider = "daraja";
    mpesa.callbackBaseUrl = "https://api.angaza360.test";
    vi.stubGlobal("fetch", () => Promise.reject(new Error(`getaddrinfo failed for key=${SECRET_KEY} secret=${SECRET_SECRET}`)));
    try {
      const response = await verify("MPESA");
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ ok: boolean; detail: string }>();
      expect(body.ok).toBe(false);
      expect(body.detail).toContain("[redacted]");
      expectNoSecret(response.body);
    } finally {
      mpesa.provider = saved.provider;
      mpesa.callbackBaseUrl = saved.callbackBaseUrl;
    }
    const row = await tenantDb(T).tenantIntegrationCredential.findUniqueOrThrow({ where: { provider_environment: { provider: "MPESA", environment: "SANDBOX" } } });
    expect(row.healthStatus).toBe("FAILING");
    expectNoSecret(row.lastHealthError ?? "");
    const mirror = await platformDb.integrationHealth.findUniqueOrThrow({ where: { tenantId_provider_environment: { tenantId, provider: "MPESA", environment: "SANDBOX" } } });
    expectNoSecret(mirror.lastError ?? "");
    // The last success is remembered on the mirror even while failing.
    expect(mirror.lastVerifiedAt).not.toBeNull();
  });

  it("a rotation returns the credential to UNVERIFIED", async () => {
    await putMpesa();
    const row = await tenantDb(T).tenantIntegrationCredential.findUniqueOrThrow({ where: { provider_environment: { provider: "MPESA", environment: "SANDBOX" } } });
    expect(row.healthStatus).toBe("UNVERIFIED");
    expect(row.lastHealthError).toBeNull();
  });
});

describe("who may verify and read", () => {
  it("the owner verifies; a manager reads health but cannot verify; a cashier does neither", async () => {
    expect((await verify("MPESA", manager)).statusCode).toBe(403);
    expect((await verify("MPESA", cashier)).statusCode).toBe(403);
    const read = await app.inject({ method: "GET", url: "/v1/integrations/health", headers: bearer(manager.token) });
    expect(read.statusCode).toBe(200);
    expectNoSecret(read.body);
    expect((await app.inject({ method: "GET", url: "/v1/integrations/health", headers: bearer(cashier.token) })).statusCode).toBe(403);
  });

  it("platform staff read every business's health from the mirror; a business user cannot", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/tenants/integration-health?status=FAILING", headers: bearer(admin.token) });
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ data: Array<{ tenantId: string; businessName: string; provider: string; status: string }> }>().data;
    expect(rows.some((row) => row.tenantId === tenantId && row.businessName === "QA Health" && row.provider === "ETIMS")).toBe(true);
    expect(rows.every((row) => row.status === "FAILING")).toBe(true);
    expectNoSecret(response.body);
    expect((await app.inject({ method: "GET", url: "/v1/tenants/integration-health", headers: bearer(owner.token) })).statusCode).toBe(403);
  });
});

describe("scrubSecrets", () => {
  it("replaces every stored value, longest first, and leaves short values alone", () => {
    expect(scrubSecrets("key ABCDEF and ABCDEFGH, id 42", ["ABCDEF", "ABCDEFGH", "42"])).toBe("key [redacted] and [redacted], id 42");
  });
});

describe("the health CHECKs, attacked from raw SQL", () => {
  it("refuses HEALTHY with an error, FAILING without one, and an unknown status (control: a coherent FAILING)", async () => {
    for (const [sql, label] of [
      [`UPDATE "$S".tenant_integration_credentials SET "healthStatus" = 'HEALTHY', "lastHealthCheckAt" = now(), "lastHealthError" = 'x'`, "healthy+error"],
      [`UPDATE "$S".tenant_integration_credentials SET "healthStatus" = 'FAILING', "lastHealthCheckAt" = now(), "lastHealthError" = NULL`, "failing w/o error"],
      [`UPDATE "$S".tenant_integration_credentials SET "healthStatus" = 'MAYBE'`, "unknown"],
    ] as const) {
      await withTenantTx(T, async (client, schema) => {
        await expectDbRefusal(client.query(sql.replace("$S", schema)), { constraint: "credential_health_coherent", code: "23514" });
      });
      expect(label).toBeTruthy();
    }
    await withTenantTx(T, async (client, schema) => {
      await client.query(`UPDATE "${schema}".tenant_integration_credentials SET "healthStatus" = 'FAILING', "lastHealthCheckAt" = now(), "lastHealthError" = 'unreachable'`);
    });
  });

  it("the platform mirror refuses an incoherent row too", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(`INSERT INTO public.integration_health ("tenantId","provider","environment","status","lastCheckAt","lastError") VALUES ('t','MPESA','SANDBOX','HEALTHY', now(), 'boom')`),
        { constraint: "integration_health_coherent", code: "23514" },
      );
    });
  });
});
