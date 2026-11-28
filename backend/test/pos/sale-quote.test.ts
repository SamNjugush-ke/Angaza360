// ===========================================================================
// THE PRE-SALE QUOTE (Task T-B-POS-QUOTE), through the REAL app.
//
// POST /v1/pos/sales/quote prices a sale's lines through priceSaleLines — the very function
// POST /sales posts with — and writes nothing. So the quoted total IS the total the till must
// tender: proven by quoting, then posting a sale tendered at exactly that total, on a
// VAT-registered tenant (standard B, zero-rated C and exempt A lines, a discount, a fractional
// quantity) and on a Turnover-Tax tenant (all D, no VAT). GOOD lines carry the selling
// location's sellable quantity; nothing is written (row counts, and a READ ONLY transaction);
// the tenant is the session's; the till roles only.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformDb } from "../../src/db/platform";
import { pool } from "../../src/db/pool";
import type { UserRole } from "../../src/generated/platform/enums";
import { buildServer } from "../../src/server";
import { updateBusinessProfile } from "../../src/services/business-profile";
import { recordStockMovement, transferStock } from "../../src/services/inventory";
import { bearer, createStaffUser, signIn, type SignedIn, type StaffUser } from "../identity/staff-fixture";
import { freshIp } from "../security/http-app";
import { dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, assignCashier, uniq } from "../support/fixtures";

const VAT = "qa-quote-vat";
const TOT = "qa-quote-tot";

let app: FastifyInstance;
const users: StaffUser[] = [];
const sessions = new Map<string, SignedIn>();
const ids: Record<string, string> = {};

interface QuoteLine {
  productId: string;
  sku: string;
  kind: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxCode: string;
  vatRate: string;
  lineNet: string;
  lineVat: string;
  lineTotal: string;
  sellable: string | null;
}
interface Quote {
  sellingLocationId: string;
  lines: QuoteLine[];
  subtotal: string;
  vatTotal: string;
  total: string;
}
interface SaleBody {
  subtotal: string;
  vatTotal: string;
  total: string;
  lines: Array<{ productId: string; lineNet: string; lineVat: string; lineTotal: string; taxCode: string; vatRate: string; discount: string }>;
}

const who = (tenant: string, role: UserRole) => sessions.get(`${tenant}:${role}`) as SignedIn;

function post(url: string, payload: unknown, signedIn: SignedIn | null) {
  return app.inject({ method: "POST", url, remoteAddress: freshIp(), headers: signedIn ? bearer(signedIn.token) : {}, payload: payload as Record<string, unknown> });
}

/** Cents → the API's decimal amount string ("123456" → "1234.56"); string arithmetic, no float. */
function amount(cents: string): string {
  const padded = cents.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

async function rowCounts(tenant: string): Promise<Record<string, number>> {
  const schema = schemaOf(tenant);
  const out: Record<string, number> = {};
  for (const table of ["sales", "sale_lines", "sale_tenders", "journal_entries", "journal_lines", "stock_movements", "product_location_stock", "shifts"]) {
    const rows = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}"."${table}"`);
    out[table] = rows.rows[0]?.n ?? -1;
  }
  return out;
}

async function stocked(tenant: string, key: string, data: { price: bigint; taxClass?: "STANDARD_RATED" | "ZERO_RATED" | "EXEMPT"; kind?: "GOOD" | "SERVICE" }, qty = "50") {
  const db = tenantDb(tenant);
  const product = await db.product.create({ data: { sku: uniq(key), name: key, costPrice: 1000n, price: data.price, ...(data.taxClass ? { taxClass: data.taxClass } : {}), ...(data.kind ? { kind: data.kind } : {}) } });
  if ((data.kind ?? "GOOD") === "GOOD") {
    await recordStockMovement(db, { productId: product.id, movementType: "OPENING_BALANCE", quantity: qty, unitCost: 1000n, createdBy: actorId() });
  }
  ids[`${tenant}:${key}`] = product.id;
  return product.id;
}

