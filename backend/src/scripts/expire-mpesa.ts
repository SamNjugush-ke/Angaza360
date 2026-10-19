// CLI: sweep stale INITIATED M-Pesa STK transactions into TIMED_OUT, reversing
// their 1015 clearing like a failure. No cron in MVP — this script is the seam.
//
// Usage: npm run mpesa:expire -- [--minutes 5]
//   --minutes: expire INITIATED transactions older than this many minutes
//              (default 5). Pass 0 to expire everything still pending.

import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { getTenantDb, disconnectAllTenantDbs } from "../db/tenant";
import { expireStalePending } from "../services/mpesa/payment";

function parseMinutes(argv: string[]): number {
  const idx = argv.indexOf("--minutes");
  if (idx === -1) {
    return 5;
  }
  const raw = argv[idx + 1];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--minutes must be a non-negative integer, got "${String(raw)}".`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const minutes = parseMinutes(process.argv.slice(2));

  const tenants = await platformDb.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { subdomain: true, dbSchema: true },
    orderBy: { subdomain: "asc" },
  });

  console.log(`Expiring M-Pesa transactions older than ${minutes} minute(s):`);
  for (const tenant of tenants) {
    const db = getTenantDb(tenant.dbSchema);
    const { expired } = await expireStalePending(db, minutes);
    console.log(`  ${tenant.subdomain}: ${expired} transaction(s) timed out`);
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
    console.error(`mpesa:expire failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => console.error("Cleanup:", e));
    await platformDb.$disconnect().catch((e: unknown) => console.error("Cleanup:", e));
    await closePool().catch((e: unknown) => console.error("Cleanup:", e));
    process.exit(1);
  });
