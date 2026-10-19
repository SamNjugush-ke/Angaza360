// ===========================================================================
// DONOR PROJECTS / COHORTS (Task T-A12), reusing Module 14's consented, logged,
// READ-ONLY gate.
//
// * A NON-CONSENTED member is EXCLUDED from the aggregate and its books are never opened
//   (binding); consent and withdrawal flip inclusion, and are audited.
// * The aggregate's figures are each consented business's OWN income statement, summed.
// * A write attempted through the donor read gate is refused by PostgreSQL with 25006
//   (binding — the same READ ONLY guarantee mentorship has).
// * Every member read writes a donor_access_logs row first; the database refuses a log for
//   a non-consented member and refuses to change or delete one; consent from anyone but the
//   business's own owner is refused.
// * Tenant users cannot reach the staff routes; an owner sees only their own membership.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { withConsentedMember } from "../../src/services/donor/aggregate";
import { buildIncomeStatement, resolvePeriod } from "../../src/services/reports";
import { recordSale } from "../../src/services/sales";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf } from "../setup/tenant";
import { expectDbRefusal, sqlStateOf } from "../support/db-errors";
import { openTill } from "../support/fixtures";
import { withPlatformTx } from "../support/platform-tx";
import { accessTokenFor, freshIp } from "../security/http-app";
import { bearer, createStaffUser, signIn, type SignedIn } from "../identity/staff-fixture";
import { platformStaff, type PlatformStaff } from "../onboarding/onboarding-fixture";

const A = "qa-donor-a";
const B = "qa-donor-b";
const CODE = `QA-DONOR-${randomUUID().slice(0, 6).toUpperCase()}`;

let app: FastifyInstance;
let staff: PlatformStaff;
let ownerA: SignedIn;
let ownerB: SignedIn;
let tenantA = "";
let tenantB = "";
let projectId = "";
let membershipA = "";
let membershipB = "";

async function sellService(subdomain: string, amount: bigint): Promise<void> {
  const db = tenantDb(subdomain);
  const product = await db.product.create({ data: { sku: `SVC-${randomUUID().slice(0, 6)}`, name: "Service", costPrice: 0n, price: amount, kind: "SERVICE" } });
  const till = await openTill(db);
  await recordSale(db, {
    shiftId: till.shiftId,
    createdBy: till.cashierId,
    lines: [{ productId: product.id, quantity: "1" }],
    tenders: [{ tenderType: "CASH", amount: `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, "0")}` }],
  });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  staff = await platformStaff(app);
  for (const [sub, name] of [
    [A, "QA Donor Business A"],
    [B, "QA Donor Business B"],
  ] as const) {
    await dropTenant(sub);
    await provisionFixture(sub, name);
  }
  tenantA = await tenantIdOf(A);
  tenantB = await tenantIdOf(B);
  // A is tagged with the programme code in the registry: it is enrolled at creation.
  await platformDb.tenant.update({ where: { id: tenantA }, data: { donorProjectCode: CODE } });
  ownerA = await signIn(app, await createStaffUser("MSME_OWNER", tenantA));
  ownerB = await signIn(app, await createStaffUser("MSME_OWNER", tenantB));
  await sellService(A, 120000n);
  await sellService(B, 30000n);
});

afterAll(async () => {
  await dropTenant(A);
  await dropTenant(B);
  await platformDb.user.deleteMany({ where: { id: { in: staff.users.map((u) => u.id) } } });
  await app.close();
});

interface AggregateBody {
  members: { total: number; consented: number; pending: number; withdrawn: number };
  businessesIncluded: number;
  totalRevenue: string;
  medianRevenue: string;
  consentedMembers: Array<{ tenantId: string; revenue: string }>;
}

