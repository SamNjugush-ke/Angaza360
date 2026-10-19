import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import {
  assertValidSchemaName,
  assertValidSubdomain,
  tenantSchemaName,
} from "../db/tenant";
import { loadTenantMigrations } from "../db/migrations";
import { seedChartOfAccounts } from "./chart-of-accounts";
import { seedStatutorySchedule } from "./statutory-schedules";
import type {
  SubscriptionTier,
  TenantIsolationTier,
} from "../generated/platform/enums";

export interface ProvisionTenantInput {
  name: string;
  subdomain: string;
  businessSector?: string;
  kraPin?: string;
  subscriptionTier?: SubscriptionTier;
  isolationTier?: TenantIsolationTier;
}

export interface ProvisionTenantResult {
  tenantId: string;
  schema: string;
  created: boolean;
  migrationsApplied: string[];
  accountsSeeded: number;
  statutorySchedulesSeeded: number;
  locationsSeeded: number;
  locationStockBackfilled: number;
}

// Seeds the single default "Main" location into a tenant schema. Idempotent via
// ON CONFLICT (code). Returns rows inserted (1 on first run, 0 thereafter). The
// partial unique index in migration 0007 guarantees at most one isDefault row,
// and the one in 0013 guarantees at most one MAIN.
//
// type and isOfflineCapable are stated EXPLICITLY rather than left to the column
// defaults (Task 10.2). The `type` column defaults to POS — the type an admin
// most often creates — so an unqualified insert here would seed the
// authoritative pool as a till and be rejected by the location_default_is_main
// CHECK. It is also seeded as never-offline: MAIN is the server-held pool, so it
// is the one location that can never be a device that goes dark holding stock.
async function seedDefaultLocation(client: PoolClient, schema: string): Promise<number> {
  assertValidSchemaName(schema);
  const result = await client.query(
    `INSERT INTO "${schema}"."locations"
       ("id", "name", "code", "type", "isDefault", "isActive", "isOfflineCapable",
        "createdAt", "updatedAt")
     VALUES ($1, 'Main', 'MAIN', 'MAIN', true, true, false, now(), now())
     ON CONFLICT ("code") DO NOTHING`,
    [randomUUID()],
  );
  return result.rowCount ?? 0;
}

// Projects every product's EXISTING tenant-wide stockCount into the new
// per-location ownership table, owned by the tenant's MAIN location (Task 10.1,
// migration 0011). Idempotent via ON CONFLICT on (productId, locationId).
// Returns rows inserted (all products on the first run, 0 thereafter).
//
// WHY THIS IS NOT A STOCK MOVEMENT: these are not new movements. The stock
// already exists and was already recorded, valued and posted to the ledger when
// it first arrived. This step only populates the current-balance PROJECTION for
// stock that is already there — so it writes no stock_movements row, posts no
// journal entry, and changes no Product.stockCount. Recording it as a movement
// would double-count the stock and break sum(stockValue) = GL(1200).
//
// Every product gets a MAIN row, including zero-stock products, so the invariant
// stockCount = SUM(location quantities) holds uniformly rather than relying on
// "no rows means zero".
async function backfillMainLocationStock(client: PoolClient, schema: string): Promise<number> {
  assertValidSchemaName(schema);
  const result = await client.query(
    `INSERT INTO "${schema}"."product_location_stock"
       ("id", "productId", "locationId", "quantity", "createdAt", "updatedAt")
     SELECT gen_random_uuid(), p."id", l."id", p."stockCount", now(), now()
     FROM "${schema}"."products" p
     CROSS JOIN (SELECT "id" FROM "${schema}"."locations" WHERE "isDefault" = true LIMIT 1) l
     ON CONFLICT ("productId", "locationId") DO NOTHING`,
  );
  return result.rowCount ?? 0;
}

// NOTE (multi-location, G.2): pre-0007 stock movements keep locationId = NULL,
// which is DEFINED to mean the default (MAIN) location. Those rows were created
// before locations existed and are MAIN movements by definition — a fact, not
// data to mutate. They are NOT backfilled: stock_movements are immutable, and
// weakening that trigger to permit a one-time UPDATE is forbidden. Every
// movement created from 0007 onward carries an explicit locationId, so no new
// NULL row is ever produced. Reads that group/filter by location COALESCE NULL
// to MAIN.

