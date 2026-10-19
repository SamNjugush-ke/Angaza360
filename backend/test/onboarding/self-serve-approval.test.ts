// ===========================================================================
// SELF-SERVE SIGNUP + THE APPROVAL QUEUE (Task T-A6.2).
//
// * POST /v1/public/signup creates a PENDING_APPROVAL application and NO tenant.
// * Enumeration-safe: a duplicate KRA PIN gets the SAME 202 as a clean signup; the
//   reviewer sees the clash and approval refuses it. A taken business name is a 400.
// * Approval re-runs the green-gate AT APPROVAL TIME (binding): a name taken between
//   submit and approve refuses the approval with the reason and provisions nothing.
// * Approval provisions, invites the owner and stamps resultingTenantId; rejection records
//   the reason; a decision is final (service 409 and the guard / CHECK from raw SQL).
// * The public endpoint is rate-limited; the queue is platform-scoped.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { RATE_LIMITS } from "../../src/plugins/security";
import { buildServer } from "../../src/server";
import { provisionFixture } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";
import { bearer } from "../identity/staff-fixture";
import { cleanUp, freshCandidate, platformStaff, type Candidate, type PlatformStaff } from "./onboarding-fixture";

let app: FastifyInstance;
let staff: PlatformStaff;
let tenantOwner: TestUser;
const provisioned: string[] = [];
const applicationIds: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  staff = await platformStaff(app);
  tenantOwner = await createFixtureUser("MSME_OWNER");
});

afterAll(async () => {
  // Pending applications are removable; decided ones are permanent records by design.
  await platformDb.tenantApplication.deleteMany({ where: { id: { in: applicationIds }, status: "PENDING_APPROVAL" } });
  await deleteUsers([tenantOwner]);
  await cleanUp(provisioned, staff.users);
  await app.close();
});

function signup(candidate: Candidate, ip: string = freshIp()) {
  const { subdomain: _ignored, ...body } = candidate;
  return app.inject({ method: "POST", url: "/v1/public/signup", remoteAddress: ip, payload: body });
}

async function submitted(candidate: Candidate): Promise<string> {
  const response = await signup(candidate);
  expect(response.statusCode, response.body).toBe(202);
  const id = response.json<{ applicationId: string }>().applicationId;
  applicationIds.push(id);
  return id;
}

function approve(id: string, token: string = staff.superAdmin.token) {
  return app.inject({ method: "POST", url: `/v1/tenant-applications/${id}/approve`, remoteAddress: freshIp(), headers: bearer(token) });
}

describe("public signup", () => {
  it("creates a PENDING_APPROVAL application and NO tenant, and audits it", async () => {
    const candidate = freshCandidate();
    const tenantsBefore = await platformDb.tenant.count();
    const id = await submitted(candidate);
    const row = await platformDb.tenantApplication.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "PENDING_APPROVAL", source: "SELF_SERVE", businessName: candidate.businessName, resultingTenantId: null });
    expect(row.proposedSubdomain).toMatch(/^qa-onboarded-/);
    expect(await platformDb.tenant.count()).toBe(tenantsBefore);
    expect(await platformDb.tenant.count({ where: { name: candidate.businessName } })).toBe(0);
    const audit = await platformDb.auditLog.findFirstOrThrow({
      where: { action: "APPLICATION_SUBMITTED", metadata: { path: ["applicationId"], equals: id } },
    });
    expect(audit).toMatchObject({ actorUserId: null, tenantId: null });
  });

  it("a taken business name is a 400 ('pick another'); a malformed field is a 400", async () => {
    const taken = await signup(freshCandidate({ businessName: "QA Fixture Business" }));
    expect(taken.statusCode).toBe(400);
    expect(taken.json<{ message: string }>().message).toMatch(/businessName: That business name is already registered\. Pick another\./);
    const malformed = await signup(freshCandidate({ kraPin: "nope" }));
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ message: string }>().message).toMatch(/kraPin/);
  });

  it(`is rate-limited on the AUTH tier (${RATE_LIMITS.AUTH.max.toString()} per IP)`, async () => {
    const ip = freshIp();
    for (let i = 0; i < RATE_LIMITS.AUTH.max; i += 1) {
      expect((await signup(freshCandidate({ businessName: "" }), ip)).statusCode).toBe(400);
    }
    expect((await signup(freshCandidate({ businessName: "" }), ip)).statusCode).toBe(429);
  });
});

