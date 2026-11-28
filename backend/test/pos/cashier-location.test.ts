// ===========================================================================
// CASHIER LOCATION ASSIGNMENT (M4.5 Wave 3, tenant migration 0035) — the enforcement, attacked.
//
// A cashier opens a shift and rings a sale ONLY at their assigned location: proven over the API
// (not a hidden selector), proven to take effect the moment they are reassigned, and proven in
// the database — a sale written straight through the service, past the route, is refused by
// `sale_assigned_location_guard`, and a shift row cannot be bound or rebound by raw SQL. Owners
// and managers stay unrestricted. Plus the stock-request round trip a cashier drives from the till.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import type { UserRole } from "../../src/generated/platform/client";
import { buildServer } from "../../src/server";
import { recordStockMovement, transferStock } from "../../src/services/inventory";
import { recordSale } from "../../src/services/sales";
import { openShift } from "../../src/services/shifts";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, tenantDb, tenantIdOf, withTenantTx } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { actorId, assignCashier, uniq } from "../support/fixtures";

const T = "qa-cashier-loc";
const OTHER = "qa-cashier-loc-b";

let app: FastifyInstance;
const users: StaffUser[] = [];
let manager: SignedIn;
let owner: SignedIn;
let otherOwner: SignedIn;
let mainId = "";
let tillA = "";
let tillB = "";
let shop = "";
let serviceId = "";
let goodId = "";

function send(method: "GET" | "POST" | "PUT" | "DELETE", url: string, who: SignedIn, payload?: unknown) {
  return app.inject({ method, url, remoteAddress: freshIp(), headers: bearer(who.token), ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}

async function staff(role: UserRole, subdomain = T): Promise<SignedIn> {
  const user = await createStaffUser(role, await tenantIdOf(subdomain));
  users.push(user);
  return signIn(app, user);
}

const sale = (shiftId: string, extra: Record<string, unknown> = {}) => ({
  shiftId,
  lines: [{ productId: serviceId, quantity: "1" }],
  tenders: [{ tenderType: "CASH", amount: "100.00" }],
  ...extra,
});

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const sub of [T, OTHER]) {
    await dropTenant(sub);
    await provisionFixture(sub, sub === T ? "QA Cashier Location" : "QA Cashier Location B");
  }
  const db = tenantDb(T);
  mainId = (await db.location.findFirstOrThrow({ where: { isDefault: true } })).id;
  tillA = (await db.location.create({ data: { code: uniq("TA"), name: "Till A", type: "POS" } })).id;
  tillB = (await db.location.create({ data: { code: uniq("TB"), name: "Till B", type: "POS" } })).id;
  shop = (await db.location.create({ data: { code: uniq("WEB"), name: "Web shop", type: "ECOMMERCE" } })).id;
  serviceId = (await db.product.create({ data: { sku: uniq("SVC"), name: "Key cutting", costPrice: 0n, price: 10000n, kind: "SERVICE" } })).id;
  goodId = (await db.product.create({ data: { sku: uniq("NAIL"), name: "Nails", costPrice: 1000n, price: 2000n, minStockThreshold: "5" } })).id;
  await recordStockMovement(db, { productId: goodId, movementType: "OPENING_BALANCE", quantity: "20", unitCost: 1000n, createdBy: actorId() });
  await transferStock(db, { productId: goodId, fromLocationId: mainId, toLocationId: tillA, quantity: "3", createdBy: actorId() });
  manager = await staff("MSME_MANAGER");
  owner = await staff("MSME_OWNER");
  otherOwner = await staff("MSME_OWNER", OTHER);
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  for (const sub of [T, OTHER]) await dropTenant(sub);
  await app.close();
});

