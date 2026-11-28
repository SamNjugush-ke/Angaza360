// ===========================================================================
// THE POS SALES LIST IS NEWEST-BY-BUSINESS-TIME FIRST (Task T-B-SALES-ORDER).
//
// Ordered by COALESCE(businessTimestamp, createdAt) DESC, then saleNumber DESC, then id:
// * offline captures synced in ONE batch (sharing ~one createdAt) come back in the order they
//   HAPPENED, not the order they arrived;
// * an online sale (no businessTimestamp) sorts by its createdAt, interleaved correctly;
// * a tie on business time falls to saleNumber, so the order is total and LIMIT/OFFSET pages are
//   stable and never overlap.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { businessDateOf } from "../../src/lib/business-time";
import { buildServer } from "../../src/server";
import { createLocation } from "../../src/services/locations";
import { registerDevice, startLease } from "../../src/services/offline/custody";
import { ingestSyncBatch, type CapturedSaleInput } from "../../src/services/offline/sync";
import { listSales, recordSale } from "../../src/services/sales";
import { openShift } from "../../src/services/shifts";
import { dropTenant, provisionFixture, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, uniq } from "../support/fixtures";
import { accessTokenFor, freshIp } from "../security/http-app";
import { createStaffUser, type StaffUser } from "../identity/staff-fixture";

const TENANT = "qa-sales-order";
const DAY_MS = 86_400_000;

let app: FastifyInstance;
let owner: StaffUser;
let t0 = 0;
/** saleNumber by label, so assertions read in the scenario's own words. */
const numberOf = new Map<string, string>();

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await dropTenant(TENANT);
  await provisionFixture(TENANT, "QA Sales Order");
  owner = await createStaffUser("MSME_OWNER", await tenantIdOf(TENANT));

  const db = tenantDb(TENANT);
  const service = await db.product.create({
    data: { sku: uniq("SVC"), name: uniq("Service"), costPrice: 0n, price: 10000n, kind: "SERVICE" },
  });
  const cashier = actorId();
  const shift = await openShift(db, cashier, 0n);
  const sell = { lines: [{ productId: service.id, quantity: "1" }], tenders: [{ tenderType: "CASH" as const, amount: "100.00" }] };

  // A: an ONLINE sale, recorded now (T0). No businessTimestamp: it sorts by createdAt.
  const a = await recordSale(db, { shiftId: shift.id, createdBy: cashier, ...sell });
  numberOf.set("A", a.saleNumber);
  t0 = a.createdAt.getTime();
  await new Promise((resolve) => setTimeout(resolve, 50));

  // B..E: captured offline, delivered in ONE batch AFTER A, so all share ~one createdAt.
  const till = await createLocation(db, { name: "Till", code: "TILL-O", type: "POS", isOfflineCapable: true, leaseWindowMinutes: null });
  const device = await registerDevice(db, { deviceName: "Order tablet", locationId: till.id, registeredBy: actorId() });
  await startLease(db, device.id);
  const capture = (key: string, at: number): CapturedSaleInput => ({
    idempotencyKey: `order-${key}`,
    businessTimestamp: new Date(at),
    shiftId: shift.id,
    reference: key,
    ...sell,
  });
  const result = await ingestSyncBatch(db, {
    deviceId: device.id,
    syncedBy: actorId(),
    sales: [
      capture("B", t0 - 2 * DAY_MS),
      capture("C", t0 - 1 * DAY_MS),
      capture("D", t0 + 10), // happened just after A, but arrived later
      capture("E", t0 - 2 * DAY_MS), // ties B on business time
    ],
  });
  expect(result.summary.posted).toBe(4);
  for (const row of await db.sale.findMany({ where: { reference: { in: ["B", "C", "D", "E"] } } })) {
    numberOf.set(row.reference ?? "", row.saleNumber);
  }
});

afterAll(async () => {
  await platformDb.user.delete({ where: { id: owner.id } });
  await dropTenant(TENANT);
  await app.close();
});

const labelOf = (saleNumber: string) => [...numberOf.entries()].find(([, n]) => n === saleNumber)?.[0] ?? saleNumber;

