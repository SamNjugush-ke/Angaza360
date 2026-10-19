// ===========================================================================
// PRODUCT CATALOG EDITING (Task T-A7), through the REAL app and the real services.
//
// * PATCH /v1/products/:id edits catalog fields; sku and barcode stay unique (409).
// * COST PRICE IS NOT A REVALUATION (binding): editing costPrice leaves stockValue,
//   avgCost and stockCount, GL 1200, the journal and the movement history untouched.
// * A selling-price edit is forward-only: an earlier sale line keeps its price.
// * A DEACTIVATED product cannot be sold or restocked, but its stock stays owned and
//   valued (Σ stockValue = GL 1200) and can still be moved out; reactivation restores
//   selling.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { buildServer } from "../../src/server";
import { recordStockMovement } from "../../src/services/inventory";
import { recordSale } from "../../src/services/sales";
import { schemaOf, tenantDb } from "../setup/tenant";
import { actorId, createProduct, createSupplier, glNet, openTill, receiveStock, sumStockValue, uniq } from "../support/fixtures";
import { accessTokenFor, createFixtureUser, deleteUsers, type TestUser } from "../security/http-app";

const schema = schemaOf();

let app: FastifyInstance;
let owner: TestUser;
let cashier: TestUser;
let ownerToken = "";
let supplierId = "";

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  owner = await createFixtureUser("MSME_OWNER");
  cashier = await createFixtureUser("CASHIER");
  ownerToken = await accessTokenFor(app, owner);
  supplierId = await createSupplier(tenantDb());
});

afterAll(async () => {
  await deleteUsers([owner, cashier]);
  await app.close();
});

function patch(id: string, payload: Record<string, unknown>, token: string = ownerToken) {
  return app.inject({ method: "PATCH", url: `/v1/products/${id}`, headers: { authorization: `Bearer ${token}` }, payload });
}

async function stockedProduct(quantity: string, unitCost: bigint): Promise<string> {
  const productId = await createProduct(tenantDb(), { price: 50000n, costPrice: unitCost, taxClass: "ZERO_RATED" });
  await receiveStock(tenantDb(), supplierId, [{ productId, quantity, unitCost }]);
  return productId;
}

async function counts(): Promise<{ entries: number; movements: number }> {
  const result = await pool.query<{ entries: number; movements: number }>(
    `SELECT (SELECT count(*)::int FROM "${schema}".journal_entries) AS entries,
            (SELECT count(*)::int FROM "${schema}".stock_movements) AS movements`,
  );
  return result.rows[0] ?? { entries: -1, movements: -1 };
}

function sell(productId: string, quantity: string, amount: string) {
  return openTill(tenantDb()).then((till) =>
    recordSale(tenantDb(), {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines: [{ productId, quantity }],
      tenders: [{ tenderType: "CASH", amount }],
    }),
  );
}

describe("PATCH /v1/products/:id", () => {
  it("edits persist", async () => {
    const productId = await createProduct(tenantDb(), { price: 10000n });
    const sku = uniq("EDITED");
    const barcode = uniq("BC");
    const response = await patch(productId, {
      sku,
      name: "Edited name",
      description: "Edited description",
      category: "Edited category",
      barcode,
      imageUrl: "https://cdn.example.test/p.png",
      unitOfMeasure: "box",
      price: "123.45",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sku,
      name: "Edited name",
      description: "Edited description",
      category: "Edited category",
      barcode,
      imageUrl: "https://cdn.example.test/p.png",
      unitOfMeasure: "box",
      price: "12345",
    });
    const row = await tenantDb().product.findUniqueOrThrow({ where: { id: productId } });
    expect(row).toMatchObject({ sku, barcode, unitOfMeasure: "box", price: 12345n });

    const cleared = await patch(productId, { description: null, barcode: null });
    expect(cleared.json()).toMatchObject({ description: null, barcode: null });
  });

  it("sku and barcode stay unique — 409, and the product is unchanged", async () => {
    const first = await createProduct(tenantDb(), { price: 100n });
    const second = await createProduct(tenantDb(), { price: 100n });
    const barcode = uniq("BC");
    expect((await patch(first, { barcode })).statusCode).toBe(200);
    const firstSku = (await tenantDb().product.findUniqueOrThrow({ where: { id: first } })).sku;

    const skuClash = await patch(second, { sku: firstSku });
    expect(skuClash.statusCode).toBe(409);
    expect(skuClash.json()).toMatchObject({ statusCode: 409, error: "Conflict" });
    expect(skuClash.json<{ message: string }>().message).toMatch(/sku/);
    const barcodeClash = await patch(second, { barcode });
    expect(barcodeClash.statusCode).toBe(409);
    expect(barcodeClash.json<{ message: string }>().message).toMatch(/barcode/);
    const row = await tenantDb().product.findUniqueOrThrow({ where: { id: second } });
    expect(row.sku).not.toBe(firstSku);
    expect(row.barcode).toBeNull();
  });

  it("an unknown product is 404; a cashier may not edit (403); an empty edit is 400", async () => {
    expect((await patch("00000000-0000-0000-0000-000000000000", { name: "x" })).statusCode).toBe(404);
    const productId = await createProduct(tenantDb(), { price: 100n });
    const cashierToken = await accessTokenFor(app, cashier);
    expect((await patch(productId, { name: "x" }, cashierToken)).statusCode).toBe(403);
    expect((await patch(productId, {})).statusCode).toBe(400);
  });
});