describe("a cashier sells only from their assigned location — over the API", () => {
  it("an unassigned cashier can open no shift and quote nothing", async () => {
    const cashier = await staff("CASHIER");
    const opened = await send("POST", "/v1/pos/shifts/open", cashier, { openingFloat: "0.00" });
    expect(opened.statusCode).toBe(403);
    expect(opened.json<{ message: string }>().message).toMatch(/not been assigned a selling location/);
    expect((await send("POST", "/v1/pos/sales/quote", cashier, { lines: [{ productId: serviceId, quantity: "1" }] })).statusCode).toBe(403);
  });

  it("opens the shift AT the assignment, sells from it by default, and is refused anywhere else", async () => {
    const cashier = await staff("CASHIER");
    const put = await send("PUT", `/v1/pos/cashier-assignments/${cashier.user.id}`, manager, { locationId: tillA });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ location: { id: string } }>().location.id).toBe(tillA);

    // Naming another till at shift open is refused — the selector is not the guard.
    expect((await send("POST", "/v1/pos/shifts/open", cashier, { openingFloat: "0.00", locationId: tillB })).statusCode).toBe(403);
    const opened = await send("POST", "/v1/pos/shifts/open", cashier, { openingFloat: "0.00" });
    expect(opened.statusCode).toBe(201);
    const shift = opened.json<{ id: string; locationId: string; cashierAssigned: boolean }>();
    expect([shift.locationId, shift.cashierAssigned]).toEqual([tillA, true]);

    const elsewhere = await send("POST", "/v1/pos/sales", cashier, sale(shift.id, { sellingLocationId: tillB }));
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json<{ message: string }>().message).toMatch(/only from your assigned location, Till A/);
    expect((await send("POST", "/v1/pos/sales", cashier, sale(shift.id, { sellingLocationId: mainId }))).statusCode).toBe(403);
    expect((await send("POST", "/v1/pos/sales/quote", cashier, { sellingLocationId: tillB, lines: [{ productId: serviceId, quantity: "1" }] })).statusCode).toBe(403);

    // Omitted means the assignment — never a silent MAIN.
    const sold = await send("POST", "/v1/pos/sales", cashier, sale(shift.id));
    expect(sold.statusCode).toBe(201);
    expect(sold.json<{ sellingLocationId: string }>().sellingLocationId).toBe(tillA);
    const quoted = await send("POST", "/v1/pos/sales/quote", cashier, { lines: [{ productId: serviceId, quantity: "1" }] });
    expect(quoted.json<{ sellingLocationId: string }>().sellingLocationId).toBe(tillA);
  });

  it("a reassignment takes effect immediately: the old shift rings nothing more, a new one opens at the new till", async () => {
    const cashier = await staff("CASHIER");
    await send("PUT", `/v1/pos/cashier-assignments/${cashier.user.id}`, manager, { locationId: tillA });
    const first = (await send("POST", "/v1/pos/shifts/open", cashier, { openingFloat: "0.00" })).json<{ id: string }>();
    expect((await send("POST", "/v1/pos/sales", cashier, sale(first.id))).statusCode).toBe(201);

    expect((await send("PUT", `/v1/pos/cashier-assignments/${cashier.user.id}`, owner, { locationId: tillB })).statusCode).toBe(200);
    const stale = await send("POST", "/v1/pos/sales", cashier, sale(first.id));
    expect(stale.statusCode).toBe(403);
    expect(stale.json<{ message: string }>().message).toMatch(/moved to Till B\. Close this shift/);
    expect((await send("POST", "/v1/pos/sales", cashier, sale(first.id, { sellingLocationId: tillA }))).statusCode).toBe(403);

    expect((await send("POST", `/v1/pos/shifts/${first.id}/close`, cashier, { closingFloat: "100.00" })).statusCode).toBe(200);
    const second = (await send("POST", "/v1/pos/shifts/open", cashier, { openingFloat: "0.00" })).json<{ id: string; locationId: string }>();
    expect(second.locationId).toBe(tillB);
    const sold = await send("POST", "/v1/pos/sales", cashier, sale(second.id));
    expect(sold.json<{ sellingLocationId: string }>().sellingLocationId).toBe(tillB);

    // Removing the assignment stops the next shift too.
    expect((await send("DELETE", `/v1/pos/cashier-assignments/${cashier.user.id}`, manager)).statusCode).toBe(204);
    expect((await send("POST", "/v1/pos/sales", cashier, sale(second.id))).statusCode).toBe(403);
  });

  it("owners and managers are not restricted: any location, at shift open and at sale", async () => {
    const opened = await send("POST", "/v1/pos/shifts/open", manager, { openingFloat: "0.00" });
    const shift = opened.json<{ id: string; locationId: string; cashierAssigned: boolean }>();
    expect([shift.locationId, shift.cashierAssigned]).toEqual([mainId, false]);
    const sold = await send("POST", "/v1/pos/sales", manager, sale(shift.id, { sellingLocationId: tillB }));
    expect(sold.statusCode).toBe(201);
    const atA = await send("POST", "/v1/pos/shifts/open", owner, { openingFloat: "0.00", locationId: tillA });
    expect(atA.json<{ locationId: string }>().locationId).toBe(tillA);
  });
});