/** B and E tie on business time: the later saleNumber comes first. */
function tiedPair(): [string, string] {
  const b = numberOf.get("B") ?? "";
  const e = numberOf.get("E") ?? "";
  return b > e ? ["B", "E"] : ["E", "B"];
}

describe("GET /v1/pos/sales — business recency", () => {
  it("returns a synced batch in the order the sales HAPPENED, an online sale by its createdAt", async () => {
    const { data } = await listSales(tenantDb(TENANT), { take: 50, skip: 0 });
    expect(data.map((sale) => labelOf(sale.saleNumber))).toEqual(["D", "A", "C", ...tiedPair()]);
  });

  it("the synced captures really did share an arrival time (the old createdAt order was meaningless)", async () => {
    const rows = await tenantDb(TENANT).sale.findMany({ where: { reference: { in: ["B", "C", "D", "E"] } }, select: { createdAt: true } });
    const times = rows.map((row) => row.createdAt.getTime());
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(5_000);
  });

  it("pages are stable and never overlap under the new order", async () => {
    const db = tenantDb(TENANT);
    const full = (await listSales(db, { take: 50, skip: 0 })).data.map((s) => s.id);
    const pages: string[] = [];
    for (let skip = 0; skip < full.length; skip += 2) {
      const page = await listSales(db, { take: 2, skip });
      expect(page.pagination).toEqual({ take: 2, skip, total: full.length });
      pages.push(...page.data.map((s) => s.id));
    }
    expect(pages).toEqual(full);
    expect(new Set(pages).size).toBe(full.length);
    // Repeating a page returns the same rows in the same order.
    expect((await listSales(db, { take: 2, skip: 2 })).data.map((s) => s.id)).toEqual(full.slice(2, 4));
  });

  it("is what the route serves, with the response shape unchanged", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/pos/sales?take=3&skip=0",
      remoteAddress: freshIp(),
      headers: { authorization: `Bearer ${await accessTokenFor(app, owner)}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ data: Array<{ saleNumber: string; total: string }>; pagination: { total: number } }>();
    expect(body.data.map((sale) => labelOf(sale.saleNumber))).toEqual(["D", "A", "C"]);
    expect(body.pagination.total).toBe(5);
    expect(typeof body.data[0]?.total).toBe("string");
  });
});

describe("GET /v1/pos/sales — the date filter is the BUSINESS day (T-B-SALES-FILTER)", () => {
  const day = (ms: number) => businessDateOf(new Date(ms));

  it("finds a sale rung two days ago and synced today under its business day, not today", async () => {
    const old = day(t0 - 2 * DAY_MS);
    const { data, pagination } = await listSales(tenantDb(TENANT), { from: old, to: old, take: 50, skip: 0 });
    expect(data.map((sale) => labelOf(sale.saleNumber)).sort()).toEqual(["B", "E"]);
    expect(pagination.total).toBe(2);
  });

  it("finds only what happened today under today", async () => {
    const today = day(t0);
    const { data } = await listSales(tenantDb(TENANT), { from: today, to: today, take: 50, skip: 0 });
    expect(data.map((sale) => labelOf(sale.saleNumber))).toEqual(["D", "A"]);
  });

  it("includes the whole of the `to` day, and filters through the route as well", async () => {
    const from = day(t0 - 1 * DAY_MS);
    const to = day(t0);
    const { data } = await listSales(tenantDb(TENANT), { from, to, take: 50, skip: 0 });
    expect(data.map((sale) => labelOf(sale.saleNumber))).toEqual(["D", "A", "C"]);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const response = await app.inject({
      method: "GET",
      url: `/v1/pos/sales?from=${iso(from)}&to=${iso(to)}`,
      remoteAddress: freshIp(),
      headers: { authorization: `Bearer ${await accessTokenFor(app, owner)}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ data: Array<{ saleNumber: string }>; pagination: { total: number } }>();
    expect(body.data.map((sale) => labelOf(sale.saleNumber))).toEqual(["D", "A", "C"]);
    expect(body.pagination.total).toBe(3);
  });
});
