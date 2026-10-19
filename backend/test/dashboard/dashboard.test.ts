// ===========================================================================
// THE DASHBOARD DERIVES FROM MODULE 13 (Task T-A10).
//
// * NO DRIFT (binding): the dashboard's revenue, cost of sales, profits and operating
//   expenses EQUAL buildIncomeStatement for the same period; its cash (1000/1010/1020),
//   receivables (1100) and payables (2000) EQUAL the balance sheet as at the period's end
//   — and an independent GL sum. When the data changes (a sale, a voided sale, an
//   expense), both sides move together.
// * READINESS reflects the business's actual state: flip a condition and its check —
//   and the ready-to-trade rollup — flips.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { platformDb } from "../../src/db/platform";
import { buildServer } from "../../src/server";
import { buildBalanceSheet, buildIncomeStatement, resolvePeriod } from "../../src/services/reports";
import { recordSale, voidSale } from "../../src/services/sales";
import { recordExpense } from "../../src/services/expenses";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, createProduct, createSupplier, openTill, receiveStock } from "../support/fixtures";
import { accessTokenFor, createFixtureUser, deleteUsers, type TestUser } from "../security/http-app";
import { createStaffUser, type StaffUser } from "../identity/staff-fixture";
import { businessToday } from "../../src/lib/business-time";

const schema = schemaOf();
const READY_TENANT = "qa-readiness";

let app: FastifyInstance;
let owner: TestUser;
let ownerToken = "";
let readyOwner: StaffUser;
let readyToken = "";

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  owner = await createFixtureUser("MSME_OWNER");
  ownerToken = await accessTokenFor(app, owner);
  await dropTenant(READY_TENANT);
  await provisionFixture(READY_TENANT, "QA Readiness Business");
  readyOwner = await createStaffUser("MSME_OWNER", await tenantIdOf(READY_TENANT));
  readyToken = await accessTokenFor(app, readyOwner);
});

afterAll(async () => {
  await deleteUsers([owner]);
  await dropTenant(READY_TENANT);
  await app.close();
});

interface DashboardBody {
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  operatingExpenses: string;
  netProfit: string;
  cashPosition: { total: string; accounts: Array<{ code: string; amount: string }> };
  receivables: string;
  payables: string;
  topExpenseCategories: Array<{ code: string; amount: string }>;
  lowStockCount: number;
}

async function dashboard(): Promise<DashboardBody> {
  const response = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization: `Bearer ${ownerToken}` } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DashboardBody>();
}

/** Independent: Σ(debit − credit) on accounts up to a business date. */
async function glAsOf(codes: readonly string[], asOf: Date): Promise<bigint> {
  const result = await pool.query<{ v: string }>(
    `SELECT COALESCE(SUM(l."debit" - l."credit"), 0)::text AS v
       FROM "${schema}".journal_lines l
       JOIN "${schema}".journal_entries e ON e."id" = l."entryId"
       JOIN "${schema}".accounts a ON a."id" = l."accountId"
      WHERE a."code" = ANY($1::text[]) AND e."entryDate" <= $2::date`,
    [codes, asOf.toISOString().slice(0, 10)],
  );
  return BigInt(result.rows[0]?.v ?? "0");
}

async function assertNoDrift(): Promise<DashboardBody> {
  const period = resolvePeriod({});
  const source = { reader: tenantDb(), schema };
  const statement = await buildIncomeStatement(source, period, false);
  const sheet = await buildBalanceSheet(source, period.to, false);
  const body = await dashboard();

  expect(BigInt(body.revenue)).toBe(statement.revenue.total);
  expect(BigInt(body.costOfSales)).toBe(statement.costOfSales.total);
  expect(BigInt(body.grossProfit)).toBe(statement.grossProfit.amount);
  expect(BigInt(body.operatingExpenses)).toBe(statement.operatingExpenses.total);
  expect(BigInt(body.netProfit)).toBe(statement.netProfit.amount);

  const sheetLine = (code: string) =>
    [...sheet.assets.current.lines, ...sheet.liabilities.current.lines].find((line) => line.code === code)?.amount ?? 0n;
  for (const code of ["1000", "1010", "1020"]) {
    expect(BigInt(body.cashPosition.accounts.find((a) => a.code === code)?.amount ?? "x")).toBe(sheetLine(code));
  }
  expect(BigInt(body.cashPosition.total)).toBe(await glAsOf(["1000", "1010", "1020"], period.to));
  expect(BigInt(body.receivables)).toBe(sheetLine("1100"));
  expect(BigInt(body.receivables)).toBe(await glAsOf(["1100"], period.to));
  expect(BigInt(body.payables)).toBe(sheetLine("2000"));
  expect(BigInt(body.payables)).toBe(-(await glAsOf(["2000"], period.to)));
  return body;
}