describe("COST PRICE IS NOT A REVALUATION", () => {
  it("editing costPrice leaves stockValue, avgCost, stockCount, GL 1200, the journal and the movements untouched", async () => {
    // 17 @ 140.00 and 10 @ 50.00: a non-dividing average, so a revaluation would show.
    const productId = await createProduct(tenantDb(), { price: 50000n, costPrice: 14000n, taxClass: "ZERO_RATED" });
    await receiveStock(tenantDb(), supplierId, [{ productId, quantity: "17", unitCost: 14000n }]);
    await receiveStock(tenantDb(), supplierId, [{ productId, quantity: "10", unitCost: 5000n }]);
    const before = await tenantDb().product.findUniqueOrThrow({ where: { id: productId } });
    expect(before.stockValue).toBe(288000n);
    const gl1200Before = await glNet(schema, "1200");
    const countsBefore = await counts();

    const response = await patch(productId, { costPrice: "999.99" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ costPrice: "99999" });

    const after = await tenantDb().product.findUniqueOrThrow({ where: { id: productId } });
    expect(after.costPrice).toBe(99999n);
    expect(after.stockValue).toBe(before.stockValue);
    expect(after.avgCost).toBe(before.avgCost);
    expect(after.stockCount.toString()).toBe(before.stockCount.toString());
    expect(await glNet(schema, "1200")).toBe(gl1200Before);
    expect(await counts()).toEqual(countsBefore);
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
  });

  it("a selling-price edit is forward-only: the earlier sale line keeps its price", async () => {
    const productId = await stockedProduct("5", 1000n);
    const first = await sell(productId, "1", "500.00");
    expect((await patch(productId, { price: "650.00" })).statusCode).toBe(200);
    const second = await sell(productId, "1", "650.00");
    const lines = await tenantDb().saleLine.findMany({ where: { saleId: { in: [first.id, second.id] } } });
    const priceOf = (saleId: string) => lines.find((line) => line.saleId === saleId)?.unitPrice;
    expect(priceOf(first.id)).toBe(50000n);
    expect(priceOf(second.id)).toBe(65000n);
  });
});

describe("deactivation", () => {
  it("a deactivated product cannot be sold or restocked; its stock stays owned and valued", async () => {
    const productId = await stockedProduct("4", 2500n);
    const valueBefore = (await tenantDb().product.findUniqueOrThrow({ where: { id: productId } })).stockValue;

    const deactivated = await app.inject({
      method: "POST",
      url: `/v1/products/${productId}/deactivate`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ isActive: false, stockValue: valueBefore.toString() });

    await expect(sell(productId, "1", "500.00")).rejects.toThrow(/inactive|deactivated/i);
    await expect(
      recordStockMovement(tenantDb(), {
        productId,
        movementType: "ADJUSTMENT_INCREASE",
        quantity: "1",
        unitCost: 2500n,
        createdBy: actorId(),
      }),
    ).rejects.toThrow(/deactivated: it cannot be sold or restocked/);
    await expect(receiveStock(tenantDb(), supplierId, [{ productId, quantity: "1", unitCost: 2500n }])).rejects.toThrow();

    // Still owned, still valued, still in the identity — and it can still be moved OUT.
    expect((await tenantDb().product.findUniqueOrThrow({ where: { id: productId } })).stockValue).toBe(valueBefore);
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
    await recordStockMovement(tenantDb(), { productId, movementType: "ADJUSTMENT_DECREASE", quantity: "1", createdBy: actorId() });
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
  });

  it("reactivation restores selling", async () => {
    const productId = await stockedProduct("2", 1000n);
    const headers = { authorization: `Bearer ${ownerToken}` };
    await app.inject({ method: "POST", url: `/v1/products/${productId}/deactivate`, headers });
    expect((await app.inject({ method: "POST", url: `/v1/products/${productId}/deactivate`, headers })).statusCode).toBe(409);
    const reactivated = await app.inject({ method: "POST", url: `/v1/products/${productId}/reactivate`, headers });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json()).toMatchObject({ isActive: true });
    const sale = await sell(productId, "1", "500.00");
    expect(sale.status).toBe("COMPLETED");
  });

  it("after every catalog edit above, Σ stockValue = GL(1200) still holds", async () => {
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
  });
});
