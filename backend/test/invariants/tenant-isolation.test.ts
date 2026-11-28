// ===========================================================================
// INVARIANT: schema-per-tenant isolation (the engineering ledger "Multitenant Schema Isolation
// (Absolute)" and "Raw SQL and Tenant Schema Resolution").
//
// A SECOND tenant is provisioned through the real path. Then:
//   * a client scoped to tenant A cannot see tenant B's rows (and vice versa) —
//     products and journal entries;
//   * the schema a client is bound to is the one DERIVED from the tenant registry
//     (resolveTenantContext — the session path), never a caller's string;
//   * the schema-name guard refuses every non-tenant or malformed identifier;
//   * the pool's default search_path resolves NO tenant table, so unqualified raw SQL
//     cannot silently read a tenant (it fails instead).
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool";
import { resolveTenantContext } from "../../src/auth/tenant-registry";
import { assertValidSchemaName, tenantSchemaFor, tenantSchemaName } from "../../src/db/tenant";
import { postJournalEntry } from "../../src/services/ledger";
import { FIXTURE_SUBDOMAIN, dropTenant, provisionFixture, schemaOf, tenantDb, tenantIdOf } from "../setup/tenant";
import { actorId, createProduct, uniq } from "../support/fixtures";

const B_SUBDOMAIN = "qa-isolation-b";
let productA = "";
let productB = "";
let entryB = "";
const marker = uniq("ISO");

beforeAll(async () => {
  await dropTenant(B_SUBDOMAIN);
  const provisioned = await provisionFixture(B_SUBDOMAIN, "QA Isolation Tenant B");
  expect(provisioned.created).toBe(true);
  productA = await createProduct(tenantDb(FIXTURE_SUBDOMAIN), { price: 100n, sku: `${marker}-A` });
  productB = await createProduct(tenantDb(B_SUBDOMAIN), { price: 100n, sku: `${marker}-B` });
  const entry = await postJournalEntry(tenantDb(B_SUBDOMAIN), {
    entryDate: new Date(),
    description: `${marker} tenant B only`,
    source: "MANUAL",
    createdBy: actorId(),
    lines: [
      { accountCode: "1000", debit: 777n },
      { accountCode: "3000", credit: 777n },
    ],
  });
  entryB = entry.id;
});

afterAll(async () => {
  await dropTenant(B_SUBDOMAIN);
});

describe("tenant isolation", () => {
  it("a client scoped to tenant A cannot read tenant B's rows, and vice versa", async () => {
    const a = tenantDb(FIXTURE_SUBDOMAIN);
    const b = tenantDb(B_SUBDOMAIN);
    expect(a).not.toBe(b);

    const seenByA = await a.product.findMany({ where: { sku: { startsWith: marker } }, select: { id: true } });
    const seenByB = await b.product.findMany({ where: { sku: { startsWith: marker } }, select: { id: true } });
    expect(seenByA.map((row) => row.id)).toEqual([productA]);
    expect(seenByB.map((row) => row.id)).toEqual([productB]);

    expect(await a.product.findUnique({ where: { id: productB } })).toBeNull();
    expect(await b.product.findUnique({ where: { id: productA } })).toBeNull();
    expect(await a.journalEntry.findUnique({ where: { id: entryB } })).toBeNull();
    expect(await b.journalEntry.findUnique({ where: { id: entryB } })).not.toBeNull();
  });

  it("tenant B's ledger is its own: A's GL carries none of B's posting", async () => {
    const entries = await tenantDb(FIXTURE_SUBDOMAIN).journalEntry.count({
      where: { description: { contains: marker } },
    });
    expect(entries).toBe(0);
  });

  it("the schema a client is bound to is the one DERIVED from the tenant registry", async () => {
    for (const subdomain of [FIXTURE_SUBDOMAIN, B_SUBDOMAIN]) {
      const context = await resolveTenantContext(await tenantIdOf(subdomain));
      expect(context.dbSchema).toBe(tenantSchemaName(subdomain));
      expect(context.dbSchema).toBe(schemaOf(subdomain));
      expect(tenantSchemaFor(tenantDb(subdomain))).toBe(context.dbSchema);
      expect(context.status).toBe("ACTIVE");
    }
  });

  it("the schema-name guard refuses every non-tenant or malformed identifier", () => {
    for (const hostile of [
      "public",
      "information_schema",
      "pg_catalog",
      "pg_toast",
      "tenant_",
      "Tenant_qa_fixture",
      'tenant_qa"; DROP SCHEMA public CASCADE; --',
      "tenant_qa-fixture",
      "tenant_qa fixture",
      `tenant_${"x".repeat(49)}`,
      "other_qa_fixture",
    ]) {
      expect(() => assertValidSchemaName(hostile), hostile).toThrow();
    }
    expect(() => assertValidSchemaName(schemaOf(FIXTURE_SUBDOMAIN))).not.toThrow();
    // A subdomain is normalised to the identifier pattern, so it cannot smuggle SQL.
    expect(tenantSchemaName('x"; DROP')).toBe("tenant_x___drop");
  });

  it("the pool's default search_path resolves no tenant table, so unqualified raw SQL cannot read a tenant", async () => {
    const resolved = await pool.query<{ products: string | null; journal: string | null }>(
      `SELECT to_regclass('products')::text AS products, to_regclass('journal_entries')::text AS journal`,
    );
    expect(resolved.rows[0]).toEqual({ products: null, journal: null });
  });
});
