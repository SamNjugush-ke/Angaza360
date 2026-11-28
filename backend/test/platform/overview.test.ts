// ===========================================================================
// THE COMMAND CENTER OVERVIEW (M4.5 W5) — GET /v1/platform-reports/overview.
//
// Proven: each section RECONCILES to the detail endpoint the console links it to — businesses to
// GET /v1/tenants, the applications pipeline to GET /v1/tenant-applications, business integration
// health to GET /v1/tenants/integration-health, jobs to GET /v1/jobs, recent activity to
// GET /v1/users/audit — and only platform staff may read it.
// ===========================================================================

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { tenantIdOf } from "../setup/tenant";

let app: FastifyInstance;
const users: StaffUser[] = [];
let admin: SignedIn;
let officer: SignedIn;
let owner: SignedIn;
let mentor: SignedIn;
let healthTenant = "";

const get = <T>(url: string, who: SignedIn) =>
  app.inject({ method: "GET", url, remoteAddress: freshIp(), headers: bearer(who.token) }).then((r) => ({ status: r.statusCode, body: r.json<T>() }));

interface Overview {
  businesses: { total: number; byStatus: Record<string, number>; byTier: Record<string, number> };
  applications: { byStatus: Record<string, number>; open: number; awaitingStaff: number; oldestAwaitingDays: number | null };
  users: { activeAccounts: number; signedInLast30Days: number };
  integrations: { businesses: Array<{ provider: string; healthy: number; failing: number }> };
  jobs: { list: Array<{ name: string; lastStatus: string | null }> };
  recentActivity: Array<{ id: string }>;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const [role, tenant] of [["SUPER_ADMIN", null], ["PROGRAM_OFFICER", null], ["MSME_OWNER", await tenantIdOf()], ["MENTOR", null]] as const) users.push(await createStaffUser(role, tenant));
  [admin, officer, owner, mentor] = (await Promise.all(users.map((u) => signIn(app, u)))) as [SignedIn, SignedIn, SignedIn, SignedIn];
  // A failing integration in the mirror, so the strip has something to reconcile.
  healthTenant = await tenantIdOf();
  await platformDb.integrationHealth.upsert({
    where: { tenantId_provider_environment: { tenantId: healthTenant, provider: "ETIMS", environment: "SANDBOX" } },
    create: { tenantId: healthTenant, provider: "ETIMS", environment: "SANDBOX", status: "FAILING", lastCheckAt: new Date(), lastError: `test ${randomBytes(3).toString("hex")}` },
    update: { status: "FAILING", lastCheckAt: new Date(), lastError: "test", lastVerifiedAt: null },
  });
});

afterAll(async () => {
  await platformDb.integrationHealth.deleteMany({ where: { tenantId: healthTenant, provider: "ETIMS", environment: "SANDBOX" } });
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await app.close();
});

describe("the overview reconciles to the detail screens", () => {
  it("every section equals what its detail endpoint lists", async () => {
    const { status, body: o } = await get<Overview>("/v1/platform-reports/overview", admin);
    expect(status).toBe(200);

    const tenants = (await get<{ data: Array<{ status: string; subscriptionTier: string }> }>("/v1/tenants", admin)).body.data;
    expect(o.businesses.total).toBe(tenants.length);
    for (const [s, n] of Object.entries(o.businesses.byStatus)) expect([s, n]).toEqual([s, tenants.filter((t) => t.status === s).length]);
    for (const [t, n] of Object.entries(o.businesses.byTier)) expect([t, n]).toEqual([t, tenants.filter((x) => x.subscriptionTier === t).length]);

    for (const [s, n] of Object.entries(o.applications.byStatus)) {
      const listed = (await get<{ data: unknown[] }>(`/v1/tenant-applications?status=${s}`, admin)).body.data.length;
      expect([s, n]).toEqual([s, listed]);
    }
    expect(o.applications.open).toBe(["SUBMITTED", "UNDER_REVIEW", "NEEDS_CHANGES"].reduce((a, s) => a + (o.applications.byStatus[s] ?? 0), 0));
    expect(o.applications.byStatus.DRAFT).toBeUndefined();

    const health = (await get<{ data: Array<{ provider: string; status: string }> }>("/v1/tenants/integration-health", admin)).body.data;
    for (const row of o.integrations.businesses) {
      expect(row).toEqual({ provider: row.provider, healthy: health.filter((h) => h.provider === row.provider && h.status === "HEALTHY").length, failing: health.filter((h) => h.provider === row.provider && h.status === "FAILING").length });
    }
    expect(o.integrations.businesses.find((b) => b.provider === "ETIMS")?.failing ?? 0).toBeGreaterThan(0);

    const jobs = (await get<{ data: Array<{ name: string; lastRun: { status: string } | null }> }>("/v1/jobs", admin)).body.data;
    expect(o.jobs.list.map((j) => [j.name, j.lastStatus])).toEqual(jobs.map((j) => [j.name, j.lastRun?.status ?? null]));

    const audit = (await get<{ data: Array<{ id: string }> }>("/v1/users/audit?limit=10", admin)).body.data;
    expect(o.recentActivity.map((a) => a.id)).toEqual(audit.map((a) => a.id));

    expect(o.users.activeAccounts).toBe(await platformDb.user.count({ where: { isActive: true } }));
  });

  it("the health mirror narrows to one business for the business detail screen", async () => {
    const one = (await get<{ data: Array<{ tenantId: string }> }>(`/v1/tenants/integration-health?tenantId=${healthTenant}`, admin)).body.data;
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((row) => row.tenantId === healthTenant)).toBe(true);
    expect((await get<{ data: unknown[] }>("/v1/tenants/integration-health?tenantId=no-such-business", admin)).body.data).toEqual([]);
  });

  it("a programme officer reads it too; a business owner and a mentor do not", async () => {
    expect((await get("/v1/platform-reports/overview", officer)).status).toBe(200);
    expect((await get("/v1/platform-reports/overview", owner)).status).toBe(403);
    expect((await get("/v1/platform-reports/overview", mentor)).status).toBe(403);
    // The static path wins over the library's /{id}: it is never read as a report named "overview".
    expect((await get<{ businesses: unknown }>("/v1/platform-reports/overview", admin)).body.businesses).toBeDefined();
  });
});
