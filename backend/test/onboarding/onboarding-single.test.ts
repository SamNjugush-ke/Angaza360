// ===========================================================================
// SINGLE ADMIN ONBOARDING (Task T-A6.1).
//
// * generateUniqueSubdomain: a collision gets -2, -3, …; a reserved word is never used.
// * THE GREEN-GATE: a duplicate business name (case-insensitive), KRA PIN or owner
//   National ID is refused — by the service AND by the unique index from raw SQL.
// * A non-GREEN candidate provisions nothing and invites no one.
// * A GREEN one is provisioned through provisionTenant() (every tenant migration), its
//   tax regime lands on the registry AND its BusinessProfile, and its first MSME_OWNER is
//   invited (National ID carried to the user on accept). Audited.
// * Onboarding is SUPER_ADMIN only; a PROGRAM_OFFICER may preview; a tenant user may not.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { platformDb } from "../../src/db/platform";
import { getTenantDb } from "../../src/db/tenant";
import { buildServer } from "../../src/server";
import { simulatedOutbox } from "../../src/services/notifications/simulated-provider";
import { generateUniqueSubdomain, slugifySubdomain } from "../../src/services/tenants/subdomain";
import { EXPECTED_TENANT_MIGRATIONS } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";
import { bearer } from "../identity/staff-fixture";
import { cleanUp, freshCandidate, platformStaff, type Candidate, type PlatformStaff } from "./onboarding-fixture";

let app: FastifyInstance;
let staff: PlatformStaff;
let tenantOwner: TestUser;
const provisioned: string[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  staff = await platformStaff(app);
  tenantOwner = await createFixtureUser("MSME_OWNER");
});

afterAll(async () => {
  await deleteUsers([tenantOwner]);
  await cleanUp(provisioned, staff.users);
  await app.close();
});

function validate(candidate: Candidate, token: string = staff.officer.token) {
  return app.inject({ method: "POST", url: "/v1/tenants/onboard/validate", headers: bearer(token), payload: candidate });
}

function onboard(candidate: Candidate, token: string = staff.superAdmin.token) {
  return app.inject({ method: "POST", url: "/v1/tenants/onboard", remoteAddress: freshIp(), headers: bearer(token), payload: candidate });
}

async function onboardOk(candidate: Candidate): Promise<{ tenantId: string; subdomain: string; invitationId: string }> {
  const response = await onboard(candidate);
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json<{ tenant: { id: string; subdomain: string }; ownerInvitation: { invitation: { id: string } } }>();
  provisioned.push(body.tenant.subdomain);
  return { tenantId: body.tenant.id, subdomain: body.tenant.subdomain, invitationId: body.ownerInvitation.invitation.id };
}

async function counts(): Promise<{ tenants: number; invitations: number }> {
  return { tenants: await platformDb.tenant.count(), invitations: await platformDb.userInvitation.count() };
}

describe("subdomains", () => {
  it("slugify: lowercase, hyphenated, ascii; short names are padded", () => {
    expect(slugifySubdomain("  Mama Njeri's Café & Grill  ")).toBe("mama-njeri-s-cafe-and-grill");
    expect(slugifySubdomain("AB")).toBe("ab-biz");
    expect(slugifySubdomain("!!!")).toBe("business");
  });

  it("a collision gets a numeric suffix, and a reserved word is never used", async () => {
    expect(await generateUniqueSubdomain("QA Fixture")).toBe("qa-fixture-2");
    expect(await generateUniqueSubdomain("Admin")).toBe("admin-2");
    expect(await generateUniqueSubdomain("Shop", { alsoTaken: new Set(["shop", "shop-2"]) })).toBe("shop-3");
  });
});

