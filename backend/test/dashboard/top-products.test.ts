// ===========================================================================
// TOP-SELLING PRODUCTS RECONCILE TO THE INCOME STATEMENT (Task T-F-DASH-2).
//
// * THE BASIS IS THE STATEMENT'S: Σ products' revenue over a period equals
//   buildIncomeStatement's revenue for it (a tenant whose only revenue is POS sales). Lines
//   count when their sale is POSTED and are taken back when its VOID is posted — the
//   buildVatReturn pattern — so a cross-period void reduces the VOID's period.
// * Revenue is lineNet: ex-VAT and NET OF DISCOUNT. GOOD and SERVICE both rank. Ranking by
//   revenue or quantity, ties by name, limit respected; nothing-net products are omitted.
// * The month boundary is the business day's (Africa/Nairobi), as for the trend.
// * Isolated, role-gated and validated like every report.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { businessToday } from "../../src/lib/business-time";
import { buildServer } from "../../src/server";
import { buildIncomeStatement, buildTopProducts, resolvePeriod, type Period } from "../../src/services/reports";
import { recordSale, voidSale } from "../../src/services/sales";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, createSupplier, openTill, receiveStock, uniq } from "../support/fixtures";
import { accessTokenFor, freshIp } from "../security/http-app";
import { createStaffUser, type StaffUser } from "../identity/staff-fixture";

const TENANT_A = "qa-top-a";
const TENANT_B = "qa-top-b";

let app: FastifyInstance;
const users: StaffUser[] = [];
let ownerA = "";
let ownerB = "";

const today = businessToday();
const iso = (date: Date) => date.toISOString().slice(0, 10);
const prevIndex = today.getUTCFullYear() * 12 + today.getUTCMonth() - 1;
const prevYear = Math.floor(prevIndex / 12);
const prevMonth = (prevIndex % 12) + 1;
const prevLastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
const prevPeriod = resolvePeriod({ year: prevYear, month: prevMonth });
const currentPeriod = resolvePeriod({});

interface WireProduct {
  productId: string;
  sku: string;
  name: string;
  kind: "GOOD" | "SERVICE";
  quantity: string;
  revenue: string;
}

async function token(role: StaffUser["role"], subdomain: string): Promise<string> {
  const user = await createStaffUser(role, await tenantIdOf(subdomain));
  users.push(user);
  return accessTokenFor(app, user);
}

async function get(bearer: string | null, query = ""): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: "GET",
    url: `/v1/reports/top-products${query}`,
    remoteAddress: freshIp(), // the reports' SENSITIVE throttle counts per IP
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
  });
  return { status: response.statusCode, body: response.json<unknown>() };
}

async function top(bearer: string, query = ""): Promise<WireProduct[]> {
  const { status, body } = await get(bearer, query);
  expect(status, JSON.stringify(body)).toBe(200);
  return body as WireProduct[];
}

const names = (products: readonly WireProduct[]) => products.map((p) => p.name);
const sum = (products: readonly WireProduct[]) => products.reduce((total, p) => total + BigInt(p.revenue), 0n);

async function statementRevenue(period: Period): Promise<bigint> {
  const statement = await buildIncomeStatement({ reader: tenantDb(TENANT_A), schema: schemaOf(TENANT_A) }, period, false);
  return statement.revenue.total;
}

