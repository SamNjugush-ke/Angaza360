// ===========================================================================
// THE MAIN-LOCATION STOCK BACKFILL IS IDEMPOTENT (Task T-B-MIGRATOR-BACKFILL).
//
// Provisioning and migrate-all both run the Task 10.1 backfill, which projects a
// product's stockCount onto MAIN. It must touch ONLY a product with no location rows at
// all — the genuine pre-0011 case. A product stocked only at a till has no MAIN row, and
// seeding MAIN with its full stockCount on the next migrate-all DOUBLED it (found on
// angaza_dev: 8 products). After every run, stockCount == SUM(location quantities).
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordStockMovement } from "../../src/services/inventory";
import { migrateAllTenants } from "../../src/services/tenant-provisioning";
import { dropTenant, provisionFixture, tenantDb, withTenantTx } from "../setup/tenant";
import { actorId, uniq } from "../support/fixtures";

const TENANT = "qa-backfill";
let tillOnly = "";
let preLocation = "";
let mainId = "";

async function slices(productId: string): Promise<Array<{ code: string; quantity: string }>> {
  return withTenantTx(TENANT, async (client, schema) => {
    const rows = await client.query<{ code: string; quantity: string }>(
      `SELECT l."code", s."quantity"::text AS quantity FROM "${schema}"."product_location_stock" s
         JOIN "${schema}"."locations" l ON l."id" = s."locationId" WHERE s."productId" = $1 ORDER BY l."code"`,
      [productId],
    );
    return rows.rows;
  });
}

/** Products whose stockCount differs from the sum of their location rows. */
async function mismatches(): Promise<number> {
  return withTenantTx(TENANT, async (client, schema) => {
    const rows = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${schema}"."products" p
        WHERE p."stockCount" <> COALESCE((SELECT sum(s."quantity") FROM "${schema}"."product_location_stock" s WHERE s."productId" = p."id"), 0)`,
    );
    return rows.rows[0]?.n ?? -1;
  });
}

const backfilledHere = async () => (await migrateAllTenants()).find((result) => result.subdomain === TENANT)?.locationStockBackfilled;

beforeAll(async () => {
  await dropTenant(TENANT);
  await provisionFixture(TENANT, "QA Backfill");
  const db = tenantDb(TENANT);
  mainId = (await db.location.findFirstOrThrow({ where: { isDefault: true } })).id;
  const till = await db.location.create({ data: { code: "TILL-1", name: "Till 1", type: "POS" } });

  // Stocked ONLY at the till: no MAIN row exists for it.
  const a = await db.product.create({ data: { sku: uniq("TILL"), name: "Till-only good", costPrice: 1000n, price: 2000n } });
  await recordStockMovement(db, { productId: a.id, movementType: "OPENING_BALANCE", quantity: "10", unitCost: 1000n, locationId: till.id, createdBy: actorId() });
  tillOnly = a.id;

  // A pre-0011 product: stock on the product, no location rows (its projection removed).
  const b = await db.product.create({ data: { sku: uniq("PRE"), name: "Pre-location good", costPrice: 500n, price: 900n } });
  await recordStockMovement(db, { productId: b.id, movementType: "OPENING_BALANCE", quantity: "5", unitCost: 500n, createdBy: actorId() });
  await withTenantTx(TENANT, (client, schema) => client.query(`DELETE FROM "${schema}"."product_location_stock" WHERE "productId" = $1`, [b.id]), "commit");
  preLocation = b.id;
});

afterAll(async () => {
  await dropTenant(TENANT);
});

describe("the MAIN-location stock backfill", () => {
  it("never seeds MAIN for a product already projected onto another location", async () => {
    expect(await slices(tillOnly)).toEqual([{ code: "TILL-1", quantity: "10.000" }]);
    await backfilledHere();
    await backfilledHere();
    expect(await slices(tillOnly)).toEqual([{ code: "TILL-1", quantity: "10.000" }]);
    expect((await tenantDb(TENANT).product.findUniqueOrThrow({ where: { id: tillOnly } })).stockCount.toString()).toBe("10");
  });

  it("still seeds a genuine pre-location product onto MAIN — once", async () => {
    const main = await tenantDb(TENANT).location.findUniqueOrThrow({ where: { id: mainId } });
    expect(await slices(preLocation)).toEqual([{ code: main.code, quantity: "5.000" }]);
    expect(await backfilledHere()).toBe(0);
    expect(await slices(preLocation)).toEqual([{ code: main.code, quantity: "5.000" }]);
  });

  it("leaves stockCount == SUM(location quantities) for every product", async () => {
    await backfilledHere();
    expect(await mismatches()).toBe(0);
  });
});
