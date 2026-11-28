// ===========================================================================
// STAFF ADMINISTRATION (Task T-A5), through the REAL app and from raw SQL.
//
// * TENANT ISOLATION: an owner lists, and acts on, their OWN business's users only —
//   another business's user is "not found" (404) and is left untouched.
// * A role change is audited (from / to) and ends the target's sessions; an owner
//   cannot escalate anyone to a platform role.
// * DEACTIVATION revokes every session and blocks login; reactivation restores it.
// * FAIL-CLOSED: the last active owner can be neither deactivated nor demoted — by the
//   service (409, LastActiveOwnerError) AND by `last_active_owner_guard` for a raw
//   write, each with a control.
// * The audit trail is readable by an owner for their own business only, and by a
//   SUPER_ADMIN across businesses.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { errorBody } from "../../src/schemas/common";
import { buildServer } from "../../src/server";
import { deactivateUser, LastActiveOwnerError } from "../../src/services/identity/user-management";
import { dropTenant, provisionFixture, tenantIdOf } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { withPlatformTx } from "../support/platform-tx";
import { freshIp } from "../security/http-app";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "./staff-fixture";

const TENANT_C = "qa-staff-c";
const LAST_OWNER = errorBody(
  409,
  "Conflict",
  "This is the last active owner of the business, who can be neither deactivated nor demoted. Add or reactivate another owner first.",
);

let app: FastifyInstance;
let tenantA = "";
let tenantC = "";
let ownerA: SignedIn;
let cashierA: StaffUser;
let ownerC: SignedIn;
let managerC: StaffUser;
let cashierC: StaffUser;
let superAdmin: SignedIn;
const outsideTenantC: StaffUser[] = [];

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  tenantA = await tenantIdOf();
  await dropTenant(TENANT_C);
  await provisionFixture(TENANT_C, "QA Staff C");
  tenantC = await tenantIdOf(TENANT_C);

  const owner = await createStaffUser("MSME_OWNER", tenantA);
  cashierA = await createStaffUser("CASHIER", tenantA);
  const admin = await createStaffUser("SUPER_ADMIN", null);
  outsideTenantC.push(owner, cashierA, admin);
  ownerA = await signIn(app, owner);
  superAdmin = await signIn(app, admin);

  // Tenant C has exactly ONE owner — the last-owner guard depends on it.
  ownerC = await signIn(app, await createStaffUser("MSME_OWNER", tenantC));
  managerC = await createStaffUser("MSME_MANAGER", tenantC);
  cashierC = await createStaffUser("CASHIER", tenantC);
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: outsideTenantC.map((user) => user.id) } } });
  await dropTenant(TENANT_C);
  await app.close();
});

function login(user: StaffUser) {
  return app.inject({ method: "POST", url: "/v1/auth/login", remoteAddress: freshIp(), payload: { email: user.email, password: user.password } });
}

function me(token: string) {
  return app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer(token) });
}