async function product(subdomain: string, name: string, price: bigint, kind: "GOOD" | "SERVICE"): Promise<string> {
  const row = await tenantDb(subdomain).product.create({
    data: { sku: uniq("TOP"), name, costPrice: kind === "GOOD" ? 40000n : 0n, price, kind },
  });
  return row.id;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const [sub, name] of [
    [TENANT_A, "QA Top A"],
    [TENANT_B, "QA Top B"],
  ] as const) {
    await dropTenant(sub);
    await provisionFixture(sub, name);
  }
  ownerA = await token("MSME_OWNER", TENANT_A);
  ownerB = await token("MSME_OWNER", TENANT_B);

  const db = tenantDb(TENANT_A);
  const alpha = await product(TENANT_A, "Alpha cement", 100000n, "GOOD"); // 1,000.00
  const bravo = await product(TENANT_A, "Bravo nails", 1000n, "GOOD"); // 10.00
  const charlie = await product(TENANT_A, "Charlie delivery", 30000n, "SERVICE"); // 300.00
  const delta = await product(TENANT_A, "Delta install", 30000n, "SERVICE"); // 300.00
  const echo = await product(TENANT_A, "Echo survey", 20000n, "SERVICE"); // 200.00
  const foxtrot = await product(TENANT_A, "Foxtrot repair", 30000n, "SERVICE"); // 300.00
  const golf = await product(TENANT_A, "Golf callout", 7000n, "SERVICE"); // 70.00
  const hotel = await product(TENANT_A, "Hotel visit", 3000n, "SERVICE"); // 30.00
  await receiveStock(db, await createSupplier(db), [
    { productId: alpha, quantity: "10", unitCost: 40000n },
    { productId: bravo, quantity: "100", unitCost: 400n },
  ]);
  const till = await openTill(db);
  const sell = (lines: Array<{ productId: string; quantity: string; discount?: string }>, total: string, entryDate?: Date) =>
    recordSale(db, {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines,
      tenders: [{ tenderType: "CASH", amount: total }],
      ...(entryDate !== undefined ? { entryDate } : {}),
    });

  // Previous month: Foxtrot ×3 (voided THIS month), and Hotel at 23:30 Nairobi on the last day.
  const foxtrotSale = await sell([{ productId: foxtrot, quantity: "3" }], "900.00", new Date(Date.UTC(prevYear, prevMonth - 1, 12, 9)));
  await sell([{ productId: hotel, quantity: "1" }], "30.00", new Date(Date.UTC(prevYear, prevMonth - 1, prevLastDay, 20, 30)));
  // 01:30 Nairobi on the 1st (22:30 UTC the day before): THIS month.
  await sell([{ productId: golf, quantity: "1" }], "70.00", new Date(Date.UTC(prevYear, prevMonth - 1, prevLastDay, 22, 30)));

  // This month.
  await sell([{ productId: alpha, quantity: "2", discount: "100.00" }], "1900.00"); // gross 2,000.00, net 1,900.00
  await sell([{ productId: bravo, quantity: "50" }], "500.00");
  await sell(
    [
      { productId: charlie, quantity: "1" },
      { productId: delta, quantity: "1" },
    ],
    "600.00",
  );
  const alphaVoided = await sell([{ productId: alpha, quantity: "1" }], "1000.00");
  await voidSale(db, alphaVoided.id, "T-F-DASH-2 same-period void", actorId());
  const echoVoided = await sell([{ productId: echo, quantity: "1" }], "200.00");
  await voidSale(db, echoVoided.id, "T-F-DASH-2 same-period void", actorId());
  await voidSale(db, foxtrotSale.id, "T-F-DASH-2 voided the next month", actorId());

  // Tenant B: one sale.
  const dbB = tenantDb(TENANT_B);
  const zulu = await product(TENANT_B, "Zulu service", 9900n, "SERVICE");
  const tillB = await openTill(dbB);
  await recordSale(dbB, {
    shiftId: tillB.shiftId,
    createdBy: tillB.cashierId,
    lines: [{ productId: zulu, quantity: "1" }],
    tenders: [{ tenderType: "CASH", amount: "99.00" }],
  });
});

afterAll(async () => {
  for (const user of users) await platformDb.user.delete({ where: { id: user.id } });
  await dropTenant(TENANT_A);
  await dropTenant(TENANT_B);
  await app.close();
});

describe("ranking", () => {
  it("ranks by net revenue by default, ties by name, limit 5 by default", async () => {
    const products = await top(ownerA);
    expect(names(products)).toEqual(["Alpha cement", "Bravo nails", "Charlie delivery", "Delta install", "Golf callout"]);
    expect(products.map((p) => p.revenue)).toEqual(["190000", "50000", "30000", "30000", "7000"]);
    expect(products.map((p) => p.quantity)).toEqual(["2.000", "50.000", "1.000", "1.000", "1.000"]);
  });

  it("ranks by net quantity, ties by revenue then name; respects the limit", async () => {
    expect(names(await top(ownerA, "?by=quantity&limit=50"))).toEqual([
      "Bravo nails",
      "Alpha cement",
      "Charlie delivery",
      "Delta install",
      "Golf callout",
    ]);
    expect(names(await top(ownerA, "?limit=2"))).toEqual(["Alpha cement", "Bravo nails"]);
    expect(names(await top(ownerA, "?by=quantity&limit=1"))).toEqual(["Bravo nails"]);
  });

  it("ranks GOOD and SERVICE together and says which is which", async () => {
    const products = await top(ownerA);
    expect(products.find((p) => p.name === "Alpha cement")?.kind).toBe("GOOD");
    expect(products.find((p) => p.name === "Charlie delivery")?.kind).toBe("SERVICE");
  });
});

