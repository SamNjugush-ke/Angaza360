// ===========================================================================
// THE DASHBOARD TREND IS THE INCOME STATEMENT, MONTH BY MONTH (Task T-F-DASH-1).
//
// * REUSE, NOT A PARALLEL CALCULATION: every bucket EQUALS buildIncomeStatement for that
//   exact month, the month resolved INDEPENDENTLY of the trend (resolvePeriod), and the
//   revenue also equals an independent SQL sum over the month's journal lines.
// * BUSINESS MONTHS: labels are Africa/Nairobi months, the current month is month-to-date
//   (partial, to = businessToday()), and a sale at 01:30 Nairobi on the 1st (22:30 UTC the
//   day before) lands in the NEW month while 23:30 Nairobi stays in the old one.
// * NET MOVEMENTS: a void reduces the month it is posted in; a service line adds revenue and
//   no cost; months without activity are zeros, never missing.
// * ISOLATED and ROLE-GATED: two businesses' trends never bleed; CASHIER, HR and WAREHOUSE
//   are refused; months outside 2–24 are a 400.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { platformDb } from "../../src/db/platform";
import { businessToday } from "../../src/lib/business-time";
import { buildServer } from "../../src/server";
import { buildDashboardTrend, trendMonths } from "../../src/services/dashboard";
import { recordExpense } from "../../src/services/expenses";
import { buildIncomeStatement, resolvePeriod } from "../../src/services/reports";
import { recordSale, voidSale } from "../../src/services/sales";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, createProduct, createSupplier, openTill, receiveStock, uniq } from "../support/fixtures";
import { accessTokenFor } from "../security/http-app";
import { createStaffUser, type StaffUser } from "../identity/staff-fixture";

const TENANT_A = "qa-trend-a";
const TENANT_B = "qa-trend-b";

let app: FastifyInstance;
const users: StaffUser[] = [];
let ownerA = "";
let ownerB = "";

/** A bucket as it crosses the wire: money as strings of cents. */
interface WireBucket {
  month: string;
  from: string;
  to: string;
  partial: boolean;
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  operatingExpenses: string;
  netProfit: string;
}

/** xs[i], or a failed test — never a silent undefined. */
function nth<T>(xs: readonly T[], i: number): T {
  const value = xs[i];
  if (value === undefined) throw new Error(`no element ${i.toString()} (length ${xs.length.toString()})`);
  return value;
}

function bucketFor(buckets: readonly WireBucket[], month: string): WireBucket {
  const bucket = buckets.find((b) => b.month === month);
  if (bucket === undefined) throw new Error(`no bucket for ${month}`);
  return bucket;
}

const today = businessToday();
const thisYear = today.getUTCFullYear();
const thisMonth = today.getUTCMonth() + 1; // 1–12
/** The calendar month `back` months before today's, as [year, month]. */
function monthBack(back: number): [number, number] {
  const index = thisYear * 12 + (thisMonth - 1) - back;
  return [Math.floor(index / 12), (index % 12) + 1];
}
const label = ([year, month]: [number, number]) => `${year.toString()}-${String(month).padStart(2, "0")}`;
const [prevYear, prevMonth] = monthBack(1);
const [olderYear, olderMonth] = monthBack(2);
/** The last day of the previous month, as a day-of-month. */
const prevLastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();

async function token(role: StaffUser["role"], subdomain: string): Promise<string> {
  const user = await createStaffUser(role, await tenantIdOf(subdomain));
  users.push(user);
  return accessTokenFor(app, user);
}

/** A SERVICE product (its kind is fixed at creation — T-A8). */
async function createService(subdomain: string, price: bigint): Promise<string> {
  const product = await tenantDb(subdomain).product.create({
    data: { sku: uniq("SVC"), name: uniq("Service"), costPrice: 0n, price, kind: "SERVICE" },
  });
  return product.id;
}

