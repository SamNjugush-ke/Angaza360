// ===========================================================================
// PRODUCT CSV IMPORT + OPENING INVENTORY (Task T-A11), over the T-A6.3 CSV framework.
//
// * The template downloads as text/csv.
// * A mixed upload previews each row correctly — including a SERVICE with opening stock, a
//   SKU repeated in the file, a SKU that already exists and a malformed price — and writes
//   nothing.
// * THE GREEN-GATE (binding): commit is refused while any row is not green, creating nothing.
// * A green commit creates the products and their OPENING INVENTORY through the
//   OPENING_BALANCE movement (Dr 1200 / Cr 3000, at MAIN), and Σ stockValue = GL(1200)
//   holds and reconciles afterwards (binding).
// * Re-committing the same file creates nothing new.
// ===========================================================================

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { buildServer } from "../../src/server";
import { buildControlReconciliation } from "../../src/services/reports";
import { csvLine } from "../../src/services/csv/parse";
import { PRODUCT_IMPORT_SCHEMA } from "../../src/services/imports/product-import";
import { schemaOf, tenantDb } from "../setup/tenant";
import { createProduct, entryNet, glNet, sumStockValue } from "../support/fixtures";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";

const schema = schemaOf();
const COLUMNS = PRODUCT_IMPORT_SCHEMA.columns.map((column) => column.name);

let app: FastifyInstance;
let manager: TestUser;
let cashier: TestUser;
let token = "";

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  manager = await createFixtureUser("MSME_MANAGER");
  cashier = await createFixtureUser("CASHIER");
  token = await accessTokenFor(app, manager);
});

afterAll(async () => {
  await deleteUsers([manager, cashier]);
  await app.close();
});

type Row = Partial<Record<(typeof COLUMNS)[number], string>>;

function csv(rows: readonly Row[]): string {
  return [csvLine(COLUMNS), ...rows.map((row) => csvLine(COLUMNS.map((c) => row[c] ?? "")))].join("\n") + "\n";
}

function post(path: "preview" | "commit", body: string, bearer: string = token) {
  return app.inject({
    method: "POST",
    url: `/v1/products/import/${path}`,
    remoteAddress: freshIp(),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "text/csv" },
    payload: body,
  });
}

const tag = () => randomUUID().slice(0, 8).toUpperCase();

interface PreviewBody {
  allGreen: boolean;
  rows: Array<{ rowNumber: number; status: string; errors: Array<{ field: string; message: string }> }>;
}

describe("the template", () => {
  it("downloads as a text/csv header naming every column", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/products/import/template", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/csv/);
    expect(response.body).toBe(`${COLUMNS.join(",")}\r\n`);
  });
});

describe("a mixed upload", () => {
  const existingSku = `QA-EXIST-${tag()}`;
  const dupSku = `QA-DUP-${tag()}`;
  let file = "";

  beforeAll(async () => {
    await createProduct(tenantDb(), { price: 100n, sku: existingSku });
    file = csv([
      { sku: `QA-OK-${tag()}`, name: "Good row", costPrice: "50.00", price: "80.00", openingQty: "4" },
      { sku: `QA-SVC-${tag()}`, name: "Service with stock", kind: "SERVICE", costPrice: "0", price: "500.00", openingQty: "1" },
      { sku: dupSku, name: "Twin A", costPrice: "1.00", price: "2.00" },
      { sku: dupSku, name: "Twin B", costPrice: "1.00", price: "2.00" },
      { sku: existingSku, name: "Already here", costPrice: "1.00", price: "2.00" },
      { sku: `QA-BAD-${tag()}`, name: "Bad price", costPrice: "1.00", price: "twelve" },
    ]);
  });

  it("previews every row correctly and writes nothing", async () => {
    const productsBefore = await tenantDb().product.count();
    const response = await post("preview", file);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PreviewBody>();
    expect(body.allGreen).toBe(false);
    const row = (n: number) => body.rows.find((r) => r.rowNumber === n);
    expect(row(1)).toMatchObject({ status: "GREEN", errors: [] });
    expect(row(2)).toMatchObject({ status: "RED", errors: [{ field: "openingQty", message: expect.stringMatching(/SERVICE carries no stock/) }] });
    expect(row(3)?.errors[0]?.message).toMatch(/more than once in the file/);
    expect(row(4)?.errors[0]?.message).toMatch(/more than once in the file/);
    expect(row(5)?.errors[0]?.message).toMatch(/already exists/);
    expect(row(6)).toMatchObject({ status: "RED", errors: [{ field: "price" }] });
    expect(await tenantDb().product.count()).toBe(productsBefore);
  });

  it("THE GREEN-GATE: commit is refused while any row is not green, and nothing is created", async () => {
    const productsBefore = await tenantDb().product.count();
    const gl1200Before = await glNet(schema, "1200");
    const response = await post("commit", file);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ message: string }>().message).toMatch(/cannot be committed while any row is not green: row 2/);
    expect(await tenantDb().product.count()).toBe(productsBefore);
    expect(await glNet(schema, "1200")).toBe(gl1200Before);
  });

  it("a cashier may not import", async () => {
    const cashierToken = await accessTokenFor(app, cashier);
    expect((await post("preview", file, cashierToken)).statusCode).toBe(403);
  });
});

