// ===========================================================================
// SUPER_ADMIN STANDING GOD-MODE — ACT-AS-TENANT (M4.5 W5), through the REAL app.
//
// The grant model is gone. A SUPER_ADMIN has standing access to every active business: by sending
// the act-as header they are presented to the EXISTING tenant routes as an owner of that business
// and may read AND write — with no grant, no prompt, no step-up, no expiry. Because the work goes
// through the ordinary services, the DB-enforced guards stay in force (an unbalanced posting is
// still rejected; a write lands only in the acted business's schema). Every action is recorded in
// BOTH the internal platform audit log (the operator named) and the owner-visible activity log
// (attributed to "Platform operator", never named). A non-SUPER_ADMIN cannot use the header to
// escalate, and ordinary tenant flows are unchanged.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { ACT_AS_TENANT_HEADER } from "../../src/plugins/auth";
import { buildServer } from "../../src/server";
import { accessTokenFor, freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, tenantDb, tenantIdOf } from "../setup/tenant";
import { bearer, createStaffUser, type StaffUser } from "./staff-fixture";

let app: FastifyInstance;
const users: StaffUser[] = [];
let fixtureId: string;
let secondId: string;
const SECOND = "godmode-second";

let adminToken: string;
let admin: StaffUser;
let ownerToken: string;
let cashierToken: string;

async function signedIn(role: StaffUser["role"], tenantId: string | null): Promise<{ user: StaffUser; token: string }> {
  const user = await createStaffUser(role, tenantId);
  users.push(user);
  return { user, token: await accessTokenFor(app, user) };
}

/** A request as this session, optionally ACTING AS a tenant (the god-mode header). */
function call(token: string, method: "GET" | "POST", url: string, opts: { actAs?: string; payload?: Record<string, unknown> } = {}) {
  return app.inject({
    method,
    url,
    remoteAddress: freshIp(),
    headers: { ...bearer(token), ...(opts.actAs !== undefined ? { [ACT_AS_TENANT_HEADER]: opts.actAs } : {}) },
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });
}

const newCustomer = (name: string) => ({ name });

