// ===========================================================================
// "BELOW REORDER" MEANS THE SAME THING EVERYWHERE (Task T-B-REORDER-FILTER).
//
// The stock list's belowReorder flag and the dashboard's low-stock feed (getLowStockAlerts) use
// one rule: an ACTIVE product, a threshold ABOVE zero, and stock AT OR BELOW it. A threshold of
// zero raises nothing — before the fix every service and every never-stocked product read
// "below reorder" in the stock list while the dashboard (rightly) ignored them.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLowStockAlerts } from "../../src/services/allocation";
import { deactivateProduct } from "../../src/services/catalog";
import { getStockLevels, recordStockMovement } from "../../src/services/inventory";
import { dropTenant, provisionFixture, tenantDb } from "../setup/tenant";
import { actorId, uniq } from "../support/fixtures";

const TENANT = "qa-reorder";
const ids: Record<string, string> = {};

beforeAll(async () => {
  await dropTenant(TENANT);
  await provisionFixture(TENANT, "QA Reorder");
  const db = tenantDb(TENANT);
  const product = async (key: string, kind: "GOOD" | "SERVICE", threshold: number, stock: number) => {
    const row = await db.product.create({
      data: { sku: uniq(key), name: key, costPrice: 1000n, price: 2000n, kind, minStockThreshold: threshold },
    });
    if (stock > 0) {
      await recordStockMovement(db, { productId: row.id, movementType: "OPENING_BALANCE", quantity: stock.toString(), unitCost: 1000n, createdBy: actorId() });
    }
    ids[key] = row.id;
  };
  await product("service-zero", "SERVICE", 0, 0);
  await product("good-never-stocked", "GOOD", 0, 0);
  await product("good-low", "GOOD", 10, 4);
  await product("good-at-level", "GOOD", 5, 5);
  await product("good-plenty", "GOOD", 5, 50);
  await product("good-retired", "GOOD", 10, 2);
  await deactivateProduct(db, ids["good-retired"] ?? "");
});

afterAll(async () => {
  await dropTenant(TENANT);
});

describe("the stock list's below-reorder filter", () => {
  it("flags only active products at or below a real (> 0) reorder level", async () => {
    const rows = await getStockLevels(tenantDb(TENANT), { belowReorderOnly: true });
    expect(rows.map((row) => row.name).sort()).toEqual(["good-at-level", "good-low"]);
  });

  it("never flags a zero threshold — a service or a never-stocked good", async () => {
    const all = await getStockLevels(tenantDb(TENANT), {});
    const flag = (name: string) => all.find((row) => row.name === name)?.belowReorder;
    expect(flag("service-zero")).toBe(false);
    expect(flag("good-never-stocked")).toBe(false);
    expect(flag("good-retired")).toBe(false);
    expect(flag("good-plenty")).toBe(false);
  });

  it("agrees with the dashboard's low-stock feed", async () => {
    const db = tenantDb(TENANT);
    const listed = (await getStockLevels(db, { belowReorderOnly: true })).map((row) => row.productId).sort();
    const alerted = [...new Set((await getLowStockAlerts(db)).map((alert) => alert.productId))].sort();
    expect(listed).toEqual(alerted);
    expect(listed).toHaveLength(2);
  });
});