describe("a green commit", () => {
  const goodSku = `QA-IMP-${tag()}`;
  const defaultCostSku = `QA-IMP-${tag()}`;
  const serviceSku = `QA-IMP-${tag()}`;
  const file = csv([
    { sku: goodSku, name: "Imported good", category: "Hardware", unitOfMeasure: "box", taxClass: "ZERO_RATED", costPrice: "40.00", price: "60.00", openingQty: "10", openingUnitCost: "50.00" },
    { sku: defaultCostSku, name: "Imported default cost", costPrice: "80.00", price: "100.00", openingQty: "2.5" },
    { sku: serviceSku, name: "Imported service", kind: "SERVICE", costPrice: "0", price: "1500.00" },
  ]);

  it("creates the products and their opening inventory; Σ stockValue = GL(1200) holds and reconciles", async () => {
    const gl1200Before = await glNet(schema, "1200");
    const gl3000Before = await glNet(schema, "3000");
    const response = await post("commit", file);
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<{ created: Array<{ sku: string; kind: string; openingStockValue: string }> }>().created;
    expect(created.map((c) => [c.sku, c.kind, c.openingStockValue])).toEqual([
      [goodSku, "GOOD", "50000"],
      [defaultCostSku, "GOOD", "20000"],
      [serviceSku, "SERVICE", "0"],
    ]);

    const good = await tenantDb().product.findUniqueOrThrow({ where: { sku: goodSku } });
    expect(good).toMatchObject({ name: "Imported good", category: "Hardware", unitOfMeasure: "box", taxClass: "ZERO_RATED", costPrice: 4000n, price: 6000n, stockValue: 50000n });
    expect(good.stockCount.toString()).toBe("10");
    const service = await tenantDb().product.findUniqueOrThrow({ where: { sku: serviceSku } });
    expect(service).toMatchObject({ kind: "SERVICE", stockValue: 0n });

    // The opening stock is an OPENING_BALANCE movement at MAIN, posted Dr 1200 / Cr 3000.
    const movement = await pool.query<{ movementType: string; totalCost: string; journalEntryId: string; code: string }>(
      `SELECT m."movementType", m."totalCost"::text AS "totalCost", m."journalEntryId", l."code"
         FROM "${schema}".stock_movements m JOIN "${schema}".locations l ON l."id" = m."locationId"
        WHERE m."productId" = $1`,
      [good.id],
    );
    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0]).toMatchObject({ movementType: "OPENING_BALANCE", totalCost: "50000", code: "MAIN" });
    const entryId = movement.rows[0]?.journalEntryId ?? "";
    expect(await entryNet(schema, entryId, "1200")).toBe(50000n);
    expect(await entryNet(schema, entryId, "3000")).toBe(-50000n);

    expect(await glNet(schema, "1200")).toBe(gl1200Before + 70000n);
    expect(await glNet(schema, "3000")).toBe(gl3000Before - 70000n);
    expect(await sumStockValue(schema)).toBe(await glNet(schema, "1200"));
    const recon = await buildControlReconciliation(tenantDb(), schema);
    const inventory = recon.items.find((item) => item.accountCode === "1200");
    expect(inventory).toMatchObject({ unexplained: 0n, reconciles: true });
  });

  it("re-committing the same file creates nothing new", async () => {
    const productsBefore = await tenantDb().product.count();
    const movementsBefore = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}".stock_movements`);
    const again = await post("commit", file);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ message: string }>().message).toMatch(/row 1 \(sku\)/);
    expect(await tenantDb().product.count()).toBe(productsBefore);
    const movementsAfter = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}".stock_movements`);
    expect(movementsAfter.rows[0]?.n).toBe(movementsBefore.rows[0]?.n);
  });
});
