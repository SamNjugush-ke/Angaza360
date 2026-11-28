// ===========================================================================
// SERVICE / NON-STOCK PRODUCTS (Task T-A8, tenant migration 0027).
//
// * A SERVICE sale posts revenue + output VAT and NOTHING on the cost side: no stock
//   movement, no COGS, GL 1200 untouched, and the entry still balances (binding).
// * On a Turnover Tax tenant a service line is turnover like any other: TOT accrues on it.
// * A MIXED GOOD + SERVICE sale keeps Σ stockValue = GL(1200); its void returns only the
//   goods (one SALE_RETURN) and takes back only their cost.
// * The inventory service refuses ANY stock movement for a service, and the
//   `product_service_carries_no_stock` CHECK refuses giving one stock from raw SQL; the
//   kind is frozen once created. Each with a control.
// * The T-A1 fixture now provisions 27/27 tenant migrations.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { loadTenantMigrations } from "../../src/db/migrations";
import { buildServer } from "../../src/server";
import { recordStockMovement } from "../../src/services/inventory";
import { recordSale, voidSale } from "../../src/services/sales";
import { dropTenant, EXPECTED_TENANT_MIGRATIONS, provisionFixture, schemaOf, tenantDb, withTenantTx, FIXTURE_SUBDOMAIN } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import {
  actorId,
  createProduct,
  createSupplier,
  entryAccounts,
  entryNet,
  glNet,
  openTill,
  receiveStock,
  sumStockValue,
  uniq,
} from "../support/fixtures";
import { accessTokenFor, createFixtureUser, deleteUsers, type TestUser } from "../security/http-app";

const schema = schemaOf();
const TOT_TENANT = "qa-service-tot";

let app: FastifyInstance;
let owner: TestUser;
let supplierId = "";

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  owner = await createFixtureUser("MSME_OWNER");
  supplierId = await createSupplier(tenantDb());
});

afterAll(async () => {
  await deleteUsers([owner]);
  await dropTenant(TOT_TENANT);
  await app.close();
});

async function createService(price: bigint, subdomain: string = FIXTURE_SUBDOMAIN): Promise<string> {
  const product = await tenantDb(subdomain).product.create({
    data: { sku: uniq("SVC"), name: uniq("Service"), costPrice: 0n, price, kind: "SERVICE" },
  });
  return product.id;
}

async function movementCount(tenantSchema: string = schema): Promise<number> {
  const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tenantSchema}".stock_movements`);
  return result.rows[0]?.n ?? -1;
}

async function entryCount(tenantSchema: string = schema): Promise<number> {
  const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tenantSchema}".journal_entries`);
  return result.rows[0]?.n ?? -1;
}

async function entryBalances(entryId: string, tenantSchema: string = schema): Promise<{ debit: string; credit: string }> {
  const result = await pool.query<{ debit: string; credit: string }>(
    `SELECT SUM("debit")::text AS debit, SUM("credit")::text AS credit FROM "${tenantSchema}".journal_lines WHERE "entryId" = $1`,
    [entryId],
  );
  return result.rows[0] ?? { debit: "?", credit: "!" };
}