describe("approval", () => {
  it("provisions the business, invites the owner and stamps resultingTenantId", async () => {
    const candidate = freshCandidate({ taxRegime: "TURNOVER_TAX", requestedTier: null });
    const id = await submitted(candidate);
    const response = await approve(id);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ application: { status: string; resultingTenantId: string }; onboarded: { tenant: { id: string; subdomain: string; subscriptionTier: string } } }>();
    provisioned.push(body.onboarded.tenant.subdomain);
    expect(body.application).toMatchObject({ status: "APPROVED", resultingTenantId: body.onboarded.tenant.id });
    // The billing seam resolved the default tier; provisioning starts it TRIALING.
    expect(body.onboarded.tenant.subscriptionTier).toBe("MWANZO");
    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: body.onboarded.tenant.id } });
    expect(tenant).toMatchObject({ status: "ACTIVE", name: candidate.businessName, subscriptionStatus: "TRIALING", taxRegime: "TURNOVER_TAX" });
    const invitation = await platformDb.userInvitation.findFirstOrThrow({ where: { email: candidate.ownerEmail, status: "PENDING" } });
    expect(invitation).toMatchObject({ role: "MSME_OWNER", tenantId: tenant.id });
    expect(await platformDb.auditLog.count({ where: { action: "APPLICATION_APPROVED", tenantId: tenant.id } })).toBe(1);
    expect(await platformDb.auditLog.count({ where: { action: "TENANT_ONBOARDED", tenantId: tenant.id } })).toBe(1);

    // A decision is final.
    expect((await approve(id)).statusCode).toBe(409);
  });

  it("dedup is RE-CHECKED at approval: a name taken between submit and approve refuses it, provisioning nothing", async () => {
    const candidate = freshCandidate();
    const id = await submitted(candidate);
    // The name is taken by another route since submission (the scripted provisioning path).
    const sub = `qa-race-${randomUUID().slice(0, 6)}`;
    await provisionFixture(sub, candidate.businessName.toUpperCase());
    provisioned.push(sub);
    const tenantsBefore = await platformDb.tenant.count();

    const response = await approve(id);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/no longer green.*businessName: That business name is already registered/);
    expect(await platformDb.tenant.count()).toBe(tenantsBefore);
    expect((await platformDb.tenantApplication.findUniqueOrThrow({ where: { id } })).status).toBe("PENDING_APPROVAL");
  });

  it("enumeration-safe: a duplicate KRA PIN gets the SAME 202; the reviewer sees it; approval refuses it", async () => {
    const first = freshCandidate();
    const firstId = await submitted(first);
    const clash = freshCandidate({ kraPin: first.kraPin ?? null });
    const response = await signup(clash);
    expect(response.statusCode).toBe(202);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual(["applicationId", "message"]);
    const clashId = response.json<{ applicationId: string }>().applicationId;
    applicationIds.push(clashId);

    const review = await app.inject({ method: "GET", url: `/v1/tenant-applications/${clashId}`, headers: bearer(staff.officer.token) });
    expect(review.json()).toMatchObject({ validation: { status: "RED", errors: [{ field: "kraPin", code: "DUPLICATE" }] } });
    expect((await approve(clashId)).statusCode).toBe(409);
    expect((await platformDb.tenantApplication.findUniqueOrThrow({ where: { id: firstId } })).status).toBe("PENDING_APPROVAL");
  });
});

describe("rejection, finality and scope", () => {
  it("records the reason; a rejected application cannot be approved", async () => {
    const id = await submitted(freshCandidate());
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/tenant-applications/${id}/reject`,
      headers: bearer(staff.officer.token),
      payload: { reason: "Not an MSME." },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: "REJECTED", rejectionReason: "Not an MSME.", reviewedById: staff.officer.user.id });
    expect((await approve(id)).statusCode).toBe(409);
    expect(await platformDb.auditLog.count({ where: { action: "APPLICATION_REJECTED", metadata: { path: ["applicationId"], equals: id } } })).toBe(1);

    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.tenant_applications SET "status" = 'PENDING_APPROVAL', "reviewedAt" = NULL, "rejectionReason" = NULL WHERE "id" = $1`, [id]), {
        fn: "tenant_application_guard",
        message: /final/,
      });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`DELETE FROM public.tenant_applications WHERE "id" = $1`, [id]), {
        fn: "tenant_application_guard",
        message: /permanent record/,
      });
    });
  });

  it("the resting state is coherent: a rejection without a reason is refused by the CHECK", async () => {
    const id = await submitted(freshCandidate());
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.tenant_applications SET "status" = 'REJECTED', "reviewedAt" = now() WHERE "id" = $1`, [id]), {
        constraint: "tenant_application_decision_coherent",
        code: "23514",
      });
    });
  });

  it("the queue is platform-scoped; approving is SUPER_ADMIN only", async () => {
    const id = await submitted(freshCandidate());
    const ownerToken = await accessTokenFor(app, tenantOwner);
    expect((await app.inject({ method: "GET", url: "/v1/tenant-applications", headers: bearer(ownerToken) })).statusCode).toBe(403);
    const queue = await app.inject({ method: "GET", url: "/v1/tenant-applications?status=PENDING_APPROVAL", headers: bearer(staff.officer.token) });
    expect(queue.statusCode).toBe(200);
    expect(queue.json<{ data: Array<{ id: string; status: string }> }>().data.every((row) => row.status === "PENDING_APPROVAL")).toBe(true);
    expect((await approve(id, staff.officer.token)).statusCode).toBe(403);
  });
});
