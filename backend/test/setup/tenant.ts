// ===========================================================================
// Tenant helpers for the regression suite (Task T-A1).
//
// Every tenant the suite uses is provisioned through the REAL path —
// `provisionTenant()` from src/services/tenant-provisioning.ts, the same function
// the CLI calls — so a test exercises the schema, every tenant migration, the chart of
// accounts, the statutory seed and the MAIN location exactly as production
// provisioning lays them down. Nothing here creates a schema by hand.
//
// Dropping uses the SAME two statements as src/scripts/drop-tenant.ts, behind the
// test-database guard.
//
// THE POOL IS NEVER CLOSED HERE. src/db/pool.ts is a module singleton shared by the
// whole run; global teardown closes it exactly once.
// ===========================================================================

import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool";
import { platformDb } from "../../src/db/platform";
import { assertValidSchemaName, getTenantDb, tenantSchemaName } from "../../src/db/tenant";
import {
  provisionTenant,
  type ProvisionTenantResult,
} from "../../src/services/tenant-provisioning";
import type { PrismaClient as TenantPrismaClient } from "../../src/generated/tenant/client";
import { assertTestDatabase } from "./guard";

/** The one shared fixture tenant every integration test file runs against. */
export const FIXTURE_SUBDOMAIN = "qa-fixture";

/** The tenant migrations in prisma/tenant/migrations: 26 at T-A1, 27 at T-A8 (0027_product_kind), 28 at T-A9 (0028_expenses), 29 since T-A13 (0029_receipt_profile). */
export const EXPECTED_TENANT_MIGRATIONS = 29;

export function provisionFixture(
  subdomain: string = FIXTURE_SUBDOMAIN,
  name: string = "QA Fixture Business",
): Promise<ProvisionTenantResult> {
  assertTestDatabase();
  return provisionTenant({ name, subdomain });
}

/**
 * Drop a tenant: its schema (CASCADE) and its registry row, in one transaction —
 * the two statements src/scripts/drop-tenant.ts runs. Idempotent: dropping a tenant
 * that does not exist removes nothing.
 */
export async function dropTenant(subdomain: string): Promise<void> {
  assertTestDatabase();
  const schema = tenantSchemaName(subdomain);
  assertValidSchemaName(schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`DELETE FROM public.tenants WHERE "subdomain" = $1`, [subdomain]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The Prisma client for a tenant, resolved the way the session layer resolves it. */
export function tenantDb(subdomain: string = FIXTURE_SUBDOMAIN): TenantPrismaClient {
  return getTenantDb(tenantSchemaName(subdomain));
}

export function schemaOf(subdomain: string = FIXTURE_SUBDOMAIN): string {
  const schema = tenantSchemaName(subdomain);
  assertValidSchemaName(schema);
  return schema;
}

export async function tenantIdOf(subdomain: string = FIXTURE_SUBDOMAIN): Promise<string> {
  const tenant = await platformDb.tenant.findUniqueOrThrow({
    where: { subdomain },
    select: { id: true },
  });
  return tenant.id;
}

export type TxOutcome = "commit" | "rollback";

/**
 * Run raw SQL inside ONE transaction on a dedicated pool connection — the tool for
 * ATTACKING a guarantee from outside the service layer.
 *
 * `rollback` (the default) always rolls back, so an adversarial write can never
 * leave a trace even if the database wrongly accepts it. To fire a DEFERRED
 * constraint trigger inside such a transaction, call `SET CONSTRAINTS ALL IMMEDIATE`
 * in `fn`. `commit` commits when `fn` succeeds and rolls back when it throws.
 */
export async function withTenantTx<T>(
  subdomain: string,
  fn: (client: PoolClient, schema: string) => Promise<T>,
  outcome: TxOutcome = "rollback",
): Promise<T> {
  assertTestDatabase();
  const schema = schemaOf(subdomain);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client, schema);
    await client.query(outcome === "commit" ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Remove a tenant that carries mentorship history, and the platform users the test
 * created for it — TEARDOWN ONLY, TEST DATABASE ONLY.
 *
 * Mentorship engagements and access logs are deliberately undeletable (append-only
 * triggers and ON DELETE RESTRICT), so a tenant that has been mentored can never be
 * dropped through the ordinary statements. To keep the test database reusable, this
 * helper runs the cleanup with `session_replication_role = replica` scoped to ONE
 * transaction (SET LOCAL), which suspends ordinary triggers for these DELETEs only.
 * It never runs during an assertion, it is behind the test-database guard, and it
 * changes no constraint or trigger definition.
 */
export async function purgeMentoredTenant(subdomain: string, userIds: readonly string[]): Promise<void> {
  assertTestDatabase();
  const schema = schemaOf(subdomain);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const tenant = await client.query<{ id: string }>(
      `SELECT "id" FROM public.tenants WHERE "subdomain" = $1`,
      [subdomain],
    );
    const tenantId = tenant.rows[0]?.id;
    if (tenantId !== undefined) {
      for (const table of [
        "mentorship_access_logs",
        "mentorship_goals",
        "mentorship_indicators",
        "mentorship_action_items",
        "mentorship_sessions",
      ]) {
        const column = table === "mentorship_access_logs" ? `"tenantId" = $1` : `"engagementId" IN (SELECT "id" FROM public.mentorship_engagements WHERE "tenantId" = $1)`;
        await client.query(`DELETE FROM public."${table}" WHERE ${column}`, [tenantId]);
      }
      await client.query(`DELETE FROM public.mentorship_engagements WHERE "tenantId" = $1`, [tenantId]);
    }
    if (userIds.length > 0) {
      await client.query(`DELETE FROM public.sessions WHERE "userId" = ANY($1::text[])`, [userIds]);
      await client.query(`DELETE FROM public.users WHERE "id" = ANY($1::text[])`, [userIds]);
    }
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`DELETE FROM public.tenants WHERE "subdomain" = $1`, [subdomain]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