async function openShift(tenant: string): Promise<string> {
  const response = await post("/v1/pos/shifts/open", { openingFloat: "0.00" }, who(tenant, "CASHIER"));
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  for (const tenant of [VAT, TOT]) {
    await dropTenant(tenant);
    await provisionFixture(tenant, tenant === VAT ? "QA Quote VAT" : "QA Quote TOT");
    await updateBusinessProfile(tenantDb(tenant), { taxRegime: tenant === VAT ? "VAT_REGISTERED" : "TURNOVER_TAX" });
    const tenantId = await tenantIdOf(tenant);
    for (const role of ["CASHIER", "MSME_MANAGER", "MSME_OWNER", "ACCOUNTANT", "VIEWER_AUDITOR", "WAREHOUSE_STAFF"] as const) {
      const user = await createStaffUser(role, tenantId);
      users.push(user);
      if (role === "CASHIER") await assignCashier(tenantDb(tenant), user.id);
      sessions.set(`${tenant}:${role}`, await signIn(app, user));
    }
  }
  // VAT tenant: standard (B), zero-rated (C), exempt (A), and a service (B).
  await stocked(VAT, "STD", { price: 100000n });
  await stocked(VAT, "ZERO", { price: 25050n, taxClass: "ZERO_RATED" });
  await stocked(VAT, "EXEMPT", { price: 9999n, taxClass: "EXEMPT" });
  await stocked(VAT, "SVC", { price: 50000n, kind: "SERVICE" });
  await stocked(TOT, "STD", { price: 100000n });
  await stocked(TOT, "ZERO", { price: 25050n, taxClass: "ZERO_RATED" });
});

afterAll(async () => {
  await platformDb.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  for (const tenant of [VAT, TOT]) await dropTenant(tenant);
  await app.close();
});

describe("the quote is the sale", () => {
  it("VAT-registered: B, C and A lines with a discount and a fractional quantity — exact figures, then a sale at exactly that total", async () => {
    const lines = [
      { productId: ids[`${VAT}:STD`], quantity: "2", discount: "150.00" },
      { productId: ids[`${VAT}:ZERO`], quantity: "1.5" },
      { productId: ids[`${VAT}:EXEMPT`], quantity: "3" },
      { productId: ids[`${VAT}:SVC`], quantity: "1" },
    ];
    const quoted = await post("/v1/pos/sales/quote", { lines }, who(VAT, "CASHIER"));
    expect(quoted.statusCode).toBe(200);
    const quote = quoted.json<Quote>();
    // Absolute figures: 2 × 1,000.00 − 150.00 = 1,850.00 at 16% → 296.00 (B); 1.5 × 250.50 =
    // 375.75 (C, no VAT); 3 × 99.99 = 299.97 (A, no VAT); service 500.00 at 16% → 80.00 (B).
    expect(quote.lines.map((line) => [line.taxCode, line.vatRate, line.discount, line.lineNet, line.lineVat, line.lineTotal])).toEqual([
      ["B", "16", "15000", "185000", "29600", "214600"],
      ["C", "0", "0", "37575", "0", "37575"],
      ["A", "0", "0", "29997", "0", "29997"],
      ["B", "16", "0", "50000", "8000", "58000"],
    ]);
    expect([quote.subtotal, quote.vatTotal, quote.total]).toEqual(["302572", "37600", "340172"]);

    const shiftId = await openShift(VAT);
    const sold = await post("/v1/pos/sales", { shiftId, lines, tenders: [{ tenderType: "CASH", amount: amount(quote.total) }] }, who(VAT, "CASHIER"));
    expect(sold.statusCode).toBe(201);
    const sale = sold.json<SaleBody>();
    expect([sale.subtotal, sale.vatTotal, sale.total]).toEqual([quote.subtotal, quote.vatTotal, quote.total]);
    expect(sale.lines.map((line) => [line.taxCode, line.vatRate, line.discount, line.lineNet, line.lineVat, line.lineTotal])).toEqual(
      quote.lines.map((line) => [line.taxCode, line.vatRate, line.discount, line.lineNet, line.lineVat, line.lineTotal]),
    );
  });

  it("Turnover Tax: every line D, no VAT, total = subtotal — and the sale agrees", async () => {
    const lines = [
      { productId: ids[`${TOT}:STD`], quantity: "1", discount: "0.50" }, // 1,000.00 − 0.50 = 999.50
      { productId: ids[`${TOT}:ZERO`], quantity: "2" }, // 2 × 250.50 = 501.00 → 1,500.50 in all
    ];
    const quote = (await post("/v1/pos/sales/quote", { lines }, who(TOT, "CASHIER"))).json<Quote>();
    expect(quote.lines.map((line) => [line.taxCode, line.lineVat])).toEqual([["D", "0"], ["D", "0"]]);
    expect([quote.subtotal, quote.vatTotal, quote.total]).toEqual(["150050", "0", "150050"]);
    const shiftId = await openShift(TOT);
    const sale = (await post("/v1/pos/sales", { shiftId, lines, tenders: [{ tenderType: "CASH", amount: amount(quote.total) }] }, who(TOT, "CASHIER"))).json<SaleBody>();
    expect([sale.subtotal, sale.vatTotal, sale.total]).toEqual([quote.subtotal, quote.vatTotal, quote.total]);
  });

  it("refuses what the sale refuses, with the sale's message", async () => {
    const tooMuch = await post("/v1/pos/sales/quote", { lines: [{ productId: ids[`${VAT}:EXEMPT`], quantity: "1", discount: "100.00" }] }, who(VAT, "CASHIER"));
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json<{ message: string }>().message).toBe("Line 1: discount exceeds the line value.");
    expect((await post("/v1/pos/sales/quote", { lines: [] }, who(VAT, "CASHIER"))).statusCode).toBe(400);
    expect((await post("/v1/pos/sales/quote", { lines: [{ productId: ids[`${VAT}:STD`], quantity: "1", discount: 5 }] }, who(VAT, "CASHIER"))).statusCode).toBe(400);
  });
});

