// ===========================================================================
// INVARIANT: Σ Product.stockValue == GL balance of account 1200 Inventory
// (the engineering ledger "Single-Writer Service Boundaries" and "Inventory Valuation Is
// Carrying-Value-Authoritative").
//
// Stock is brought in through the REAL procurement service (PO -> approve -> receive)
// and sold and voided through the REAL sales service. Both sides of the identity are
// then read with independent SQL — never through the inventory service that wrote
// them. The receipts deliberately reproduce the weighted-average case the engineering ledger
// records as having once drifted (17 @ 140.00 then 10 @ 50.00: the average
// 106.6666… does not divide evenly), and the last sale DEPLETES the product so the
// "zero quantity carries zero value" rule is exercised too.
// ===========================================================================

import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { formatCents } from "../../src/lib/money";
import { recordSale, voidSale, type SaleResult } from "../../src/services/sales";
import { schemaOf, tenantDb } from "../setup/tenant";
import {
  createProduct,
  createSupplier,
  glNet,
  openTill,
  receiveStock,
  sumStockValue,
  type Till,
} from "../support/fixtures";

const schema = schemaOf();
let productId = "";
let till: Till;

async function cashSale(quantity: string, unitPrice: bigint): Promise<SaleResult> {
  // ZERO_RATED: the tender is exactly price x quantity, so the test does not need to
  // re-derive VAT. (VAT is the subject of vat-by-regime.test.ts.)
  return recordSale(tenantDb(), {
    shiftId: till.shiftId,
    createdBy: till.cashierId,
    lines: [{ productId, quantity }],
    tenders: [{ tenderType: "CASH", amount: formatCents(unitPrice * BigInt(quantity)) }],
  });
}

async function stockOf(id: string): Promise<{ stockCount: string; stockValue: bigint }> {
  const result = await pool.query<{ stockCount: string; stockValue: string }>(
    `SELECT "stockCount"::text AS "stockCount", "stockValue"::text AS "stockValue" FROM "${schema}".products WHERE "id" = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`product ${id} not found`);
  return { stockCount: row.stockCount, stockValue: BigInt(row.stockValue) };
}

async function expectInventoryEqualsGl(): Promise<void> {
  const stockValue = await sumStockValue(schema);
  const gl1200 = await glNet(schema, "1200");
  expect(stockValue, "Σ Product.stockValue must equal the GL balance of 1200").toBe(gl1200);
}

beforeAll(async () => {
  const db = tenantDb();
  const supplierId = await createSupplier(db);
  productId = await createProduct(db, { price: 20000n, taxClass: "ZERO_RATED" });
  await receiveStock(db, supplierId, [{ productId, quantity: "17", unitCost: 14000n }]);
  await receiveStock(db, supplierId, [{ productId, quantity: "10", unitCost: 5000n }]);
  till = await openTill(db);
});

describe("inventory control = GL(1200)", () => {
  it("holds after two receipts at different costs (the non-dividing weighted average)", async () => {
    const product = await stockOf(productId);
    expect(product.stockCount).toBe("27.000");
    // 17 x 140.00 + 10 x 50.00, exactly — not 27 x a rounded average.
    expect(product.stockValue).toBe(238000n + 50000n);
    await expectInventoryEqualsGl();
  });

  it("holds after a PARTIAL sale, and 1200 is credited by exactly the sale's snapshotted COGS", async () => {
    const before = await stockOf(productId);
    const gl1200Before = await glNet(schema, "1200");
    const sale = await cashSale("5", 20000n);
    const after = await stockOf(productId);
    const line = sale.lines[0];
    expect(line?.lineCogs).not.toBeNull();
    const cogs = line?.lineCogs ?? 0n;
    expect(before.stockValue - after.stockValue, "stockValue moved by exactly the line's COGS").toBe(cogs);
    expect(cogs).toBeGreaterThan(0n);
    expect(await glNet(schema, "1200"), "GL(1200) moved by exactly the line's COGS").toBe(gl1200Before - cogs);
    await expectInventoryEqualsGl();
  });

  it("holds after a VOID, which returns the exact snapshotted cost (the pair nets 1200 to zero)", async () => {
    const before = await stockOf(productId);
    const gl1200Before = await glNet(schema, "1200");
    const sale = await cashSale("3", 20000n);
    await voidSale(tenantDb(), sale.id, "T-A1 void", till.cashierId);
    const after = await stockOf(productId);
    expect(after).toEqual(before);
    expect(await glNet(schema, "1200")).toBe(gl1200Before);
    await expectInventoryEqualsGl();
  });

  it("holds after a DEPLETING sale: zero quantity leaves exactly zero value", async () => {
    const remaining = await stockOf(productId);
    await cashSale(remaining.stockCount.replace(/\.000$/, ""), 20000n);
    const after = await stockOf(productId);
    expect(after.stockCount).toBe("0.000");
    expect(after.stockValue).toBe(0n);
    await expectInventoryEqualsGl();
  });

  it("Product.stockCount == Σ per-location owned quantity for every product", async () => {
    const result = await pool.query<{ mismatches: string }>(
      `SELECT count(*)::text AS mismatches FROM "${schema}".products p
        WHERE p."stockCount" <> COALESCE((SELECT SUM(s."quantity") FROM "${schema}".product_location_stock s
                                           WHERE s."productId" = p."id"), 0)`,
    );
    expect(result.rows[0]?.mismatches).toBe("0");
  });

  it("no journal entry outside the inventory service posts to 1200 (every 1200 line has a stock movement behind it)", async () => {
    const result = await pool.query<{ orphans: string }>(
      `SELECT count(*)::text AS orphans
         FROM "${schema}".journal_lines l
         JOIN "${schema}".accounts a ON a."id" = l."accountId"
         JOIN "${schema}".journal_entries e ON e."id" = l."entryId"
        WHERE a."code" = '1200'
          AND NOT EXISTS (SELECT 1 FROM "${schema}".stock_movements m
                           WHERE m."journalEntryId" = e."id" OR m."journalEntryId" = e."reversesEntryId")
`,
    );
    expect(result.rows[0]?.orphans).toBe("0");
  });
});
