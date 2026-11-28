// ===========================================================================
// INVARIANT: output VAT is charged ONLY by a VAT-registered tenant, ONLY on a
// STANDARD-RATED line, at the rate on the effective statutory schedule
// (the engineering ledger "VAT Model", Task 3B.1).
//
// The fixture is VAT-registered (set in global setup through the business-profile
// service). The non-registered case provisions its own tenant on the EXEMPT regime —
// not registered for VAT, and accruing no Turnover Tax either, so "no VAT" is
// observed without a TOT line in the same entry.
//
// The rate is read INDEPENDENTLY from the statutory_schedules row in force, and the
// VAT the sale posted is read from the journal lines, not from the sale result.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { businessToday } from "../../src/lib/business-time";
import { applyRatePercent, formatCents } from "../../src/lib/money";
import { updateBusinessProfile } from "../../src/services/business-profile";
import { recordSale, type SaleResult } from "../../src/services/sales";
import { resolveStandardVatRate } from "../../src/services/tax-config";
import type { PrismaClient as TenantPrismaClient } from "../../src/generated/tenant/client";
import { dropTenant, provisionFixture, schemaOf, tenantDb } from "../setup/tenant";
import {
  createProduct,
  createSupplier,
  entryAccounts,
  entryNet,
  glNet,
  openTill,
  receiveStock,
} from "../support/fixtures";

const NON_VAT_SUBDOMAIN = "qa-vat-exempt";

interface Catalogue {
  standard: string;
  zero: string;
  exempt: string;
}

async function stockedCatalogue(db: TenantPrismaClient): Promise<Catalogue> {
  const supplierId = await createSupplier(db);
  const standard = await createProduct(db, { price: 100000n, taxClass: "STANDARD_RATED" });
  const zero = await createProduct(db, { price: 50000n, taxClass: "ZERO_RATED" });
  const exempt = await createProduct(db, { price: 30000n, taxClass: "EXEMPT" });
  await receiveStock(db, supplierId, [
    { productId: standard, quantity: "5", unitCost: 60000n },
    { productId: zero, quantity: "5", unitCost: 30000n },
    { productId: exempt, quantity: "5", unitCost: 20000n },
  ]);
  return { standard, zero, exempt };
}

async function sellOneOfEach(db: TenantPrismaClient, catalogue: Catalogue, total: bigint): Promise<SaleResult> {
  const till = await openTill(db);
  return recordSale(db, {
    shiftId: till.shiftId,
    createdBy: till.cashierId,
    lines: [
      { productId: catalogue.standard, quantity: "2" },
      { productId: catalogue.zero, quantity: "1" },
      { productId: catalogue.exempt, quantity: "1" },
    ],
    tenders: [{ tenderType: "CASH", amount: formatCents(total) }],
  });
}

/** The standard rate on the schedule in force today, read straight from the table. */
async function scheduleStandardRate(schema: string): Promise<string> {
  const result = await pool.query<{ rate: string }>(
    `SELECT "vatStandardRate"::text AS rate FROM "${schema}".statutory_schedules
      WHERE "effectiveFrom" <= $1::date AND ("effectiveTo" IS NULL OR "effectiveTo" > $1::date)`,
    [businessToday().toISOString().slice(0, 10)],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]?.rate ?? "";
}

/** A zero rate however Decimal renders it ("0", "0.00"). */
const ZERO_RATE = /^0(.0+)?$/;

const NET = 2n * 100000n + 50000n + 30000n; // 2 x 1,000.00 + 500.00 + 300.00