describe("the fixture", () => {
  it("provisions every tenant migration, 0027_product_kind among them", async () => {
    expect(EXPECTED_TENANT_MIGRATIONS).toBeGreaterThanOrEqual(27);
    const onDisk = loadTenantMigrations();
    expect(onDisk).toHaveLength(EXPECTED_TENANT_MIGRATIONS);
    expect(onDisk.map((migration) => migration.name)).toContain("0027_product_kind");
    const applied = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}"."_tenant_migrations"`);
    expect(applied.rows[0]?.n).toBe(EXPECTED_TENANT_MIGRATIONS);
    const kindColumn = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'products' AND column_name = 'kind'`,
      [schema],
    );
    expect(kindColumn.rowCount).toBe(1);
  });
});

describe("a SERVICE sale", () => {
  it("posts revenue + output VAT with NO COGS, NO stock movement and NO change to GL 1200 — and balances", async () => {
    const serviceId = await createService(100000n); // 1,000.00, standard-rated, VAT-registered fixture
    const gl1200Before = await glNet(schema, "1200");
    const movementsBefore = await movementCount();
    const entriesBefore = await entryCount();

    const till = await openTill(tenantDb());
    const sale = await recordSale(tenantDb(), {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines: [{ productId: serviceId, quantity: "1" }],
      tenders: [{ tenderType: "CASH", amount: "1160.00" }],
    });

    expect(sale).toMatchObject({ subtotal: 100000n, vatTotal: 16000n, total: 116000n, cogsTotal: 0n });
    const line = await tenantDb().saleLine.findFirstOrThrow({ where: { saleId: sale.id } });
    expect(line).toMatchObject({ lineCogs: 0n, unitCogs: 0n, taxCode: "B", lineVat: 16000n });

    expect(await movementCount()).toBe(movementsBefore);
    expect(await glNet(schema, "1200")).toBe(gl1200Before);
    // Exactly ONE entry — the revenue entry — and it touches no cost account.
    expect(await entryCount()).toBe(entriesBefore + 1);
    const entryId = sale.saleJournalEntryId ?? "";
    expect(await entryAccounts(schema, entryId)).toEqual(["1000", "2100", "4000"]);
    expect(await entryNet(schema, entryId, "4000")).toBe(-100000n);
    expect(await entryNet(schema, entryId, "2100")).toBe(-16000n);
    const totals = await entryBalances(entryId);
    expect(totals.debit).toBe(totals.credit);
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
  });

  it("on a Turnover Tax tenant, a service line is turnover: TOT accrues on it, and no VAT", async () => {
    await dropTenant(TOT_TENANT);
    await provisionFixture(TOT_TENANT, "QA Service TOT"); // provisioning seeds TURNOVER_TAX
    const totSchema = schemaOf(TOT_TENANT);
    const serviceId = await createService(100000n, TOT_TENANT);
    const till = await openTill(tenantDb(TOT_TENANT));
    const sale = await recordSale(tenantDb(TOT_TENANT), {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines: [{ productId: serviceId, quantity: "1" }],
      tenders: [{ tenderType: "CASH", amount: "1000.00" }],
    });
    expect(sale).toMatchObject({ subtotal: 100000n, vatTotal: 0n, cogsTotal: 0n });
    expect(sale.totAccrued).toBeGreaterThan(0n);
    const entryId = sale.saleJournalEntryId ?? "";
    expect(await entryNet(totSchema, entryId, "2110")).toBe(-sale.totAccrued);
    expect(await entryAccounts(totSchema, entryId)).toEqual(["1000", "2110", "4000", "6110"]);
    expect(await movementCount(totSchema)).toBe(0);
  });
});

describe("a MIXED GOOD + SERVICE sale", () => {
  it("keeps Σ stockValue = GL(1200), and its void returns only the goods' cost", async () => {
    const goodId = await createProduct(tenantDb(), { price: 50000n, taxClass: "ZERO_RATED" });
    await receiveStock(tenantDb(), supplierId, [{ productId: goodId, quantity: "3", unitCost: 20000n }]);
    const serviceId = await createService(30000n);
    const gl1200Before = await glNet(schema, "1200");
    const goodBefore = await tenantDb().product.findUniqueOrThrow({ where: { id: goodId } });

    const till = await openTill(tenantDb());
    const sale = await recordSale(tenantDb(), {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines: [
        { productId: goodId, quantity: "1" },
        { productId: serviceId, quantity: "1" },
      ],
      // 500.00 zero-rated good + 300.00 standard-rated service (+16% = 48.00)
      tenders: [{ tenderType: "CASH", amount: "848.00" }],
    });
    expect(sale.cogsTotal).toBe(20000n);
    expect(await glNet(schema, "1200")).toBe(gl1200Before - 20000n);
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));

    const movementsBefore = await movementCount();
    await voidSale(tenantDb(), sale.id, "T-A8 mixed void", actorId());
    const returns = await pool.query<{ productId: string }>(
      `SELECT "productId" FROM "${schema}".stock_movements WHERE "movementType" = 'SALE_RETURN' AND "reference" = $1`,
      [`void ${sale.saleNumber}`],
    );
    expect(returns.rows.map((row) => row.productId)).toEqual([goodId]);
    expect(await movementCount()).toBe(movementsBefore + 1);
    expect(await glNet(schema, "1200")).toBe(gl1200Before);
    const goodAfter = await tenantDb().product.findUniqueOrThrow({ where: { id: goodId } });
    expect(goodAfter.stockValue).toBe(goodBefore.stockValue);
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
  });
});

describe("a SERVICE carries no stock", () => {
  it("the inventory service refuses ANY stock movement for it; a GOOD is the control", async () => {
    const serviceId = await createService(1000n);
    await expect(
      recordStockMovement(tenantDb(), { productId: serviceId, movementType: "ADJUSTMENT_INCREASE", quantity: "1", unitCost: 100n, createdBy: actorId() }),
    ).rejects.toThrow(/is a SERVICE and carries no stock/);
    await expect(receiveStock(tenantDb(), supplierId, [{ productId: serviceId, quantity: "1", unitCost: 100n }])).rejects.toThrow(
      /SERVICE and carries no stock/,
    );
    const goodId = await createProduct(tenantDb(), { price: 1000n });
    await recordStockMovement(tenantDb(), { productId: goodId, movementType: "ADJUSTMENT_INCREASE", quantity: "1", unitCost: 100n, createdBy: actorId() });
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
  });

  it("the CHECK refuses giving a SERVICE stock from raw SQL; the same write on a GOOD is accepted", async () => {
    const serviceId = await createService(1000n);
    const goodId = await createProduct(tenantDb(), { price: 1000n });
    const giveStock = (client: PoolClient, tenantSchema: string, id: string) =>
      client.query(`UPDATE "${tenantSchema}".products SET "stockCount" = 1, "stockValue" = 500, "avgCost" = 500 WHERE "id" = $1`, [id]);
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await giveStock(client, tenantSchema, goodId);
    });
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(giveStock(client, tenantSchema, serviceId), {
        constraint: "product_service_carries_no_stock",
        code: "23514",
      });
    });
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(
        client.query(
          `INSERT INTO "${tenantSchema}".products ("id", "sku", "name", "costPrice", "price", "kind", "batchTracked", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, 'svc', 0, 0, 'SERVICE', true, now())`,
          [uniq("SVC")],
        ),
        { constraint: "product_service_carries_no_stock" },
      );
    });
  });

  it("a product's kind is frozen once created", async () => {
    const goodId = await createProduct(tenantDb(), { price: 1000n });
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(client.query(`UPDATE "${tenantSchema}".products SET "kind" = 'SERVICE' WHERE "id" = $1`, [goodId]), {
        fn: "product_kind_guard",
        message: /fixed once created/,
      });
    });
  });

  it("POST /v1/products creates a SERVICE with no stock", async () => {
    const token = await accessTokenFor(app, owner);
    const response = await app.inject({
      method: "POST",
      url: "/v1/products",
      headers: { authorization: `Bearer ${token}` },
      payload: { sku: uniq("SVC"), name: "Delivery", costPrice: "0.00", price: "250.00", kind: "SERVICE" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ kind: "SERVICE", stockCount: "0", stockValue: "0", avgCost: "0" });
  });
});
