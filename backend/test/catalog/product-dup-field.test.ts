// ===========================================================================
// A DUPLICATE NAMES THE RIGHT FIELD (Task T-B-PRODUCT-DUP-FIELD), through the REAL app.
//
// POST /v1/products and PATCH /v1/products/:id answer a unique clash with 409 in the standard
// envelope plus `field`: "sku" or "barcode" — read from the violated constraint's fields on
// Prisma's P2002, never from message text. Before this task the create route answered ANY
// clash as a SKU clash, so a duplicate barcode was blamed on the SKU. Other errors keep the
// plain envelope.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server";
import { productUniqueClash } from "../../src/services/catalog";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";
import { uniq } from "../support/fixtures";

let app: FastifyInstance;
let owner: TestUser;
let token = "";
const sku = uniq("DUP-SKU");
const barcode = uniq("DUP-BC");

const SKU_CLASH = { statusCode: 409, error: "Conflict", message: "A product with this SKU already exists.", field: "sku" };
const BARCODE_CLASH = { statusCode: 409, error: "Conflict", message: "A product with this barcode already exists.", field: "barcode" };

function create(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/products", remoteAddress: freshIp(), headers: { authorization: `Bearer ${token}` }, payload });
}
function patch(id: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/v1/products/${id}`, remoteAddress: freshIp(), headers: { authorization: `Bearer ${token}` }, payload });
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  owner = await createFixtureUser("MSME_OWNER");
  token = await accessTokenFor(app, owner);
  expect((await create({ sku, barcode, name: "Original", costPrice: "1.00", price: "2.00" })).statusCode).toBe(201);
});

afterAll(async () => {
  await deleteUsers([owner]);
  await app.close();
});

describe("creating a duplicate", () => {
  it("a duplicate SKU is a 409 flagged sku", async () => {
    const response = await create({ sku, name: "Same SKU", costPrice: "1.00", price: "2.00" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual(SKU_CLASH);
  });

  it("a duplicate BARCODE is a 409 flagged barcode — no longer blamed on the SKU", async () => {
    const response = await create({ sku: uniq("NEW-SKU"), barcode, name: "Same barcode", costPrice: "1.00", price: "2.00" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toStrictEqual(BARCODE_CLASH);
  });
});

describe("editing into a duplicate", () => {
  it("names the SKU or the barcode, whichever clashed", async () => {
    const other = await create({ sku: uniq("OTHER"), name: "Other", costPrice: "1.00", price: "2.00" });
    const id = other.json<{ id: string }>().id;
    const skuClash = await patch(id, { sku });
    expect([skuClash.statusCode, skuClash.json()]).toStrictEqual([409, SKU_CLASH]);
    const barcodeClash = await patch(id, { barcode });
    expect([barcodeClash.statusCode, barcodeClash.json()]).toStrictEqual([409, BARCODE_CLASH]);
  });
});

describe("other errors keep the plain envelope", () => {
  it("a deactivation conflict has no field", async () => {
    const id = (await create({ sku: uniq("ONCE"), name: "Once", costPrice: "1.00", price: "2.00" })).json<{ id: string }>().id;
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "POST", url: `/v1/products/${id}/deactivate`, headers })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `/v1/products/${id}/deactivate`, headers });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toStrictEqual({ statusCode: 409, error: "Conflict", message: "The product is already deactivated." });
  });
});

describe("productUniqueClash reads the violated constraint", () => {
  it("under the pg driver adapter and under the classic engine", () => {
    const adapter = (fields: string[]) => ({ code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields } } } } });
    expect(productUniqueClash(adapter(["sku"]))).toBe("sku");
    expect(productUniqueClash(adapter(["barcode"]))).toBe("barcode");
    expect(productUniqueClash({ code: "P2002", meta: { target: ["barcode"] } })).toBe("barcode");
    expect(productUniqueClash({ code: "P2002", meta: { target: "sku" } })).toBe("sku");
  });

  it("under the pg driver adapter from Prisma 7.10, which names the violated index instead of its fields", () => {
    const adapter = (index: string) => ({ code: "P2002", meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index }, table: "products" } } } });
    expect(productUniqueClash(adapter("products_sku_key"))).toBe("sku");
    expect(productUniqueClash(adapter("products_barcode_key"))).toBe("barcode");
    expect(productUniqueClash(adapter("products_pkey"))).toBeNull();
  });

  it("is null for anything else — never a guess from message text", () => {
    expect(productUniqueClash({ code: "P2002", meta: { target: ["id"] }, message: "barcode sku" })).toBeNull();
    expect(productUniqueClash({ code: "P2025", meta: { target: ["sku"] } })).toBeNull();
    expect(productUniqueClash(new Error("duplicate sku"))).toBeNull();
  });
});
