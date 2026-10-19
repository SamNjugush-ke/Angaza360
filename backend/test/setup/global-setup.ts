// ===========================================================================
// GLOBAL SETUP / TEARDOWN (Task T-A1).
//
// Stands the test database up through the REAL path, never a shortcut:
//   0. THE GUARD — first statement. Abort unless DATABASE_URL names a test database.
//      No application module is even imported until it has passed.
//   a. Platform migrations: `prisma migrate deploy` with the platform config, run as
//      a child process with THIS process's (test) environment. The config's own
//      `import "dotenv/config"` cannot redirect it: dotenv never overrides a variable
//      that is already set.
//   b. Drop any pre-existing qa-fixture (idempotent reruns), with the same two
//      statements src/scripts/drop-tenant.ts uses.
//   c. Provision the fixture through the real provisionTenant(), and assert the
//      result — which doubles as the provisioning happy-path smoke.
//
// Teardown drops the fixture and closes the shared pool and every tenant client
// exactly ONCE. Individual tests never close the pool.
// ===========================================================================

import { execFileSync } from "node:child_process";
import path from "node:path";
import { assertTestDatabase } from "./guard";

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

function deployPlatformMigrations(): void {
  const prismaCli = path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js");
  execFileSync(
    process.execPath,
    [prismaCli, "migrate", "deploy", "--config", "./prisma.platform.config.ts"],
    { cwd: BACKEND_ROOT, env: process.env, stdio: "pipe" },
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 0. THE GUARD. If this throws, nothing below runs.
  const databaseName = assertTestDatabase();

  // a. Platform schema.
  deployPlatformMigrations();

  const { closePool, pool } = await import("../../src/db/pool");
  const { disconnectAllTenantDbs } = await import("../../src/db/tenant");
  const { platformDb } = await import("../../src/db/platform");
  const { loadTenantMigrations } = await import("../../src/db/migrations");
  const { businessToday } = await import("../../src/lib/business-time");
  const { dropTenant, provisionFixture, schemaOf, tenantDb, FIXTURE_SUBDOMAIN, EXPECTED_TENANT_MIGRATIONS } =
    await import("./tenant");

  async function releaseConnections(): Promise<void> {
    await platformDb.$disconnect();
    await disconnectAllTenantDbs();
    await closePool();
  }

  try {
    // b. Idempotent rerun: remove whatever a previous (possibly aborted) run left.
    await dropTenant(FIXTURE_SUBDOMAIN);

    // c. Provision through the real path and hold it to its contract.
    const result = await provisionFixture();
    const onDisk = loadTenantMigrations().length;
    const failures: string[] = [];
    if (!result.created) failures.push("created was false");
    if (onDisk !== EXPECTED_TENANT_MIGRATIONS) {
      failures.push(`expected ${EXPECTED_TENANT_MIGRATIONS} tenant migrations on disk, found ${onDisk}`);
    }
    if (result.migrationsApplied.length !== EXPECTED_TENANT_MIGRATIONS) {
      failures.push(`applied ${result.migrationsApplied.length} of ${EXPECTED_TENANT_MIGRATIONS} tenant migrations`);
    }
    if (!(result.accountsSeeded > 0)) failures.push("no accounts seeded");
    if (result.locationsSeeded !== 1) failures.push(`locationsSeeded was ${result.locationsSeeded}, expected 1`);

    // THE STATUTORY POSTCONDITION. `statutorySchedulesSeeded` is legitimately 0 on a
    // fresh tenant: migration 0021 inserts the KE-2026-02 schedule itself, so the
    // seeder's ON CONFLICT ("label") DO NOTHING adds nothing. What provisioning must
    // guarantee is that a schedule — with a PAYE ladder — is IN FORCE today, so that
    // is what is asserted, independently of the seeder's count.
    if (result.statutorySchedulesSeeded < 0) failures.push("statutorySchedulesSeeded was negative");
    const schema = schemaOf(FIXTURE_SUBDOMAIN);
    const inForce = await pool.query<{ label: string; bands: string }>(
      `SELECT s."label", (SELECT count(*) FROM "${schema}"."paye_bands" b WHERE b."scheduleId" = s."id")::text AS bands
         FROM "${schema}"."statutory_schedules" s
        WHERE s."effectiveFrom" <= $1::date AND (s."effectiveTo" IS NULL OR s."effectiveTo" > $1::date)`,
      [businessToday().toISOString().slice(0, 10)],
    );
    const schedule = inForce.rows[0];
    if (inForce.rows.length !== 1 || schedule === undefined) {
      failures.push(`expected exactly one statutory schedule in force today, found ${inForce.rows.length}`);
    } else if (!(Number.parseInt(schedule.bands, 10) > 0)) {
      failures.push(`statutory schedule ${schedule.label} has no PAYE bands`);
    }
    if (failures.length > 0) {
      throw new Error(`Fixture provisioning did not meet its contract: ${failures.join("; ")}.`);
    }

    // THE FIXTURE IS A VAT-REGISTERED BUSINESS, set through the real business-profile
    // service (provisioning seeds TURNOVER_TAX). Tests that need another regime — TOT,
    // or a non-registered seller — provision a tenant of their own.
    const { updateBusinessProfile } = await import("../../src/services/business-profile");
    const profile = await updateBusinessProfile(tenantDb(FIXTURE_SUBDOMAIN), { taxRegime: "VAT_REGISTERED" });
    if (!profile.isVatRegistered) {
      throw new Error("Fixture business profile did not become VAT-registered.");
    }

    console.log(
      `[global-setup] database "${databaseName}": platform migrations deployed; tenant "${FIXTURE_SUBDOMAIN}" provisioned — ` +
        `${result.migrationsApplied.length}/${EXPECTED_TENANT_MIGRATIONS} tenant migrations applied, ` +
        `${result.accountsSeeded} accounts seeded, ${result.locationsSeeded} location seeded, ` +
        `statutory schedule ${schedule?.label ?? "?"} in force with ${schedule?.bands ?? "?"} PAYE bands ` +
        `(seeder added ${result.statutorySchedulesSeeded}: migration 0021 inserts it).`,
    );
  } catch (error) {
    await releaseConnections();
    throw error;
  }

  return async function globalTeardown(): Promise<void> {
    assertTestDatabase();
    try {
      await dropTenant(FIXTURE_SUBDOMAIN);
    } finally {
      await releaseConnections();
    }
  };
}