interface TenantRegistryRow {
  id: string;
  dbSchema: string;
}

// Creates the tenant schema (if absent), ensures the per-schema migration
// ledger exists, and applies every not-yet-applied tenant migration in order.
// Runs entirely inside the caller's open transaction against the caller's
// checked-out client. Returns the names of migrations applied this call.
async function applyTenantMigrations(
  client: PoolClient,
  schema: string,
): Promise<string[]> {
  assertValidSchemaName(schema);

  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

  await client.query(
    `CREATE TABLE IF NOT EXISTS "${schema}"."_tenant_migrations" (
       id         SERIAL PRIMARY KEY,
       name       TEXT NOT NULL UNIQUE,
       checksum   TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const appliedResult = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM "${schema}"."_tenant_migrations"`,
  );
  const appliedByName = new Map<string, string>();
  for (const row of appliedResult.rows) {
    appliedByName.set(row.name, row.checksum);
  }

  const migrations = loadTenantMigrations();
  const applied: string[] = [];

  for (const migration of migrations) {
    const existingChecksum = appliedByName.get(migration.name);

    if (existingChecksum !== undefined) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(
          `Tenant migration "${migration.name}" was already applied to schema "${schema}" with a different checksum (recorded ${existingChecksum}, current ${migration.checksum}). An edited applied migration is a correctness hazard and must never be re-run.`,
        );
      }
      continue;
    }

    // search_path is transaction-scoped (SET LOCAL); the migration SQL uses
    // unqualified table names and lands in this tenant's schema.
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO "${schema}"."_tenant_migrations" ("name", "checksum") VALUES ($1, $2)`,
      [migration.name, migration.checksum],
    );
    applied.push(migration.name);
  }

  // Never leave the connection pointed at a tenant schema for subsequent
  // registry writes on this transaction.
  await client.query(`SET LOCAL search_path TO "public"`);

  return applied;
}

export async function provisionTenant(
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  assertValidSubdomain(input.subdomain);
  const schema = tenantSchemaName(input.subdomain);
  assertValidSchemaName(schema);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialise concurrent provisioning of the same tenant. The lock is held
    // until the transaction ends (commit or rollback).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [schema]);

    const existing = await client.query<TenantRegistryRow>(
      `SELECT "id", "dbSchema" FROM public.tenants WHERE "subdomain" = $1`,
      [input.subdomain],
    );

    let tenantId: string;
    let created: boolean;

    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      tenantId = randomUUID();
      created = true;

      const isolationTier: TenantIsolationTier =
        input.isolationTier ?? "SHARED_POOL";
      const subscriptionTier: SubscriptionTier =
        input.subscriptionTier ?? "MWANZO";

      await client.query(
        `INSERT INTO public.tenants
           ("id", "name", "subdomain", "businessSector", "kraPin", "dbSchema",
            "isolationTier", "subscriptionTier", "status", "createdAt", "updatedAt")
         VALUES
           ($1, $2, $3, $4, $5, $6,
            $7::"TenantIsolationTier", $8::"SubscriptionTier",
            'PENDING_PROVISIONING'::"TenantStatus", now(), now())`,
        [
          tenantId,
          input.name,
          input.subdomain,
          input.businessSector ?? null,
          input.kraPin ?? null,
          schema,
          isolationTier,
          subscriptionTier,
        ],
      );
    } else {
      tenantId = existingRow.id;
      created = false;

      if (existingRow.dbSchema !== schema) {
        throw new Error(
          `Registry corruption: tenant "${input.subdomain}" has dbSchema "${existingRow.dbSchema}" but the derived schema is "${schema}". Refusing to silently repair.`,
        );
      }
    }

    const migrationsApplied = await applyTenantMigrations(client, schema);

    // Seed the chart of accounts INSIDE the same transaction, after migrations
    // and before the tenant goes ACTIVE. A tenant must never reach ACTIVE
    // without a chart of accounts for the ledger to post against.
    const accountsSeeded = await seedChartOfAccounts(client, schema);

    // Seed the Kenyan statutory ruleset (Task 8.1) in the same transaction and by
    // the same platform-run mechanism as the chart. A statutory figure is the law,
    // not tenant configuration: every MSME must compute a given month on the SAME
    // bands, so the ruleset arrives with provisioning rather than being typed in.
    // Idempotent, keyed on the schedule label.
    const statutorySchedulesSeeded = await seedStatutorySchedule(client, schema);

    // Seed the default "Main" location so every stock movement can be stamped
    // with one. A fresh tenant has no movements yet, so no backfill is needed.
    const locationsSeeded = await seedDefaultLocation(client, schema);

    // Project existing stock into per-location ownership (Task 10.1). A fresh
    // tenant has no products yet, so this inserts nothing; it matters for
    // tenants that already traded before migration 0011.
    const locationStockBackfilled = await backfillMainLocationStock(client, schema);

    await client.query(
      `UPDATE public.tenants SET "status" = 'ACTIVE'::"TenantStatus", "updatedAt" = now() WHERE "id" = $1`,
      [tenantId],
    );

    await client.query("COMMIT");

    return {
      tenantId,
      schema,
      created,
      migrationsApplied,
      accountsSeeded,
      statutorySchedulesSeeded,
      locationsSeeded,
      locationStockBackfilled,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      // The connection may already be aborted; the original error is what
      // matters and is rethrown below.
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to provision tenant "${input.subdomain}": ${reason}`,
    );
  } finally {
    client.release();
  }
}

