// ===========================================================================
// INVARIANT: a TURNOVER_TAX tenant accrues TOT on every sale — Dr 6110 Turnover Tax /
// Cr 2110 TOT Payable at the schedule's rate on the sale's turnover, inside the
// sale's own entry — and Sale.totAccrued is exactly what was posted
// (the engineering ledger "Turnover Tax", Task 3B.2).
//
// Runs on its OWN tenant, set to TURNOVER_TAX through the real business-profile
// service, because the shared fixture is VAT-registered. The rate is read
// independently from the statutory_schedules row; the posted figures from the
// journal lines.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { businessToday } from "../../src/lib/business-time";
import { applyRatePercent, formatCents } from "../../src/lib/money";
import { getBusinessProfile, updateBusinessProfile } from "../../src/services/business-profile";
import { recordSale, voidSale, type SaleResult } from "../../src/services/sales";
import { resolveTurnoverTaxRate } from "../../src/services/tax-config";
import { dropTenant, provisionFixture, schemaOf, tenantDb } from "../setup/tenant";
import {
  createProduct,
  createSupplier,
  entryAccounts,
  entryNet,
  glNet,
  openTill,
  receiveStock,
  type Till,
} from "../support/fixtures";

const TOT_SUBDOMAIN = "qa-tot";
const schema = schemaOf(TOT_SUBDOMAIN);
const PRICE = 125000n; // 1,250.00
let productId = "";
let till: Till;
let expectedTot = 0n;
let sale: SaleResult;

beforeAll(async () => {
  await dropTenant(TOT_SUBDOMAIN);
  await provisionFixture(TOT_SUBDOMAIN, "QA Turnover Tax Business");
  const db = tenantDb(TOT_SUBDOMAIN);
  const profile = await updateBusinessProfile(db, { taxRegime: "TURNOVER_TAX" });
  expect(profile).toMatchObject({ taxRegime: "TURNOVER_TAX", isVatRegistered: false });

  const rate = await pool.query<{ rate: string }>(
    `SELECT "totRatePercent"::text AS rate FROM "${schema}".statutory_schedules
      WHERE "effectiveFrom" <= $1::date AND ("effectiveTo" IS NULL OR "effectiveTo" > $1::date)`,
    [businessToday().toISOString().slice(0, 10)],
  );
  expect(rate.rows).toHaveLength(1);
  const totRate = rate.rows[0]?.rate ?? "";
  const resolved = (await resolveTurnoverTaxRate(db, new Date()))?.rate ?? "";
  expect(applyRatePercent(1_000_000n, resolved)).toBe(applyRatePercent(1_000_000n, totRate));
  expectedTot = applyRatePercent(3n * PRICE, totRate);

  const supplierId = await createSupplier(db);
  productId = await createProduct(db, { price: PRICE, taxClass: "STANDARD_RATED" });
  await receiveStock(db, supplierId, [{ productId, quantity: "10", unitCost: 70000n }]);
  till = await openTill(db);
  sale = await recordSale(db, {
    shiftId: till.shiftId,
    createdBy: till.cashierId,
    lines: [{ productId, quantity: "3" }],
    tenders: [{ tenderType: "CASH", amount: formatCents(3n * PRICE) }],
  });
});

afterAll(async () => {
  await dropTenant(TOT_SUBDOMAIN);
});

describe("Turnover Tax accrual", () => {
  it("the tenant is on TURNOVER_TAX as the service reports it", async () => {
    expect((await getBusinessProfile(tenantDb(TOT_SUBDOMAIN))).taxRegime).toBe("TURNOVER_TAX");
  });

  it("posts Dr 6110 / Cr 2110 at the schedule rate on turnover, inside the sale's own entry", async () => {
    expect(expectedTot).toBeGreaterThan(0n);
    const entryId = sale.saleJournalEntryId;
    if (entryId === null) throw new Error("sale posted no revenue entry");
    expect(await entryNet(schema, entryId, "6110")).toBe(expectedTot);
    expect(await entryNet(schema, entryId, "2110")).toBe(-expectedTot);
  });

  it("Sale.totAccrued equals the posted accrual — in the result and in the stored row", async () => {
    expect(sale.totAccrued).toBe(expectedTot);
    const stored = await pool.query<{ totAccrued: string }>(
      `SELECT "totAccrued"::text AS "totAccrued" FROM "${schema}".sales WHERE "id" = $1`,
      [sale.id],
    );
    expect(BigInt(stored.rows[0]?.totAccrued ?? "-1")).toBe(expectedTot);
    expect(await glNet(schema, "2110")).toBe(-expectedTot);
  });

  it("is a tax on the business, never on the customer: no VAT, no surcharge, every line code D", async () => {
    expect(sale.total).toBe(3n * PRICE);
    expect(sale.vatTotal).toBe(0n);
    expect(sale.lines.map((line) => line.taxCode)).toEqual(["D"]);
    const entryId = sale.saleJournalEntryId ?? "";
    expect(await entryAccounts(schema, entryId)).not.toContain("2100");
    expect(await entryNet(schema, entryId, "4000")).toBe(-(3n * PRICE));
  });

  it("a void reverses exactly the accrued TOT — 2110 returns to zero", async () => {
    await voidSale(tenantDb(TOT_SUBDOMAIN), sale.id, "T-A1 void", till.cashierId);
    expect(await glNet(schema, "2110")).toBe(0n);
    expect(await glNet(schema, "6110")).toBe(0n);
  });
});