describe("the green-gate", () => {
  it("a fresh candidate is GREEN with a proposed subdomain, and the preview writes nothing", async () => {
    const before = await counts();
    const response = await validate(freshCandidate());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "GREEN", errors: [] });
    expect(response.json<{ proposedSubdomain: string }>().proposedSubdomain).toMatch(/^qa-onboarded-/);
    expect(await counts()).toEqual(before);
  });

  it("formats are checked: KRA PIN, National ID, email, regime", async () => {
    const response = await validate(freshCandidate({ kraPin: "12345", ownerNationalId: "ID-1", ownerEmail: "nope", taxRegime: "VAT" }));
    const fields = response.json<{ status: string; errors: Array<{ field: string; code: string }> }>();
    expect(fields.status).toBe("RED");
    expect(fields.errors.map((e) => `${e.field}:${e.code}`).sort()).toEqual(
      ["kraPin:FORMAT", "ownerEmail:FORMAT", "ownerNationalId:FORMAT", "taxRegime:FORMAT"].sort(),
    );
  });

  it("a duplicate business name (any case) is refused — by the service AND the unique index", async () => {
    const response = await validate(freshCandidate({ businessName: "qa FIXTURE business" }));
    expect(response.json()).toMatchObject({ status: "RED", errors: [{ field: "businessName", code: "DUPLICATE" }] });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(
          `INSERT INTO public.tenants ("id", "name", "subdomain", "dbSchema", "updatedAt") VALUES ($1, 'qa fixture BUSINESS', $2, $3, now())`,
          [randomUUID(), `qa-dup-${randomUUID().slice(0, 6)}`, `tenant_qa_dup_${randomUUID().slice(0, 6)}`],
        ),
        { constraint: "tenants_name_lower_key", code: "23505" },
      );
    });
  });

  it("a duplicate KRA PIN and a duplicate owner National ID are refused — service AND index", async () => {
    const first = freshCandidate();
    const { tenantId } = await onboardOk(first);

    const again = await validate(freshCandidate({ kraPin: first.kraPin ?? null, ownerNationalId: first.ownerNationalId ?? null }));
    const errors = again.json<{ errors: Array<{ field: string; code: string }> }>().errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "kraPin", code: "DUPLICATE" }),
        expect.objectContaining({ field: "ownerNationalId", code: "DUPLICATE" }),
      ]),
    );

    await withPlatformTx(async (client) => {
      await expectDbRefusal(
        client.query(`UPDATE public.tenants SET "kraPin" = $1 WHERE "id" <> $2 AND "subdomain" = 'qa-fixture'`, [first.kraPin, tenantId]),
        { constraint: "tenants_kraPin_key", code: "23505" },
      );
    });
    const nationalId = first.ownerNationalId ?? "";
    await withPlatformTx(async (client) => {
      await client.query(`UPDATE public.users SET "nationalId" = $1 WHERE "id" = $2`, [nationalId, staff.users[0]?.id]);
      await expectDbRefusal(client.query(`UPDATE public.users SET "nationalId" = $1 WHERE "id" = $2`, [nationalId, staff.users[1]?.id]), {
        constraint: "users_nationalId_key",
        code: "23505",
      });
    });
  });

  it("a non-GREEN candidate provisions NOTHING and invites NO ONE", async () => {
    const before = await counts();
    const outboxBefore = simulatedOutbox().length;
    const response = await onboard(freshCandidate({ businessName: "QA Fixture Business" }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400, error: "BadRequest" });
    expect(response.json<{ message: string }>().message).toMatch(/businessName: That business name is already registered/);
    expect(await counts()).toEqual(before);
    expect(simulatedOutbox().length).toBe(outboxBefore);
  });
});

describe("a GREEN onboarding", () => {
  it("provisions the tenant, records the regime on registry AND BusinessProfile, invites the owner, and audits", async () => {
    const candidate = freshCandidate({ taxRegime: "VAT_REGISTERED" });
    const { tenantId, subdomain, invitationId } = await onboardOk(candidate);

    const tenant = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant).toMatchObject({ status: "ACTIVE", name: candidate.businessName, kraPin: candidate.kraPin, taxRegime: "VAT", subscriptionTier: "UKUAJI" });
    const applied = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tenant.dbSchema}"."_tenant_migrations"`);
    expect(applied.rows[0]?.n).toBe(EXPECTED_TENANT_MIGRATIONS);
    const profile = await getTenantDb(tenant.dbSchema).businessProfile.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(profile).toMatchObject({ taxRegime: "VAT_REGISTERED", isVatRegistered: true });

    const invitation = await platformDb.userInvitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(invitation).toMatchObject({ email: candidate.ownerEmail, role: "MSME_OWNER", tenantId, status: "PENDING", nationalId: candidate.ownerNationalId });

    // The owner accepts; their National ID lands on their user.
    const message = [...simulatedOutbox()].reverse().find((m) => m.to === candidate.ownerEmail);
    const token = message === undefined ? "" : (/\n\n([A-Za-z0-9_-]{20,})\n\n/.exec(message.body)?.[1] ?? "");
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/users/invitations/${token}/accept`,
      remoteAddress: freshIp(),
      payload: { fullName: candidate.ownerFullName, password: `Owner-${randomUUID()}` },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const owner = await platformDb.user.findUniqueOrThrow({ where: { email: candidate.ownerEmail } });
    expect(owner).toMatchObject({ role: "MSME_OWNER", tenantId, nationalId: candidate.ownerNationalId });

    const audit = await platformDb.auditLog.findFirstOrThrow({ where: { action: "TENANT_ONBOARDED", tenantId } });
    expect(audit).toMatchObject({ actorUserId: staff.superAdmin.user.id, metadata: { subdomain, source: "ADMIN", invitationId } });
  });

  it("a supplied subdomain is used as given", async () => {
    const subdomain = `qa-given-${randomUUID().slice(0, 6)}`;
    const { subdomain: used } = await onboardOk(freshCandidate({ subdomain }));
    expect(used).toBe(subdomain);
  });
});

describe("who may onboard", () => {
  it("a PROGRAM_OFFICER may preview but not provision; a tenant user may do neither", async () => {
    expect((await validate(freshCandidate(), staff.officer.token)).statusCode).toBe(200);
    expect((await onboard(freshCandidate(), staff.officer.token)).statusCode).toBe(403);
    const ownerToken = await accessTokenFor(app, tenantOwner);
    expect((await validate(freshCandidate(), ownerToken)).statusCode).toBe(403);
    expect((await onboard(freshCandidate(), ownerToken)).statusCode).toBe(403);
  });
});