describe("tenant isolation", () => {
  it("an owner lists ONLY their own business's staff", async () => {
    const listA = await app.inject({ method: "GET", url: "/v1/users", headers: bearer(ownerA.token) });
    expect(listA.statusCode).toBe(200);
    const usersA = listA.json<{ data: Array<{ id: string; tenantId: string }> }>().data;
    expect(usersA.every((user) => user.tenantId === tenantA)).toBe(true);
    expect(usersA.map((user) => user.id)).toContain(cashierA.id);
    expect(usersA.map((user) => user.id)).not.toContain(cashierC.id);

    const listC = await app.inject({ method: "GET", url: "/v1/users", headers: bearer(ownerC.token) });
    expect(listC.json<{ data: Array<{ id: string }> }>().data.map((user) => user.id).sort()).toEqual(
      [ownerC.user.id, managerC.id, cashierC.id].sort(),
    );
  });

  it("an owner CANNOT modify another business's user — 404, and the user is untouched", async () => {
    const role = await app.inject({ method: "PATCH", url: `/v1/users/${cashierC.id}/role`, headers: bearer(ownerA.token), payload: { role: "ACCOUNTANT" } });
    expect(role.statusCode).toBe(404);
    const deactivate = await app.inject({ method: "POST", url: `/v1/users/${cashierC.id}/deactivate`, headers: bearer(ownerA.token) });
    expect(deactivate.statusCode).toBe(404);
    const row = await platformDb.user.findUniqueOrThrow({ where: { id: cashierC.id } });
    expect(row).toMatchObject({ role: "CASHIER", isActive: true });
  });

  it("a cashier cannot list staff, and a tenantless admin has no business to list", async () => {
    const cashier = await signIn(app, cashierA);
    expect((await app.inject({ method: "GET", url: "/v1/users", headers: bearer(cashier.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/users", headers: bearer(superAdmin.token) })).statusCode).toBe(403);
  });
});

describe("role changes", () => {
  it("a role change is applied, audited from/to, and ends the target's sessions", async () => {
    const managerSession = await signIn(app, managerC);
    expect((await me(managerSession.token)).statusCode).toBe(200);
    const response = await app.inject({ method: "PATCH", url: `/v1/users/${managerC.id}/role`, headers: bearer(ownerC.token), payload: { role: "ACCOUNTANT" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: managerC.id, role: "ACCOUNTANT" });
    expect((await me(managerSession.token)).statusCode).toBe(401);
    const audit = await platformDb.auditLog.findFirstOrThrow({ where: { action: "ROLE_CHANGED", targetUserId: managerC.id } });
    expect(audit).toMatchObject({
      actorUserId: ownerC.user.id,
      tenantId: tenantC,
      metadata: { fromRole: "MSME_MANAGER", toRole: "ACCOUNTANT" },
    });
  });

  it("an owner CANNOT escalate anyone to a platform role — 403, role unchanged", async () => {
    const response = await app.inject({ method: "PATCH", url: `/v1/users/${cashierC.id}/role`, headers: bearer(ownerC.token), payload: { role: "SUPER_ADMIN" } });
    expect(response.statusCode).toBe(403);
    expect((await platformDb.user.findUniqueOrThrow({ where: { id: cashierC.id } })).role).toBe("CASHIER");
  });

  it("a business's user cannot be moved into platform scope, even by a SUPER_ADMIN", async () => {
    const response = await app.inject({ method: "PATCH", url: `/v1/users/${cashierC.id}/role`, headers: bearer(superAdmin.token), payload: { role: "MENTOR" } });
    expect(response.statusCode).toBe(400);
    expect((await platformDb.user.findUniqueOrThrow({ where: { id: cashierC.id } })).role).toBe("CASHIER");
  });
});

describe("deactivation", () => {
  it("revokes every session and blocks login; reactivation restores login; both audited", async () => {
    const session = await signIn(app, cashierC);
    const deactivated = await app.inject({ method: "POST", url: `/v1/users/${cashierC.id}/deactivate`, headers: bearer(ownerC.token) });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ isActive: false });
    expect((await me(session.token)).statusCode).toBe(401);
    expect((await login(cashierC)).statusCode).toBe(401);
    expect(await platformDb.session.count({ where: { userId: cashierC.id, revokedAt: null } })).toBe(0);

    const reactivated = await app.inject({ method: "POST", url: `/v1/users/${cashierC.id}/reactivate`, headers: bearer(ownerC.token) });
    expect(reactivated.statusCode).toBe(200);
    expect((await login(cashierC)).statusCode).toBe(200);

    expect(await platformDb.auditLog.count({ where: { action: "USER_DEACTIVATED", targetUserId: cashierC.id } })).toBe(1);
    expect(await platformDb.auditLog.count({ where: { action: "USER_REACTIVATED", targetUserId: cashierC.id } })).toBe(1);
  });
});

describe("FAIL-CLOSED: the last active owner", () => {
  it("cannot be deactivated or demoted over HTTP — 409, and stays an active owner", async () => {
    const deactivate = await app.inject({ method: "POST", url: `/v1/users/${ownerC.user.id}/deactivate`, headers: bearer(ownerC.token) });
    expect(deactivate.statusCode).toBe(409);
    expect(deactivate.json()).toStrictEqual(LAST_OWNER);
    const demote = await app.inject({ method: "PATCH", url: `/v1/users/${ownerC.user.id}/role`, headers: bearer(superAdmin.token), payload: { role: "MSME_MANAGER" } });
    expect(demote.statusCode).toBe(409);
    expect(await platformDb.user.findUniqueOrThrow({ where: { id: ownerC.user.id } })).toMatchObject({ role: "MSME_OWNER", isActive: true });
  });

  it("the service refuses it: deactivateUser throws LastActiveOwnerError", async () => {
    const actor = { userId: superAdmin.user.id, role: "SUPER_ADMIN" as const, tenantId: null, ipAddress: null };
    await expect(deactivateUser(actor, ownerC.user.id)).rejects.toBeInstanceOf(LastActiveOwnerError);
    expect((await platformDb.user.findUniqueOrThrow({ where: { id: ownerC.user.id } })).isActive).toBe(true);
  });

  it("the database refuses a raw write that would leave no active owner", async () => {
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.users SET "isActive" = false WHERE "id" = $1`, [ownerC.user.id]), {
        fn: "last_active_owner_guard",
        message: /last active MSME_OWNER/,
      });
    });
    await withPlatformTx(async (client) => {
      await expectDbRefusal(client.query(`UPDATE public.users SET "role" = 'CASHIER' WHERE "id" = $1`, [ownerC.user.id]), {
        fn: "last_active_owner_guard",
      });
    });
  });

  it("control: with a SECOND active owner, either one may be deactivated", async () => {
    const coOwner = await createStaffUser("MSME_OWNER", tenantC);
    await withPlatformTx(async (client) => {
      await client.query(`UPDATE public.users SET "isActive" = false WHERE "id" = $1`, [ownerC.user.id]);
    });
    const response = await app.inject({ method: "POST", url: `/v1/users/${coOwner.id}/deactivate`, headers: bearer(ownerC.token) });
    expect(response.statusCode).toBe(200);
  });
});

describe("the audit trail", () => {
  it("an owner reads ONLY their own business's rows", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/users/audit?limit=200", headers: bearer(ownerC.token) });
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ data: Array<{ tenantId: string | null; action: string }> }>().data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenantId === tenantC)).toBe(true);
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(["ROLE_CHANGED", "USER_DEACTIVATED", "USER_REACTIVATED"]));

    const foreign = await app.inject({ method: "GET", url: `/v1/users/audit?tenantId=${tenantA}`, headers: bearer(ownerC.token) });
    expect(foreign.statusCode).toBe(403);
  });

  it("a SUPER_ADMIN reads across businesses, or narrows to one", async () => {
    const narrowed = await app.inject({ method: "GET", url: `/v1/users/audit?tenantId=${tenantC}&limit=200`, headers: bearer(superAdmin.token) });
    expect(narrowed.statusCode).toBe(200);
    const rows = narrowed.json<{ data: Array<{ tenantId: string | null }> }>().data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tenantId === tenantC)).toBe(true);
  });

  it("a cashier cannot read the audit trail", async () => {
    const cashier = await signIn(app, cashierA);
    expect((await app.inject({ method: "GET", url: "/v1/users/audit", headers: bearer(cashier.token) })).statusCode).toBe(403);
  });
});