export interface MigrateTenantResult {
  subdomain: string;
  schema: string;
  applied: string[];
  accountsSeeded: number;
  statutorySchedulesSeeded: number;
  locationsSeeded: number;
  locationStockBackfilled: number;
  error?: string;
}

// Rolls the latest tenant datamodel out to every ACTIVE tenant. Each tenant is
// migrated in its own transaction; a failure on one tenant is captured and
// reported but does not abort the remaining tenants.
export async function migrateAllTenants(): Promise<MigrateTenantResult[]> {
  const client = await pool.connect();
  let tenants: Array<{ subdomain: string; dbSchema: string }>;
  try {
    const result = await client.query<{ subdomain: string; dbSchema: string }>(
      `SELECT "subdomain", "dbSchema" FROM public.tenants WHERE "status" = 'ACTIVE'::"TenantStatus" ORDER BY "subdomain"`,
    );
    tenants = result.rows;
  } finally {
    client.release();
  }

  const results: MigrateTenantResult[] = [];

  for (const tenant of tenants) {
    const schema = tenant.dbSchema;
    const perTenant = await pool.connect();
    try {
      assertValidSchemaName(schema);

      await perTenant.query("BEGIN");
      await perTenant.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        schema,
      ]);
      const applied = await applyTenantMigrations(perTenant, schema);
      // New tenant migrations (e.g. the accounts table) roll out to existing
      // tenants here; seed any missing default accounts in the same
      // transaction. Idempotent, so already-seeded tenants add zero.
      const accountsSeeded = await seedChartOfAccounts(perTenant, schema);
      // Statutory ruleset (0021): roll the seeded schedule out to existing tenants
      // here, so a statutory update is ONE dated operation across every tenant
      // rather than a per-tenant edit. Idempotent; adds zero on later runs.
      const statutorySchedulesSeeded = await seedStatutorySchedule(perTenant, schema);
      // Location dimension (0007): ensure the default MAIN location exists.
      // Idempotent. Historical location-less movements are NOT touched — NULL
      // locationId is defined to mean MAIN (see seedDefaultLocation's note).
      const locationsSeeded = await seedDefaultLocation(perTenant, schema);
      // Per-location ownership (0011): project each product's existing
      // tenant-wide stockCount onto MAIN so the aggregate invariant holds from
      // the moment the table exists. Idempotent; adds zero on later runs.
      const locationStockBackfilled = await backfillMainLocationStock(perTenant, schema);
      await perTenant.query("COMMIT");

      results.push({
        subdomain: tenant.subdomain,
        schema,
        applied,
        accountsSeeded,
        statutorySchedulesSeeded,
        locationsSeeded,
        locationStockBackfilled,
      });
    } catch (error) {
      await perTenant.query("ROLLBACK").catch(() => {
        // See provisionTenant: the original error is what we report.
      });
      const reason = error instanceof Error ? error.message : String(error);
      results.push({
        subdomain: tenant.subdomain,
        schema,
        applied: [],
        accountsSeeded: 0,
        statutorySchedulesSeeded: 0,
        locationsSeeded: 0,
        locationStockBackfilled: 0,
        error: reason,
      });
    } finally {
      perTenant.release();
    }
  }

  return results;
}
