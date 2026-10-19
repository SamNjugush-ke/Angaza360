// CLI: sweep every ACTIVE device whose offline lease has expired without syncing
// and FREEZE the stock its location still owns to PENDING_RECONCILIATION.
//
// This is the NIGHTLY-WORKER SEAM. There is no cron in MVP; this script is the
// thing a scheduler will call, and it is safe to call as often as you like —
// expireLeases is idempotent (each device's lease is ended as part of its freeze,
// and a location that already carries an active freeze is left alone).
//
// WHAT IT DOES NOT DO, deliberately: it posts NO journal entry and moves no stock
// between locations. A freeze immobilises stock that is still the tenant's; the
// only path by which frozen stock becomes a general-ledger event is an explicit
// admin write-off (Dr 5300 / Cr 1200). Nothing here guesses what a device sold.
//
// Usage: npm run leases:expire -- [--dry-run]
//   --dry-run: report which devices WOULD freeze and what they hold, without
//              freezing anything.

import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { getTenantDb, disconnectAllTenantDbs } from "../db/tenant";
import { findExpiredUnsyncedDevices } from "../services/offline/custody";
import { expireLeases } from "../services/offline/freeze";
import { getLocationStock } from "../services/inventory";

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

async function main(): Promise<void> {
  const dryRun = hasFlag(process.argv.slice(2), "--dry-run");

  const tenants = await platformDb.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { subdomain: true, dbSchema: true },
    orderBy: { subdomain: "asc" },
  });

  const now = new Date();
  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Expiring offline leases as at ${now.toISOString()}:`,
  );

  for (const tenant of tenants) {
    const db = getTenantDb(tenant.dbSchema);

    if (dryRun) {
      const candidates = await findExpiredUnsyncedDevices(db, now);
      if (candidates.length === 0) {
        console.log(`  ${tenant.subdomain}: no expired unsynced leases`);
        continue;
      }
      console.log(`  ${tenant.subdomain}: ${candidates.length} expired unsynced lease(s)`);
      for (const candidate of candidates) {
        const held = await getLocationStock(db, { locationId: candidate.locationId });
        const positive = held.filter((row) => row.quantity !== "0.000");
        console.log(
          `    ${candidate.deviceName} @ ${candidate.locationCode} (expired ${candidate.leaseExpiresAt.toISOString()}) would freeze ${positive.length} product(s)`,
        );
        for (const row of positive) {
          console.log(`      ${row.sku} x ${row.quantity}`);
        }
      }
      continue;
    }

    const result = await expireLeases(db, now);
    if (result.results.length === 0) {
      console.log(`  ${tenant.subdomain}: no expired unsynced leases`);
      continue;
    }
    console.log(
      `  ${tenant.subdomain}: ${result.results.length} lease(s) processed, ${result.frozenCount} newly frozen`,
    );
    for (const row of result.results) {
      console.log(
        `    ${row.deviceName} @ ${row.locationCode}: ${row.outcome}${row.freezeId === null ? "" : ` (freeze ${row.freezeId})`}`,
      );
      for (const slice of row.frozen) {
        console.log(`      FROZEN ${slice.sku} x ${slice.frozenQuantity}`);
      }
    }
  }
}

main()
  .then(async () => {
    await disconnectAllTenantDbs();
    await platformDb.$disconnect();
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`leases:expire failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => console.error("Cleanup:", e));
    await platformDb.$disconnect().catch((e: unknown) => console.error("Cleanup:", e));
    await closePool().catch((e: unknown) => console.error("Cleanup:", e));
    process.exit(1);
  });
