// CLI entry point for rolling the latest tenant datamodel out to every ACTIVE
// tenant.
//
// Usage:
//   npm run tenant:migrate-all
//
// Each tenant is migrated in its own transaction. A failure on one tenant is
// reported but does not abort the others. The process exits 1 if ANY tenant
// failed.

import { closePool } from "../db/pool";
import { disconnectAllTenantDbs } from "../db/tenant";
import { migrateAllTenants } from "../services/tenant-provisioning";

async function main(): Promise<boolean> {
  const results = await migrateAllTenants();

  if (results.length === 0) {
    console.log("No ACTIVE tenants to migrate.");
    return true;
  }

  console.log("Per-tenant migration summary:");
  console.log("-".repeat(72));
  let anyFailed = false;
  for (const result of results) {
    if (result.error !== undefined) {
      anyFailed = true;
      console.log(`  [FAIL] ${result.subdomain} (${result.schema})`);
      console.log(`         ${result.error}`);
    } else {
      const applied =
        result.applied.length > 0 ? result.applied.join(", ") : "(0 applied)";
      console.log(
        `  [ OK ] ${result.subdomain} (${result.schema}): ${applied} | accountsSeeded: ${result.accountsSeeded} | statutorySeeded: ${result.statutorySchedulesSeeded} | locationsSeeded: ${result.locationsSeeded} | locationStockBackfilled: ${result.locationStockBackfilled}`,
      );
    }
  }
  console.log("-".repeat(72));

  const failures = results.filter((r) => r.error !== undefined).length;
  console.log(
    `${results.length} tenant(s) processed, ${failures} failure(s).`,
  );

  return !anyFailed;
}

main()
  .then(async (ok) => {
    await disconnectAllTenantDbs();
    await closePool();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Migration run failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => {
      console.error("Cleanup: failed to disconnect tenant clients:", e);
    });
    await closePool().catch((e: unknown) => {
      console.error("Cleanup: failed to close pool:", e);
    });
    process.exit(1);
  });