/** The hook records the operator action AFTER the response; wait for the rows to land. */
async function operatorRows(tenantId: string): Promise<number> {
  return platformDb.auditLog.count({ where: { action: "OPERATOR_ACTED", tenantId } });
}
async function waitForOperatorRows(tenantId: string, atLeast: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if ((await operatorRows(tenantId)) >= atLeast) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${atLeast.toString()} operator rows on ${tenantId}`);
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await dropTenant(SECOND);
  await provisionFixture(SECOND, "Godmode Second Business");
  fixtureId = await tenantIdOf();
  secondId = await tenantIdOf(SECOND);
  const a = await signedIn("SUPER_ADMIN", null);
  adminToken = a.token;
  admin = a.user;
  ownerToken = (await signedIn("MSME_OWNER", fixtureId)).token;
  cashierToken = (await signedIn("CASHIER", fixtureId)).token;
});

afterAll(async () => {
  // OPERATOR_ACTED rows are append-only by design and are left in angaza_test (they block nothing).
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await dropTenant(SECOND);
  await app.close();
});

describe("standing access: no grant, no prompt", () => {
  it("a SUPER_ADMIN reaches NO business data without acting-as, and full read+write WITH it — no grant, no step-up", async () => {
    // Platform-scoped: a tenant route refuses the admin outright (unchanged).
    expect((await call(adminToken, "GET", "/v1/customers")).statusCode).toBe(403);

    // Acting as the fixture business: reads and writes, immediately, with nothing to request.
    expect((await call(adminToken, "GET", "/v1/customers", { actAs: fixtureId })).statusCode).toBe(200);
    const name = `GODMODE-${randomUUID().slice(0, 8)}`;
    const created = await call(adminToken, "POST", "/v1/customers", { actAs: fixtureId, payload: newCustomer(name) });
    expect(created.statusCode).toBe(201);
    const list = await call(adminToken, "GET", "/v1/customers", { actAs: fixtureId });
    expect(list.json<{ data: Array<{ name: string }> }>().data.some((c) => c.name === name)).toBe(true);
  });

  it("reaches ANY active business — a second tenant, with no grant", async () => {
    const name = `GODMODE2-${randomUUID().slice(0, 8)}`;
    expect((await call(adminToken, "POST", "/v1/customers", { actAs: secondId, payload: newCustomer(name) })).statusCode).toBe(201);
    expect((await tenantDb(SECOND).customer.findFirst({ where: { name } })) !== null).toBe(true);
  });

  it("a bad act-as target is a 404, not a way in", async () => {
    expect((await call(adminToken, "GET", "/v1/customers", { actAs: "no-such-tenant" })).statusCode).toBe(404);
  });
});

describe("integrity guards still bind a god-mode write", () => {
  it("an unbalanced posting is rejected, a balanced one posts, and nothing crosses schemas", async () => {
    const unbalanced = await call(adminToken, "POST", "/v1/ledger/entries", {
      actAs: fixtureId,
      payload: { entryDate: "2026-11-02", description: "god-mode unbalanced", source: "MANUAL", lines: [{ accountCode: "6000", debit: "100.00" }, { accountCode: "3000", credit: "50.00" }] },
    });
    expect(unbalanced.statusCode).toBe(400);
    const balanced = await call(adminToken, "POST", "/v1/ledger/entries", {
      actAs: fixtureId,
      payload: { entryDate: "2026-11-02", description: "god-mode balanced", source: "MANUAL", lines: [{ accountCode: "6000", debit: "100.00" }, { accountCode: "3000", credit: "100.00" }] },
    });
    expect(balanced.statusCode).toBe(201);

    // A write made while acting as the fixture business lands ONLY in its schema.
    const isolated = `ISO-${randomUUID().slice(0, 8)}`;
    expect((await call(adminToken, "POST", "/v1/customers", { actAs: fixtureId, payload: newCustomer(isolated) })).statusCode).toBe(201);
    expect(await tenantDb().customer.findFirst({ where: { name: isolated } })).not.toBeNull();
    expect(await tenantDb(SECOND).customer.findFirst({ where: { name: isolated } })).toBeNull();
  });
});

describe("dual attribution: internal names the operator, the owner sees only 'Platform operator'", () => {
  it("every god-mode action is in both logs, masked for the owner", async () => {
    const before = await operatorRows(fixtureId);
    await call(adminToken, "POST", "/v1/customers", { actAs: fixtureId, payload: newCustomer(`ATTR-${randomUUID().slice(0, 8)}`) });
    await waitForOperatorRows(fixtureId, before + 1);

    // Internal platform audit log (platform staff): the operator is NAMED.
    const internal = await call(adminToken, "GET", "/v1/users/audit?tenantId=" + fixtureId + "&limit=50");
    const internalRows = internal.json<{ data: Array<{ action: string; actorUserId: string | null; actorName: string | null }> }>().data.filter((r) => r.action === "OPERATOR_ACTED");
    expect(internalRows.length).toBeGreaterThan(0);
    expect(internalRows.every((r) => r.actorUserId === admin.id && r.actorName === `QA SUPER_ADMIN`)).toBe(true);

    // The owner's own identity audit view: the SAME events, but the operator is masked.
    const ownerAudit = await call(ownerToken, "GET", "/v1/users/audit?limit=50");
    const masked = ownerAudit.json<{ data: Array<{ action: string; actorUserId: string | null; actorName: string | null }> }>().data.filter((r) => r.action === "OPERATOR_ACTED");
    expect(masked.length).toBeGreaterThan(0);
    expect(masked.every((r) => r.actorUserId === null && r.actorName === "Platform operator")).toBe(true);
    expect(ownerAudit.body).not.toContain(admin.id);

    // The owner's transparency surface lists operator actions, attributed to the platform operator.
    const mine = await call(ownerToken, "GET", "/v1/support-access/my-business");
    expect(mine.statusCode).toBe(200);
    const activity = mine.json<{ data: Array<{ method: string; route: string; by: string }> }>().data;
    expect(activity.length).toBeGreaterThan(0);
    expect(activity.every((e) => e.by === "Platform operator")).toBe(true);
    expect(activity.some((e) => e.method === "POST" && e.route === "/v1/customers")).toBe(true);
    expect(mine.body).not.toContain(admin.id);
  });
});

describe("no approval / step-up / revoke path remains, and no escalation", () => {
  it("the grant endpoints are gone, and the owner cannot revoke", async () => {
    expect((await call(adminToken, "POST", "/v1/support-access/grants", { payload: { tenantId: fixtureId, scope: "VIEW", reason: "x".repeat(10) } })).statusCode).toBe(404);
    expect((await call(adminToken, "GET", "/v1/support-access/grants")).statusCode).toBe(404);
    expect((await call(ownerToken, "POST", `/v1/support-access/my-business/${randomUUID()}/revoke`, { payload: {} })).statusCode).toBe(404);
  });

  it("the act-as header does NOT escalate a non-SUPER_ADMIN: it is ignored", async () => {
    // A cashier naming another tenant stays in their OWN tenant; the header is inert.
    const name = `NOESC-${randomUUID().slice(0, 8)}`;
    // A cashier may create a customer in their own tenant; naming the second tenant must not redirect it.
    const res = await call(cashierToken, "POST", "/v1/customers", { actAs: secondId, payload: newCustomer(name) });
    expect(res.statusCode).toBe(201);
    expect(await tenantDb().customer.findFirst({ where: { name } })).not.toBeNull(); // own tenant
    expect(await tenantDb(SECOND).customer.findFirst({ where: { name } })).toBeNull(); // not the named one
    // And no operator row was written for the cashier's ordinary action.
    expect(await platformDb.auditLog.count({ where: { action: "OPERATOR_ACTED", actorUserId: (users.find((u) => u.role === "CASHIER") as StaffUser).id } })).toBe(0);
  });
});

describe("ordinary tenant flows are unchanged", () => {
  it("an owner's own write is NOT an operator action", async () => {
    const before = await operatorRows(fixtureId);
    const name = `OWNER-${randomUUID().slice(0, 8)}`;
    expect((await call(ownerToken, "POST", "/v1/customers", { payload: newCustomer(name) })).statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await operatorRows(fixtureId)).toBe(before);
  });
});
