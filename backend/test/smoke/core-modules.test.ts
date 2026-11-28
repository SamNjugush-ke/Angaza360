// ===========================================================================
// THIN HAPPY-PATH SMOKE for core modules the invariant suite does not already drive
// (Task T-A1). The invariant tests exercise the real write paths of sales,
// inventory, procurement, payables, receivables, payroll and the ledger; this file
// covers what is left, and deliberately stays thin:
//   * product catalogue + customers — created with the tenant Prisma client exactly
//     as src/routes/products.ts and customers.ts do (neither module has a service
//     layer), checking the defaults and DB constraints those routes rely on;
//   * shifts — open, sell, close through src/services/shifts.ts;
//   * locations + transfers — create a till through src/services/locations.ts and
//     move stock to it through src/services/inventory.ts, value-neutrally.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { Prisma } from "../../src/generated/tenant/client";
import { recordSale } from "../../src/services/sales";
import { closeShift, getShiftSummary } from "../../src/services/shifts";
import { createLocation, getMainLocation } from "../../src/services/locations";
import { transferStock } from "../../src/services/inventory";
import { schemaOf, tenantDb } from "../setup/tenant";
import {
  actorId,
  createCustomer,
  createProduct,
  createSupplier,
  glNet,
  openTill,
  receiveStock,
  sumStockValue,
  uniq,
} from "../support/fixtures";

const schema = schemaOf();

describe("product catalogue", () => {
  it("a new product starts with no stock, no value and the STANDARD_RATED default class", async () => {
    const db = tenantDb();
    const id = await createProduct(db, { price: 45000n, costPrice: 30000n });
    const product = await db.product.findUniqueOrThrow({ where: { id } });
    expect(product).toMatchObject({ price: 45000n, costPrice: 30000n, taxClass: "STANDARD_RATED", isActive: true });
    expect(product.stockCount.toString()).toBe("0");
    expect(product.stockValue).toBe(0n);
  });

  it("the SKU is unique (the route's 409)", async () => {
    const db = tenantDb();
    const sku = uniq("DUP");
    await createProduct(db, { price: 100n, sku });
    await expect(createProduct(db, { price: 100n, sku })).rejects.toSatisfy(
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
  });
});

describe("customers", () => {
  it("a new customer carries the given credit limit and a zero balance", async () => {
    const db = tenantDb();
    const id = await createCustomer(db, 2500000n);
    const customer = await db.customer.findUniqueOrThrow({ where: { id } });
    expect(customer).toMatchObject({ creditLimit: 2500000n, creditBalance: 0n, isActive: true });
  });
});

describe("shifts", () => {
  it("open -> cash sale -> close: expected cash and a zero variance", async () => {
    const db = tenantDb();
    const supplierId = await createSupplier(db);
    const productId = await createProduct(db, { price: 25000n, taxClass: "ZERO_RATED" });
    await receiveStock(db, supplierId, [{ productId, quantity: "2", unitCost: 10000n }]);
    const till = await openTill(db);
    await recordSale(db, {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines: [{ productId, quantity: "2" }],
      tenders: [{ tenderType: "CASH", amount: "500.00" }],
    });
    const open = await getShiftSummary(db, till.shiftId);
    expect(open).toMatchObject({ status: "OPEN", saleCount: 1, gross: 50000n });
    const closed = await closeShift(db, till.shiftId, 50000n, till.cashierId);
    expect(closed).toMatchObject({ status: "CLOSED", expectedCash: 50000n, variance: 0n });
  });
});

describe("locations and transfers", () => {
  it("stock moves to a new till value-neutrally: aggregate, value and GL(1200) unchanged", async () => {
    const db = tenantDb();
    const supplierId = await createSupplier(db);
    const productId = await createProduct(db, { price: 30000n, taxClass: "ZERO_RATED" });
    await receiveStock(db, supplierId, [{ productId, quantity: "9", unitCost: 11111n }]);
    const main = await getMainLocation(db);
    const till = await createLocation(db, { name: "QA Till", code: uniq("TILL").toUpperCase(), type: "POS" });

    const before = await db.product.findUniqueOrThrow({ where: { id: productId } });
    const gl1200Before = await glNet(schema, "1200");
    const transfer = await transferStock(db, {
      productId,
      fromLocationId: main.id,
      toLocationId: till.id,
      quantity: "4",
      createdBy: actorId(),
    });
    expect(transfer.quantity).toMatch(/^4(\.0+)?$/);

    const after = await db.product.findUniqueOrThrow({ where: { id: productId } });
    expect(after.stockCount.toString()).toBe(before.stockCount.toString());
    expect(after.stockValue).toBe(before.stockValue);
    expect(await glNet(schema, "1200")).toBe(gl1200Before);
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));

    const split = await db.productLocationStock.findMany({ where: { productId }, select: { locationId: true, quantity: true } });
    const byLocation = new Map(split.map((row) => [row.locationId, row.quantity.toString()]));
    expect(byLocation.get(main.id)).toBe("5");
    expect(byLocation.get(till.id)).toBe("4");
  });
});