async function aggregate(): Promise<AggregateBody> {
  const response = await app.inject({
    method: "GET",
    url: `/v1/donor-projects/${projectId}/aggregate`,
    remoteAddress: freshIp(),
    headers: bearer(staff.officer.token),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AggregateBody>();
}

async function logsFor(tenantId: string): Promise<number> {
  return platformDb.donorAccessLog.count({ where: { projectId, tenantId } });
}

function consent(owner: SignedIn, membershipId: string, action: "consent" | "withdraw") {
  return app.inject({ method: "POST", url: `/v1/donor-projects/my-memberships/${membershipId}/${action}`, headers: bearer(owner.token) });
}

async function ownRevenue(subdomain: string): Promise<bigint> {
  const statement = await buildIncomeStatement({ reader: tenantDb(subdomain), schema: schemaOf(subdomain) }, resolvePeriod({}), false);
  return statement.revenue.total;
}

describe("a project and its members", () => {
  it("creating a project enrols the registry-tagged business; another is added explicitly; both PENDING", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/donor-projects",
      headers: bearer(staff.officer.token),
      payload: { code: CODE, name: "QA Resilience Fund", donor: "QA Donor" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ seeded: 1, project: { code: CODE, status: "ACTIVE" } });
    projectId = created.json<{ project: { id: string } }>().project.id;

    const added = await app.inject({ method: "POST", url: `/v1/donor-projects/${projectId}/members`, headers: bearer(staff.superAdmin.token), payload: { tenantId: tenantB } });
    expect(added.statusCode).toBe(201);
    const project = await app.inject({ method: "GET", url: `/v1/donor-projects/${projectId}`, headers: bearer(staff.officer.token) });
    const members = project.json<{ members: Array<{ id: string; tenantId: string; consentStatus: string }> }>().members;
    expect(members.map((m) => [m.tenantId, m.consentStatus]).sort()).toEqual([[tenantA, "PENDING"], [tenantB, "PENDING"]].sort());
    membershipA = members.find((m) => m.tenantId === tenantA)?.id ?? "";
    membershipB = members.find((m) => m.tenantId === tenantB)?.id ?? "";
    expect(await platformDb.auditLog.count({ where: { action: "DONOR_MEMBER_ADDED", tenantId: { in: [tenantA, tenantB] } } })).toBeGreaterThanOrEqual(2);
  });
});

describe("consent gates the aggregate", () => {
  it("with no consent, nothing is read and nothing is aggregated", async () => {
    const body = await aggregate();
    expect(body).toMatchObject({ businessesIncluded: 0, totalRevenue: "0", members: { total: 2, consented: 0, pending: 2 } });
    expect(await logsFor(tenantA)).toBe(0);
    expect(await logsFor(tenantB)).toBe(0);
  });

  it("a NON-CONSENTED member is EXCLUDED: only the consenting business is read and aggregated", async () => {
    expect((await consent(ownerA, membershipA, "consent")).statusCode).toBe(200);
    const body = await aggregate();
    expect(body.businessesIncluded).toBe(1);
    expect(body.consentedMembers.map((m) => m.tenantId)).toEqual([tenantA]);
    expect(BigInt(body.totalRevenue)).toBe(await ownRevenue(A));
    // A's books were read once, logged first; B's were never opened.
    expect(await logsFor(tenantA)).toBe(1);
    expect(await logsFor(tenantB)).toBe(0);
  });

  it("consent and withdrawal flip inclusion, and are audited", async () => {
    expect((await consent(ownerB, membershipB, "consent")).statusCode).toBe(200);
    const both = await aggregate();
    expect(both.businessesIncluded).toBe(2);
    expect(BigInt(both.totalRevenue)).toBe((await ownRevenue(A)) + (await ownRevenue(B)));
    expect(BigInt(both.medianRevenue)).toBe(((await ownRevenue(A)) + (await ownRevenue(B))) / 2n);

    expect((await consent(ownerB, membershipB, "withdraw")).statusCode).toBe(200);
    const withdrawn = await aggregate();
    expect(withdrawn.consentedMembers.map((m) => m.tenantId)).toEqual([tenantA]);
    expect(withdrawn.members.withdrawn).toBe(1);

    expect(await platformDb.auditLog.count({ where: { action: "DONOR_CONSENT_GIVEN", tenantId: tenantB } })).toBe(1);
    expect(await platformDb.auditLog.count({ where: { action: "DONOR_CONSENT_WITHDRAWN", tenantId: tenantB, actorUserId: ownerB.user.id } })).toBe(1);
  });
});