describe("the dashboard derives from Module 13 — no drift", () => {
  it("every figure equals the income statement, the balance sheet and an independent GL sum — before and after the data changes", async () => {
    const before = await assertNoDrift();

    // Change the data: stock in on account, two cash sales (one voided), an expense.
    const supplierId = await createSupplier(tenantDb());
    const productId = await createProduct(tenantDb(), { price: 40000n, taxClass: "ZERO_RATED" });
    await receiveStock(tenantDb(), supplierId, [{ productId, quantity: "5", unitCost: 10000n }]);
    const till = await openTill(tenantDb());
    const sell = () =>
      recordSale(tenantDb(), {
        shiftId: till.shiftId,
        createdBy: till.cashierId,
        lines: [{ productId, quantity: "1" }],
        tenders: [{ tenderType: "CASH", amount: "400.00" }],
      });
    await sell();
    const toVoid = await sell();
    await voidSale(tenantDb(), toVoid.id, "T-A10 drift check", actorId());
    await recordExpense(tenantDb(), {
      expenseDate: businessToday(),
      category: "6030",
      payee: null,
      description: "Fuel",
      paymentMethod: "CASH",
      amountCents: 2500n,
      reference: null,
      createdBy: actorId(),
    });

    const after = await assertNoDrift();
    // Both sides moved: one net sale of 400.00 and its 100.00 cost; a 25.00 expense; cash.
    expect(BigInt(after.revenue) - BigInt(before.revenue)).toBe(40000n);
    expect(BigInt(after.costOfSales) - BigInt(before.costOfSales)).toBe(10000n);
    expect(BigInt(after.operatingExpenses) - BigInt(before.operatingExpenses)).toBe(2500n);
    expect(BigInt(after.cashPosition.total) - BigInt(before.cashPosition.total)).toBe(40000n - 2500n);
    expect(after.topExpenseCategories.map((c) => c.code)).toContain("6030");
  });

  it("is refused to a cashier and needs a session", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/dashboard" })).statusCode).toBe(401);
    const cashier = await createFixtureUser("CASHIER");
    const token = await accessTokenFor(app, cashier);
    expect((await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
    await deleteUsers([cashier]);
  });
});

describe("merchant readiness reflects actual state", () => {
  interface ReadinessBody {
    readyToTrade: boolean;
    checks: Array<{ key: string; pass: boolean; required: boolean }>;
  }
  async function readiness(): Promise<ReadinessBody> {
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/readiness", headers: { authorization: `Bearer ${readyToken}` } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<ReadinessBody>();
  }
  const pass = (body: ReadinessBody, key: string) => body.checks.find((check) => check.key === key)?.pass;

  it("a fresh business is not ready; each condition flips its check and the rollup", async () => {
    const db = tenantDb(READY_TENANT);
    const fresh = await readiness();
    expect(fresh.readyToTrade).toBe(false);
    expect(pass(fresh, "ACTIVE_PRODUCT")).toBe(false);
    expect(pass(fresh, "STOCK_OR_SERVICE")).toBe(false);
    expect(pass(fresh, "TAX_REGIME_SET")).toBe(true);
    expect(pass(fresh, "FIRST_SALE")).toBe(false);
    expect(pass(fresh, "KRA_PIN")).toBe(false);
    expect(pass(fresh, "STAFF_BEYOND_OWNER")).toBe(false);

    // An active SERVICE: something to sell -> ready to trade.
    const service = await db.product.create({ data: { sku: "QA-SVC-1", name: "Consulting", costPrice: 0n, price: 100000n, kind: "SERVICE" } });
    const ready = await readiness();
    expect(pass(ready, "ACTIVE_PRODUCT")).toBe(true);
    expect(pass(ready, "STOCK_OR_SERVICE")).toBe(true);
    expect(ready.readyToTrade).toBe(true);

    // Deactivate it: no longer ready.
    await db.product.update({ where: { id: service.id }, data: { isActive: false } });
    expect((await readiness()).readyToTrade).toBe(false);
    await db.product.update({ where: { id: service.id }, data: { isActive: true } });

    // The recommended checks flip with their facts.
    await db.businessProfile.update({ where: { id: "singleton" }, data: { kraPin: "P051234567X" } });
    const cashier = await createStaffUser("CASHIER", await tenantIdOf(READY_TENANT));
    const till = await openTill(db);
    await recordSale(db, {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines: [{ productId: service.id, quantity: "1" }],
      tenders: [{ tenderType: "CASH", amount: "1000.00" }],
    });
    const later = await readiness();
    expect(pass(later, "KRA_PIN")).toBe(true);
    expect(pass(later, "STAFF_BEYOND_OWNER")).toBe(true);
    expect(pass(later, "FIRST_SALE")).toBe(true);
    expect(later.readyToTrade).toBe(true);
    await platformDb.user.delete({ where: { id: cashier.id } });
  });
});