describe("managing assignments", () => {
  it("is OWNER / MANAGER only, refuses a storefront, and never reaches another business's user", async () => {
    const cashier = await staff("CASHIER");
    const warehouse = await staff("WAREHOUSE_STAFF");
    expect((await send("PUT", `/v1/pos/cashier-assignments/${cashier.user.id}`, cashier, { locationId: tillA })).statusCode).toBe(403);
    expect((await send("GET", "/v1/pos/cashier-assignments", cashier)).statusCode).toBe(403);
    expect((await send("PUT", `/v1/pos/cashier-assignments/${cashier.user.id}`, manager, { locationId: shop })).statusCode).toBe(400);
    // A non-cashier is not assignable.
    expect((await send("PUT", `/v1/pos/cashier-assignments/${warehouse.user.id}`, manager, { locationId: tillA })).statusCode).toBe(404);
    // Another business's owner cannot assign this business's cashier, and sees none of them.
    expect((await send("PUT", `/v1/pos/cashier-assignments/${cashier.user.id}`, otherOwner, { locationId: tillA })).statusCode).toBe(404);
    const theirs = await send("GET", "/v1/pos/cashier-assignments", otherOwner);
    expect(theirs.json<{ data: Array<{ userId: string }> }>().data.some((row) => row.userId === cashier.user.id)).toBe(false);
    const ours = await send("GET", "/v1/pos/cashier-assignments", manager);
    expect(ours.json<{ data: Array<{ userId: string; location: unknown }> }>().data.find((row) => row.userId === cashier.user.id)?.location).toBeNull();
  });
});