describe("the donor read gate is READ ONLY and logged", () => {
  it("a write attempted through the gate is refused by PostgreSQL with 25006 — and the attempt was logged", async () => {
    const actor = { userId: staff.officer.user.id, role: "PROGRAM_OFFICER" as const, tenantId: null, ipAddress: null };
    const before = await logsFor(tenantA);
    const schemaA = schemaOf(A);
    const error = await withConsentedMember(actor, projectId, { tenantId: tenantA, dbSchema: schemaA }, "test:write-attempt", async (source) => {
      await source.reader.$queryRawUnsafe(`UPDATE "${schemaA}".accounts SET "name" = "name" || ' (tampered)' RETURNING "id"`);
      return "written";
    }).catch((caught: unknown) => caught);
    expect(sqlStateOf(error)).toBe("25006");
    expect(await logsFor(tenantA)).toBe(before + 1);
    const tampered = await tenantDb(A).account.count({ where: { name: { endsWith: "(tampered)" } } });
    expect(tampered).toBe(0);
  });

  it("the database refuses a log row — and so a read — for a non-consented member", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(`INSERT INTO public.donor_access_logs ("id", "projectId", "tenantId", "readerUserId", "resource") VALUES ($1, $2, $3, 'x', 'raw')`, [
          randomUUID(),
          projectId,
          tenantB,
        ]),
        { fn: "donor_access_log_guard", message: /CONSENTED member of an ACTIVE donor project/ },
      );
    });
  });

  it("the access log is append-only", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.donor_access_logs SET "resource" = 'x' WHERE "tenantId" = $1`, [tenantA]), {
        fn: "donor_access_log_guard",
        message: /append-only: UPDATE/,
      });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`DELETE FROM public.donor_access_logs WHERE "tenantId" = $1`, [tenantA]), {
        fn: "donor_access_log_guard",
        message: /append-only: DELETE/,
      });
    });
  });

  it("consent from anyone but the business's own owner is refused by the database", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(`UPDATE public.donor_project_memberships SET "consentStatus" = 'CONSENTED', "consentByUserId" = $1, "consentAt" = now() WHERE "id" = $2`, [
          ownerA.user.id,
          membershipB,
        ]),
        { fn: "donor_membership_guard", message: /active MSME_OWNER of the business itself/ },
      );
    });
  });

  it("the owner reads every cohort read of their own books", async () => {
    const response = await app.inject({ method: "GET", url: `/v1/donor-projects/my-memberships/${membershipA}/access-log`, headers: bearer(ownerA.token) });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: unknown[] }>().data.length).toBe(await logsFor(tenantA));
  });
});

describe("scope", () => {
  it("tenant users cannot reach the staff routes; an owner cannot touch another business's membership", async () => {
    expect((await app.inject({ method: "GET", url: `/v1/donor-projects/${projectId}/aggregate`, headers: bearer(ownerA.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/donor-projects", headers: bearer(ownerA.token) })).statusCode).toBe(403);
    const cashier = await createStaffUser("CASHIER", tenantA);
    const cashierToken = await accessTokenFor(app, cashier);
    expect((await app.inject({ method: "GET", url: "/v1/donor-projects/my-memberships", headers: bearer(cashierToken) })).statusCode).toBe(403);
    expect((await consent(ownerB, membershipA, "withdraw")).statusCode).toBe(404);
    expect((await consent(ownerA, membershipB, "consent")).statusCode).toBe(404);
  });
});
