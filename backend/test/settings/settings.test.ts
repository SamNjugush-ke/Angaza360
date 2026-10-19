// ===========================================================================
// BUSINESS PROFILE / BRANDING / RECEIPT SETTINGS (Task T-A13, tenant migration 0029).
//
// * THE taxRegime DUPLICATION IS RESOLVED BY MIRRORING: a regime PUT updates BOTH the
//   authoritative BusinessProfile and the registry copy on public.tenants, in one
//   transaction (BINDING — both are read back with independent SQL), and isVatRegistered
//   stays CHECK-consistent with the regime.
// * The receipt fields (profile) and branding (registry) persist and appear in the output
//   of buildReceipt; the logo is printed only while showLogoOnReceipt is true.
// * `business_profile_receipt_fields_sane` refuses a blank printed field from raw SQL.
// * Every write is owner-only; reads are open to the tenant read roles, never CASHIER.
// ===========================================================================

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { platformDb } from "../../src/db/platform";
import { buildReceipt } from "../../src/services/receipt";
import { recordSale } from "../../src/services/sales";
import { buildServer } from "../../src/server";
import { schemaOf, tenantDb, tenantIdOf, withTenantTx, FIXTURE_SUBDOMAIN } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";
import { openTill, uniq } from "../support/fixtures";
import { accessTokenFor, createFixtureUser, deleteUsers, freshIp, type TestUser } from "../security/http-app";

const schema = schemaOf();

let app: FastifyInstance;
let owner: TestUser;
let manager: TestUser;
let cashier: TestUser;
let ownerToken = "";
let managerToken = "";
let cashierToken = "";
let tenantId = "";

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  owner = await createFixtureUser("MSME_OWNER");
  manager = await createFixtureUser("MSME_MANAGER");
  cashier = await createFixtureUser("CASHIER");
  ownerToken = await accessTokenFor(app, owner);
  managerToken = await accessTokenFor(app, manager);
  cashierToken = await accessTokenFor(app, cashier);
  tenantId = await tenantIdOf();
});

afterAll(async () => {
  // Leave the shared fixture as other files expect it: VAT_REGISTERED, no receipt identity,
  // no branding.
  await inject("PUT", "/v1/settings/business-profile", ownerToken, {
    taxRegime: "VAT_REGISTERED",
    kraPin: null,
    legalName: null,
    addressLine: null,
    phone: null,
    email: null,
    receiptFooter: null,
    showLogoOnReceipt: true,
  });
  await inject("PUT", "/v1/settings/branding", ownerToken, { brandPrimaryColor: null, brandLogoUrl: null });
  await deleteUsers([owner, manager, cashier]);
  await app.close();
});

function inject(method: "GET" | "PUT", url: string, bearer: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    remoteAddress: freshIp(),
    headers: { authorization: `Bearer ${bearer}` },
    ...(payload !== undefined ? { payload } : {}),
  });
}

/** Both copies of the regime, read with independent SQL. */
async function bothRegimes(): Promise<{ profile: string; isVatRegistered: boolean; registry: string }> {
  const profile = await pool.query<{ taxRegime: string; isVatRegistered: boolean }>(
    `SELECT "taxRegime"::text AS "taxRegime", "isVatRegistered" FROM "${schema}".business_profile`,
  );
  const registry = await pool.query<{ taxRegime: string }>(`SELECT "taxRegime"::text AS "taxRegime" FROM public."tenants" WHERE "id" = $1`, [tenantId]);
  const p = profile.rows[0];
  const r = registry.rows[0];
  if (p === undefined || r === undefined) throw new Error("profile or registry row missing");
  return { profile: p.taxRegime, isVatRegistered: p.isVatRegistered, registry: r.taxRegime };
}

describe("the taxRegime mirror — both copies, one update", () => {
  it.each([
    ["TURNOVER_TAX", "TURNOVER_TAX", false],
    ["EXEMPT", "EXEMPT", false],
    ["VAT_REGISTERED", "VAT", true],
  ] as const)("a regime PUT of %s updates BusinessProfile AND public.tenants (%s)", async (regime, registry, vat) => {
    const response = await inject("PUT", "/v1/settings/business-profile", ownerToken, { taxRegime: regime });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ taxRegime: regime, isVatRegistered: vat });
    expect(await bothRegimes()).toEqual({ profile: regime, isVatRegistered: vat, registry });
  });

  it("isVatRegistered stays CHECK-consistent: a raw write that splits the pair is refused", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(
        client.query(`UPDATE "${tenantSchema}".business_profile SET "taxRegime" = 'TURNOVER_TAX', "isVatRegistered" = true`),
        { code: "23514" },
      );
    });
    // Control: the coherent pair is accepted.
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await client.query(`UPDATE "${tenantSchema}".business_profile SET "taxRegime" = 'TURNOVER_TAX', "isVatRegistered" = false`);
    });
  });

  it("a PUT that does not name the regime leaves the registry untouched", async () => {
    const before = await bothRegimes();
    const response = await inject("PUT", "/v1/settings/business-profile", ownerToken, { phone: "+254700000001" });
    expect(response.statusCode, response.body).toBe(200);
    expect(await bothRegimes()).toEqual(before);
  });
});