describe("the database is the guarantee", () => {
  it("refuses a sale rung past the route from anywhere but the assigned location — and accepts it there", async () => {
    const db = tenantDb(T);
    const cashierId = actorId();
    await assignCashier(db, cashierId, tillA);
    const shift = await openShift(db, cashierId, 0n, { locationId: tillA, cashierAssigned: true });
    const lines = [{ productId: serviceId, quantity: "1" }];
    const tenders = [{ tenderType: "CASH" as const, amount: "100.00" }];
    await expect(recordSale(db, { shiftId: shift.id, createdBy: cashierId, sellingLocationId: tillB, lines, tenders })).rejects.toThrow(/sale_assigned_location_guard/);
    // The control: the same write from the assigned till is accepted.
    const ok = await recordSale(db, { shiftId: shift.id, createdBy: cashierId, sellingLocationId: tillA, lines, tenders });
    expect(ok.sellingLocationId).toBe(tillA);
    // Reassigned: the database refuses even the old till at once.
    await assignCashier(db, cashierId, tillB);
    await expect(recordSale(db, { shiftId: shift.id, createdBy: cashierId, sellingLocationId: tillA, lines, tenders })).rejects.toThrow(/sale_assigned_location_guard/);
  });

  it("a shift is bound to the assignment when it opens, and its location can never be rewritten", async () => {
    const cashierId = actorId();
    await assignCashier(tenantDb(T), cashierId, tillA);
    await withTenantTx(T, async (client, schema) => {
      await expectDbRefusal(
        client.query(`INSERT INTO "${schema}".shifts ("id", "cashierId", "openingFloat", "locationId", "cashierAssigned") VALUES (gen_random_uuid()::text, $1, 0, $2, true)`, [cashierId, tillB]),
        { fn: "shift_location_guard" },
      );
    });
    await withTenantTx(T, async (client, schema) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "${schema}".shifts ("id", "cashierId", "openingFloat", "locationId", "cashierAssigned") VALUES (gen_random_uuid()::text, $1, 0, $2, true) RETURNING "id"`,
        [cashierId, tillA],
      );
      await expectDbRefusal(client.query(`UPDATE "${schema}".shifts SET "locationId" = $1 WHERE "id" = $2`, [tillB, rows[0]?.id]), { fn: "shift_location_guard" });
    });
    await withTenantTx(T, async (client, schema) => {
      await expectDbRefusal(
        // No location at all: the BEFORE trigger refuses it first (the shift_assigned_has_location
        // CHECK backs the same rule for the resting row).
        client.query(`INSERT INTO "${schema}".shifts ("id", "cashierId", "openingFloat", "cashierAssigned") VALUES (gen_random_uuid()::text, $1, 0, true)`, [cashierId]),
        { fn: "shift_location_guard" },
      );
    });
  });

  it("an assignment names an active, non-storefront location", async () => {
    await withTenantTx(T, async (client, schema) => {
      await expectDbRefusal(
        client.query(`INSERT INTO "${schema}".cashier_location_assignments ("userId", "locationId", "assignedBy") VALUES ($1, $2, $3)`, [actorId(), shop, actorId()]),
        { fn: "cashier_assignment_location_guard" },
      );
    });
  });
});

interface AllocationRequest {
  id: string;
  status: string;
  approvedQty: string | null;
  locationId: string;
}

describe("the till's stock request round trip", () => {
  it("a cashier sees their own till's low stock and requests only for it; a manager edits, declines, and cannot re-decide", async () => {
    const cashier = await staff("CASHIER");
    await send("PUT", `/v1/pos/cashier-assignments/${cashier.user.id}`, manager, { locationId: tillA });

    const mine = await send("GET", "/v1/pos/my-location", cashier);
    const view = mine.json<{ restricted: boolean; location: { id: string }; lowStock: Array<{ productId: string; locationId: string }> }>();
    expect([view.restricted, view.location.id]).toEqual([true, tillA]);
    expect(view.lowStock.some((row) => row.productId === goodId)).toBe(true);
    expect(view.lowStock.every((row) => row.locationId === tillA)).toBe(true);
    // The admin feed stays the managers'.
    expect((await send("GET", "/v1/allocations/low-stock", cashier)).statusCode).toBe(403);

    expect((await send("POST", "/v1/allocations/requests", cashier, { productId: goodId, locationId: tillB, requestedQty: "5" })).statusCode).toBe(403);
    const asked = await send("POST", "/v1/allocations/requests", cashier, { productId: goodId, locationId: tillA, requestedQty: "5" });
    expect(asked.statusCode).toBe(201);
    const request = asked.json<AllocationRequest>();
    expect(request.status).toBe("PENDING");
    const listed = (await send("GET", "/v1/pos/my-location", cashier)).json<{ myRequests: Array<{ id: string }> }>();
    expect(listed.myRequests.map((r) => r.id)).toContain(request.id);

    // More than MAIN owns: refused, and the request STAYS pending.
    const tooMuch = await send("POST", `/v1/allocations/requests/${request.id}/decide`, manager, { decision: "APPROVED", approvedQty: "500" });
    expect(tooMuch.statusCode).toBe(400);
    expect((await send("GET", `/v1/allocations/requests/${request.id}`, manager)).json<AllocationRequest>().status).toBe("PENDING");

    const approved = await send("POST", `/v1/allocations/requests/${request.id}/decide`, manager, { decision: "APPROVED", approvedQty: "4" });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<AllocationRequest>()).toMatchObject({ status: "APPROVED", approvedQty: "4.000" });
    const again = await send("POST", `/v1/allocations/requests/${request.id}/decide`, manager, { decision: "DECLINED" });
    expect(again.statusCode).toBe(409);

    const second = (await send("POST", "/v1/allocations/requests", cashier, { productId: goodId, locationId: tillA, requestedQty: "2" })).json<AllocationRequest>();
    const declined = await send("POST", `/v1/allocations/requests/${second.id}/decide`, owner, { decision: "DECLINED" });
    expect(declined.json<AllocationRequest>().status).toBe("DECLINED");
    // A cashier cannot decide anything.
    const third = (await send("POST", "/v1/allocations/requests", cashier, { productId: goodId, locationId: tillA, requestedQty: "1" })).json<AllocationRequest>();
    expect((await send("POST", `/v1/allocations/requests/${third.id}/decide`, cashier, { decision: "APPROVED" })).statusCode).toBe(403);
  });
});