describe("VAT-registered tenant (the fixture)", () => {
  const schema = schemaOf();
  let sale: SaleResult;
  let expectedVat = 0n;

  beforeAll(async () => {
    const db = tenantDb();
    const rate = await scheduleStandardRate(schema);
    // The service resolves the same rate (compared by value: "16" and "16.00" are one rate).
    const resolved = (await resolveStandardVatRate(db, new Date()))?.rate ?? "";
    expect(applyRatePercent(1_000_000n, resolved)).toBe(applyRatePercent(1_000_000n, rate));
    expectedVat = applyRatePercent(2n * 100000n, rate);
    sale = await sellOneOfEach(db, await stockedCatalogue(db), NET + expectedVat);
  });

  it("charges the schedule's standard rate on the STANDARD_RATED line (code B), and nothing else", () => {
    expect(expectedVat).toBeGreaterThan(0n);
    const [standard, zero, exempt] = sale.lines;
    expect(standard).toMatchObject({ taxClass: "STANDARD_RATED", taxCode: "B", lineNet: 200000n, lineVat: expectedVat });
    expect(zero).toMatchObject({ taxClass: "ZERO_RATED", taxCode: "C", lineVat: 0n });
    expect(exempt).toMatchObject({ taxClass: "EXEMPT", taxCode: "A", lineVat: 0n });
    expect(zero?.vatRate).toMatch(ZERO_RATE);
    expect(exempt?.vatRate).toMatch(ZERO_RATE);
    expect(sale.subtotal).toBe(NET);
    expect(sale.vatTotal).toBe(expectedVat);
    expect(sale.total).toBe(NET + expectedVat);
  });

  it("posts exactly that VAT to 2100 VAT Output Payable, and the net to 4000 revenue", async () => {
    const entryId = sale.saleJournalEntryId;
    if (entryId === null) throw new Error("sale posted no revenue entry");
    expect(await entryNet(schema, entryId, "2100")).toBe(-expectedVat);
    expect(await entryNet(schema, entryId, "4000")).toBe(-NET);
    expect(await entryNet(schema, entryId, "2110")).toBe(0n);
    expect(sale.totAccrued).toBe(0n);
  });

  it("stores the KRA code on each sale line, pinned by the 0024 CHECKs", async () => {
    const lines = await pool.query<{ taxCode: string; lineVat: string }>(
      `SELECT "taxCode"::text AS "taxCode", "lineVat"::text AS "lineVat" FROM "${schema}".sale_lines
        WHERE "saleId" = $1 ORDER BY "lineNumber"`,
      [sale.id],
    );
    expect(lines.rows).toEqual([
      { taxCode: "B", lineVat: expectedVat.toString() },
      { taxCode: "C", lineVat: "0" },
      { taxCode: "A", lineVat: "0" },
    ]);
  });
});

describe("NOT VAT-registered tenant (EXEMPT regime)", () => {
  const schema = schemaOf(NON_VAT_SUBDOMAIN);
  let sale: SaleResult;

  beforeAll(async () => {
    await dropTenant(NON_VAT_SUBDOMAIN);
    await provisionFixture(NON_VAT_SUBDOMAIN, "QA Non-VAT Business");
    const db = tenantDb(NON_VAT_SUBDOMAIN);
    const profile = await updateBusinessProfile(db, { taxRegime: "EXEMPT" });
    expect(profile.isVatRegistered).toBe(false);
    sale = await sellOneOfEach(db, await stockedCatalogue(db), NET);
  });

  afterAll(async () => {
    await dropTenant(NON_VAT_SUBDOMAIN);
  });

  it("charges NO VAT on any class: every line is code D at a zero rate", () => {
    expect(sale.lines.map((line) => line.taxCode)).toEqual(["D", "D", "D"]);
    for (const line of sale.lines) {
      expect(line.lineVat).toBe(0n);
      expect(line.vatRate).toMatch(ZERO_RATE);
    }
    expect(sale.vatTotal).toBe(0n);
    expect(sale.total).toBe(NET);
  });

  it("never touches 2100 — not in the sale's entry, not anywhere in the tenant's ledger", async () => {
    const entryId = sale.saleJournalEntryId;
    if (entryId === null) throw new Error("sale posted no revenue entry");
    expect(await entryAccounts(schema, entryId)).not.toContain("2100");
    expect(await glNet(schema, "2100")).toBe(0n);
    expect(await entryNet(schema, entryId, "4000")).toBe(-NET);
  });
});