describe("what counts", () => {
  it("revenue is lineNet: ex-VAT and net of the discount, not the gross", async () => {
    const alpha = (await top(ownerA)).find((p) => p.name === "Alpha cement");
    expect(alpha?.revenue).toBe("190000"); // 2 × 1,000.00 − 100.00; the voided third unit taken back
  });

  it("a same-period void removes the product; a cross-period void reduces the VOID's period only", async () => {
    const current = names(await top(ownerA, "?limit=50"));
    expect(current).not.toContain("Echo survey"); // sold and voided this month: nothing net
    expect(current).not.toContain("Foxtrot repair"); // −900.00 / −3 this month: omitted
    const previous = await top(ownerA, `?year=${prevYear.toString()}&month=${prevMonth.toString()}&limit=50`);
    expect(previous.find((p) => p.name === "Foxtrot repair")).toMatchObject({ revenue: "90000", quantity: "3.000" });
  });

  it("puts a sale at 23:30 Nairobi in the old month and one at 01:30 Nairobi on the 1st in the new one", async () => {
    const previous = names(await top(ownerA, `?year=${prevYear.toString()}&month=${prevMonth.toString()}&limit=50`));
    expect(previous).toContain("Hotel visit");
    expect(previous).not.toContain("Golf callout");
    const current = names(await top(ownerA, "?limit=50"));
    expect(current).toContain("Golf callout");
    expect(current).not.toContain("Hotel visit");
  });
});

describe("reconciliation to the income statement", () => {
  it("Σ products' revenue EQUALS the statement's revenue over a month with no net-negative product", async () => {
    const products = await buildTopProducts({ reader: tenantDb(TENANT_A), schema: schemaOf(TENANT_A) }, prevPeriod, { limit: 50, by: "revenue" });
    expect(products.reduce((total, p) => total + p.revenue, 0n)).toBe(await statementRevenue(prevPeriod));
    expect(await statementRevenue(prevPeriod)).toBe(93000n);
  });

  it("…and over a span covering both months, where the cross-period void nets to nothing", async () => {
    const span = `?from=${iso(prevPeriod.from)}&to=${iso(currentPeriod.to)}&limit=50`;
    const products = await top(ownerA, span);
    expect(sum(products)).toBe(await statementRevenue({ from: prevPeriod.from, to: currentPeriod.to }));
    expect(names(products)).not.toContain("Foxtrot repair");
  });

  it("…and this month: the listed products plus the one omitted net-negative product equal the statement", async () => {
    const listed = sum(await top(ownerA, "?limit=50"));
    const foxtrotThisMonth = -90000n; // its sale was last month; its void is this month
    expect(listed + foxtrotThisMonth).toBe(await statementRevenue(currentPeriod));
  });
});

describe("isolation, access and validation", () => {
  it("never shows another business's products", async () => {
    expect(names(await top(ownerB, "?limit=50"))).toEqual(["Zulu service"]);
    expect(names(await top(ownerA, "?limit=50"))).not.toContain("Zulu service");
  });

  it("admits the report readers and refuses everyone else", async () => {
    for (const role of ["ACCOUNTANT", "VIEWER_AUDITOR", "MSME_MANAGER"] as const) {
      expect((await get(await token(role, TENANT_A))).status).toBe(200);
    }
    for (const role of ["CASHIER", "HR_OFFICER", "WAREHOUSE_STAFF"] as const) {
      expect([role, (await get(await token(role, TENANT_A))).status]).toEqual([role, 403]);
    }
    expect((await get(null)).status).toBe(401);
  });

  it("refuses a bad limit, ranking or period with the one error shape", async () => {
    for (const query of ["?limit=0", "?limit=51", "?limit=x", "?by=foo", "?month=3", "?from=2026-01-01"]) {
      const { status, body } = await get(ownerA, query);
      expect([query, status]).toEqual([query, 400]);
      expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(["error", "message", "statusCode"]);
    }
  });
});