async function trendOver(http: string, months?: number): Promise<WireBucket[]> {
  const url = months === undefined ? "/v1/dashboard/trend" : `/v1/dashboard/trend?months=${months.toString()}`;
  const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${http}` } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WireBucket[]>();
}

/** Independent: revenue (4xxx, credit − debit) over a business-date range, straight from the journal. */
async function revenueByGl(schema: string, from: string, to: string): Promise<bigint> {
  const result = await pool.query<{ v: string }>(
    `SELECT COALESCE(SUM(l."credit" - l."debit"), 0)::text AS v
       FROM "${schema}".journal_lines l
       JOIN "${schema}".journal_entries e ON e."id" = l."entryId"
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE a."code" LIKE '4%' AND e."entryDate" BETWEEN $1::date AND $2::date`,
    [from, to],
  );
  return BigInt(result.rows[0]?.v ?? "0");
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const [sub, name] of [
    [TENANT_A, "QA Trend A"],
    [TENANT_B, "QA Trend B"],
  ] as const) {
    await dropTenant(sub);
    await provisionFixture(sub, name);
  }
  ownerA = await token("MSME_OWNER", TENANT_A);
  ownerB = await token("MSME_OWNER", TENANT_B);

  // ---- Tenant A: a known history over three months -------------------------------
  const db = tenantDb(TENANT_A);
  const good = await createProduct(db, { price: 100000n, costPrice: 40000n }); // 1,000.00 / cost 400.00
  const service = await createService(TENANT_A, 50000n); // 500.00
  const lateService = await createService(TENANT_A, 7000n); // 70.00
  const earlyService = await createService(TENANT_A, 3000n); // 30.00
  await receiveStock(db, await createSupplier(db), [{ productId: good, quantity: "10", unitCost: 40000n }]);
  const till = await openTill(db);
  const sell = (lines: Array<{ productId: string; quantity: string }>, total: string, entryDate?: Date) =>
    recordSale(db, {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines,
      tenders: [{ tenderType: "CASH", amount: total }],
      ...(entryDate !== undefined ? { entryDate } : {}),
    });

  // Previous month: 2 goods + 1 service (2,500.00; cost 800.00), and a service sale voided TODAY.
  await sell(
    [
      { productId: good, quantity: "2" },
      { productId: service, quantity: "1" },
    ],
    "2500.00",
    new Date(Date.UTC(prevYear, prevMonth - 1, 15, 9)),
  );
  const prevSaleVoidedNow = await sell([{ productId: service, quantity: "1" }], "500.00", new Date(Date.UTC(prevYear, prevMonth - 1, 16, 9)));
  await recordExpense(db, {
    expenseDate: new Date(Date.UTC(prevYear, prevMonth - 1, 10)),
    category: "6030",
    payee: null,
    description: "Fuel",
    paymentMethod: "CASH",
    amountCents: 5000n,
    reference: null,
    createdBy: actorId(),
  });
  // Two months back: an expense only.
  await recordExpense(db, {
    expenseDate: new Date(Date.UTC(olderYear, olderMonth - 1, 5)),
    category: "6030",
    payee: null,
    description: "Fuel",
    paymentMethod: "CASH",
    amountCents: 1200n,
    reference: null,
    createdBy: actorId(),
  });

  // The month boundary, in UTC instants: 23:30 Nairobi on the previous month's last day
  // (20:30 UTC) stays there; 01:30 Nairobi on the 1st (22:30 UTC the day before) is THIS month.
  await sell([{ productId: earlyService, quantity: "1" }], "30.00", new Date(Date.UTC(prevYear, prevMonth - 1, prevLastDay, 20, 30)));
  await sell([{ productId: lateService, quantity: "1" }], "70.00", new Date(Date.UTC(prevYear, prevMonth - 1, prevLastDay, 22, 30)));

  // This month: 1 good (1,000.00; cost 400.00); a service sale and its void; the earlier sale's void.
  await sell([{ productId: good, quantity: "1" }], "1000.00");
  const voidedNow = await sell([{ productId: service, quantity: "1" }], "500.00");
  await voidSale(db, voidedNow.id, "T-F-DASH-1 same-month void", actorId());
  await voidSale(db, prevSaleVoidedNow.id, "T-F-DASH-1 voided a month later", actorId());

  // ---- Tenant B: one sale this month ------------------------------------------------
  const dbB = tenantDb(TENANT_B);
  const serviceB = await createService(TENANT_B, 9900n);
  const tillB = await openTill(dbB);
  await recordSale(dbB, {
    shiftId: tillB.shiftId,
    createdBy: tillB.cashierId,
    lines: [{ productId: serviceB, quantity: "1" }],
    tenders: [{ tenderType: "CASH", amount: "99.00" }],
  });
});

afterAll(async () => {
  for (const user of users) await platformDb.user.delete({ where: { id: user.id } });
  await dropTenant(TENANT_A);
  await dropTenant(TENANT_B);
  await app.close();
});

describe("the months", () => {
  it("are N calendar months, oldest first, labelled in Africa/Nairobi; the last is month-to-date", async () => {
    const buckets = await trendOver(ownerA);
    expect(buckets.map((b) => b.month)).toEqual([5, 4, 3, 2, 1, 0].map((back) => label(monthBack(back))));
    const last = nth(buckets, buckets.length - 1);
    expect(last).toMatchObject({ partial: true, from: `${label(monthBack(0))}-01`, to: today.toISOString().slice(0, 10) });
    for (const bucket of buckets.slice(0, -1)) expect(bucket.partial).toBe(false);
    expect(nth(buckets, 4)).toMatchObject({ from: `${label(monthBack(1))}-01`, to: `${label(monthBack(1))}-${String(prevLastDay).padStart(2, "0")}` });
    expect((await trendOver(ownerA, 12)).length).toBe(12);
  });

  it("step back across year boundaries, and the last month ends on 'today'", () => {
    const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
    expect(trendMonths(3, at("2027-01-15")).map((m) => m.month)).toEqual(["2026-11", "2026-12", "2027-01"]);
    const long = trendMonths(14, at("2026-02-28"));
    expect([nth(long, 0).month, nth(long, 13).month]).toEqual(["2025-01", "2026-02"]);
    expect(nth(long, 13).period).toEqual({ from: at("2026-02-01"), to: at("2026-02-28") });
    expect(nth(long, 12).period).toEqual({ from: at("2026-01-01"), to: at("2026-01-31") });
    expect(nth(trendMonths(2, at("2028-03-01")), 0).period.to).toEqual(at("2028-02-29")); // leap year
    expect(() => trendMonths(1)).toThrow(RangeError);
    expect(() => trendMonths(25)).toThrow(RangeError);
  });
});

describe("every bucket IS the income statement for that month", () => {
  it("equals buildIncomeStatement over the independently resolved month, and the GL", async () => {
    const buckets = await trendOver(ownerA);
    const source = { reader: tenantDb(TENANT_A), schema: schemaOf(TENANT_A) };
    for (const [index, bucket] of buckets.entries()) {
      const back = buckets.length - 1 - index;
      const [year, month] = monthBack(back);
      const period = back === 0 ? resolvePeriod({}) : resolvePeriod({ year, month });
      const statement = await buildIncomeStatement(source, period, false);
      expect({ month: bucket.month, figures: [bucket.revenue, bucket.costOfSales, bucket.grossProfit, bucket.operatingExpenses, bucket.netProfit] }).toEqual({
        month: bucket.month,
        figures: [
          statement.revenue.total,
          statement.costOfSales.total,
          statement.grossProfit.amount,
          statement.operatingExpenses.total,
          statement.netProfit.amount,
        ].map(String),
      });
      expect(BigInt(bucket.revenue)).toBe(await revenueByGl(schemaOf(TENANT_A), bucket.from, bucket.to));
    }
  });

  it("carries money as strings of cents", async () => {
    for (const bucket of await trendOver(ownerA)) {
      for (const key of ["revenue", "costOfSales", "grossProfit", "operatingExpenses", "netProfit"] as const) {
        expect(bucket[key]).toMatch(/^-?\d+$/);
      }
    }
  });
});

describe("what lands in which month", () => {
  it("previous month: goods + service revenue, cost only for the goods, the 23:30-Nairobi sale, and the sale voided later still counted", async () => {
    const prev = bucketFor(await trendOver(ownerA), label(monthBack(1)));
    // 2,500.00 + 500.00 (voided next month) + 30.00 (23:30 Nairobi on the last day).
    expect(prev.revenue).toBe("303000");
    expect(prev.costOfSales).toBe("80000"); // 2 goods at 400.00; the services cost nothing
    expect(prev.grossProfit).toBe("223000");
  });

  it("this month: the 01:30-Nairobi sale, a same-month void netting to zero, and last month's void reducing THIS month", async () => {
    const current = bucketFor(await trendOver(ownerA), label(monthBack(0)));
    // 1,000.00 + 70.00 (01:30 Nairobi on the 1st) + (500.00 − 500.00) − 500.00 (last month's sale voided now).
    expect(current.revenue).toBe("57000");
    expect(current.costOfSales).toBe("40000");
  });

  it("an expense-only month and empty months are present, with zeros where nothing happened", async () => {
    const buckets = await trendOver(ownerA);
    const older = bucketFor(buckets, label(monthBack(2)));
    expect(older).toMatchObject({ revenue: "0", costOfSales: "0", grossProfit: "0", operatingExpenses: "1200", netProfit: "-1200" });
    for (const back of [5, 4, 3]) {
      expect(bucketFor(buckets, label(monthBack(back)))).toMatchObject({
        revenue: "0",
        costOfSales: "0",
        grossProfit: "0",
        operatingExpenses: "0",
        netProfit: "0",
      });
    }
  });

  it("a future-dated window (a 'today' with nothing yet) is all zeros, every month present", async () => {
    const buckets = await buildDashboardTrend(tenantDb(TENANT_A), 3, new Date(Date.UTC(thisYear + 2, 0, 15)));
    expect(buckets).toHaveLength(3);
    for (const bucket of buckets) expect([bucket.revenue, bucket.netProfit]).toEqual([0n, 0n]);
  });
});

describe("isolation and access", () => {
  it("two businesses' trends never bleed into each other", async () => {
    const a = await trendOver(ownerA);
    const b = await trendOver(ownerB);
    expect(b.map((bucket) => bucket.revenue)).toEqual(["0", "0", "0", "0", "0", "9900"]);
    expect(nth(a, 5).revenue).toBe("57000");
  });

  it("admits the dashboard's readers and refuses everyone else", async () => {
    for (const role of ["ACCOUNTANT", "VIEWER_AUDITOR", "MSME_MANAGER"] as const) {
      expect((await trendOver(await token(role, TENANT_A), 2)).length).toBe(2);
    }
    for (const role of ["CASHIER", "HR_OFFICER", "WAREHOUSE_STAFF"] as const) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/dashboard/trend",
        headers: { authorization: `Bearer ${await token(role, TENANT_A)}` },
      });
      expect([role, response.statusCode]).toEqual([role, 403]);
    }
    expect((await app.inject({ method: "GET", url: "/v1/dashboard/trend" })).statusCode).toBe(401);
  });

  it("refuses months outside 2–24 with the one error shape", async () => {
    for (const months of ["1", "25", "0", "abc", "2.5"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/dashboard/trend?months=${months}`,
        headers: { authorization: `Bearer ${ownerA}` },
      });
      expect([months, response.statusCode]).toEqual([months, 400]);
      expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual(["error", "message", "statusCode"]);
    }
  });
});