describe("receipt identity and branding reach the receipt", () => {
  it("persist through settings and appear in buildReceipt output", async () => {
    const profile = await inject("PUT", "/v1/settings/business-profile", ownerToken, {
      kraPin: "P051234567Q",
      legalName: "QA Fixture Traders Ltd",
      addressLine: "Moi Avenue, Nairobi",
      phone: "+254711000222",
      email: "till@qa-fixture.test",
      receiptFooter: "Asante kwa kununua!",
      showLogoOnReceipt: true,
    });
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json()).toMatchObject({ legalName: "QA Fixture Traders Ltd", receiptFooter: "Asante kwa kununua!", showLogoOnReceipt: true });

    const branding = await inject("PUT", "/v1/settings/branding", ownerToken, {
      brandPrimaryColor: "#1F7A4D",
      brandLogoUrl: "https://cdn.qa-fixture.test/logo.png",
    });
    expect(branding.statusCode, branding.body).toBe(200);
    const readBack = await inject("GET", "/v1/settings/branding", managerToken);
    expect(readBack.json()).toEqual({ brandPrimaryColor: "#1F7A4D", brandLogoUrl: "https://cdn.qa-fixture.test/logo.png" });
    const registry = await platformDb.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { brandPrimaryColor: true, brandLogoUrl: true } });
    expect(registry).toEqual({ brandPrimaryColor: "#1F7A4D", brandLogoUrl: "https://cdn.qa-fixture.test/logo.png" });

    // A service line needs no stock, so the sale exercises only the receipt.
    const service = await tenantDb().product.create({
      data: { sku: uniq("SVC"), name: uniq("Service"), costPrice: 0n, price: 10000n, taxClass: "EXEMPT", kind: "SERVICE" },
    });
    const productId = service.id;
    const till = await openTill(tenantDb());
    const sale = await recordSale(tenantDb(), {
      shiftId: till.shiftId,
      createdBy: till.cashierId,
      lines: [{ productId, quantity: "1" }],
      tenders: [{ tenderType: "CASH", amount: "100.00" }],
    });
    const receipt = await buildReceipt(tenantDb(), sale.id, { name: "QA Fixture", subdomain: FIXTURE_SUBDOMAIN, kraPin: "REGISTRY-PIN" });
    expect(receipt).not.toBeNull();
    expect(receipt?.business).toEqual({
      name: "QA Fixture",
      subdomain: FIXTURE_SUBDOMAIN,
      kraPin: "P051234567Q",
      legalName: "QA Fixture Traders Ltd",
      addressLine: "Moi Avenue, Nairobi",
      phone: "+254711000222",
      email: "till@qa-fixture.test",
      brandPrimaryColor: "#1F7A4D",
      logoUrl: "https://cdn.qa-fixture.test/logo.png",
    });
    expect(receipt?.footer).toBe("Asante kwa kununua!");

    // Turning the logo off removes it from the receipt; the colour stays.
    await inject("PUT", "/v1/settings/business-profile", ownerToken, { showLogoOnReceipt: false });
    const noLogo = await buildReceipt(tenantDb(), sale.id, { name: "QA Fixture", subdomain: FIXTURE_SUBDOMAIN, kraPin: null });
    expect(noLogo?.business).toMatchObject({ logoUrl: null, brandPrimaryColor: "#1F7A4D" });
  });

  it("validates: a bad colour, a non-https logo and an empty branding body are 400", async () => {
    for (const payload of [{ brandPrimaryColor: "green" }, { brandLogoUrl: "http://insecure.test/logo.png" }, {}]) {
      const response = await inject("PUT", "/v1/settings/branding", ownerToken, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const blank = await inject("PUT", "/v1/settings/business-profile", ownerToken, { receiptFooter: "   " });
    expect(blank.statusCode).toBe(400);
  });

  it("the CHECK refuses a blank printed field from raw SQL; a real value is accepted", async () => {
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await expectDbRefusal(client.query(`UPDATE "${tenantSchema}".business_profile SET "receiptFooter" = '   '`), {
        constraint: "business_profile_receipt_fields_sane",
      });
    });
    await withTenantTx(FIXTURE_SUBDOMAIN, async (client, tenantSchema) => {
      await client.query(`UPDATE "${tenantSchema}".business_profile SET "receiptFooter" = 'Karibu tena'`);
    });
  });
});

describe("writes are owner-only", () => {
  it.each([
    ["PUT", "/v1/settings/business-profile", { receiptFooter: "not mine to set" }],
    ["PUT", "/v1/settings/business-profile", { taxRegime: "EXEMPT" }],
    ["PUT", "/v1/settings/branding", { brandPrimaryColor: "#000000" }],
  ] as const)("a manager and a cashier are refused %s %s", async (method, url, payload) => {
    const before = await bothRegimes();
    for (const bearer of [managerToken, cashierToken]) {
      const response = await inject(method, url, bearer, payload);
      expect(response.statusCode).toBe(403);
    }
    expect(await bothRegimes()).toEqual(before);
  });

  it("reads: a manager may read profile and branding; a cashier may not", async () => {
    expect((await inject("GET", "/v1/settings/business-profile", managerToken)).statusCode).toBe(200);
    expect((await inject("GET", "/v1/settings/branding", managerToken)).statusCode).toBe(200);
    expect((await inject("GET", "/v1/settings/business-profile", cashierToken)).statusCode).toBe(403);
    expect((await inject("GET", "/v1/settings/branding", cashierToken)).statusCode).toBe(403);
  });
});