describe("sellable quantity at the location", () => {
  it("reflects what the resolved selling location may sell; a service has none", async () => {
    const db = tenantDb(VAT);
    const main = await db.location.findFirstOrThrow({ where: { isDefault: true } });
    const till = await db.location.create({ data: { code: uniq("TILL"), name: "Quote till", type: "POS" } });
    const productId = await stocked(VAT, "SPLIT", { price: 1000n }, "10");
    await transferStock(db, { productId, fromLocationId: main.id, toLocationId: till.id, quantity: "4", createdBy: actorId() });
    const lines = [{ productId, quantity: "1" }, { productId: ids[`${VAT}:SVC`], quantity: "1" }];
    const atMain = (await post("/v1/pos/sales/quote", { lines }, who(VAT, "CASHIER"))).json<Quote>();
    // A cashier quotes only at their assigned location (MAIN here); the manager may quote any till.
    const atTill = (await post("/v1/pos/sales/quote", { lines, sellingLocationId: till.id }, who(VAT, "MSME_MANAGER"))).json<Quote>();
    expect(atMain.sellingLocationId).toBe(main.id);
    expect(atMain.lines.map((line) => line.sellable)).toEqual(["6.000", null]);
    expect(atTill.sellingLocationId).toBe(till.id);
    expect(atTill.lines.map((line) => line.sellable)).toEqual(["4.000", null]);
    // More than the location holds is still quoted — the warning is the sellable figure; the sale refuses.
    const over = (await post("/v1/pos/sales/quote", { lines: [{ productId, quantity: "9" }], sellingLocationId: till.id }, who(VAT, "MSME_MANAGER"))).json<Quote>();
    expect(over.lines[0]?.sellable).toBe("4.000");
  });
});

describe("a quote writes nothing", () => {
  it("leaves every sale, ledger and stock table exactly as it was", async () => {
    const before = await rowCounts(VAT);
    for (let i = 0; i < 3; i += 1) {
      const response = await post("/v1/pos/sales/quote", { lines: [{ productId: ids[`${VAT}:STD`], quantity: "1" }] }, who(VAT, "CASHIER"));
      expect(response.statusCode).toBe(200);
    }
    expect(await rowCounts(VAT)).toEqual(before);
  });
});

describe("isolation and RBAC", () => {
  it("prices only the session's own tenant: another business's product is unknown", async () => {
    const response = await post("/v1/pos/sales/quote", { lines: [{ productId: ids[`${VAT}:STD`], quantity: "1" }] }, who(TOT, "CASHIER"));
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(/unknown product/);
  });

  it("is for the till roles only", async () => {
    const lines = [{ productId: ids[`${VAT}:STD`], quantity: "1" }];
    for (const role of ["CASHIER", "MSME_MANAGER", "MSME_OWNER"] as const) {
      expect([role, (await post("/v1/pos/sales/quote", { lines }, who(VAT, role))).statusCode]).toEqual([role, 200]);
    }
    for (const role of ["ACCOUNTANT", "VIEWER_AUDITOR", "WAREHOUSE_STAFF"] as const) {
      expect([role, (await post("/v1/pos/sales/quote", { lines }, who(VAT, role))).statusCode]).toEqual([role, 403]);
    }
    expect((await post("/v1/pos/sales/quote", { lines }, null)).statusCode).toBe(401);
  });
});
