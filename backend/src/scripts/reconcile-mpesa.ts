// CLI: reconcile INITIATED M-Pesa STK pushes whose callback is late (M4.5 W1, T-B2), by
// asking Safaricom (STK Push Query) — see reconcilePendingMpesa in services/mpesa/payment.ts.
// Idempotent: safe to run as often as you like. Wave 4 schedules it; this script is the seam.
//
// Usage: npm run mpesa:reconcile -- [--minutes 2]
//   --minutes: only pushes older than this many minutes (default 2).
// A business without active M-Pesa credentials is reported and skipped.

import { resolveTenantContext } from "../auth/tenant-registry";
import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { getTenantDb, disconnectAllTenantDbs } from "../db/tenant";
import { NoActiveCredentialError } from "../services/credentials/credential-store";
import { IntegrationDisabledError } from "../services/mpesa/factory";
import { reconcilePendingMpesa } from "../services/mpesa/payment";

function parseMinutes(argv: string[]): number {
  const idx = argv.indexOf("--minutes");
  if (idx === -1) {
    return 2;
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
    select: { id: true, subdomain: true, dbSchema: true },
    orderBy: { subdomain: "asc" },
  });

  console.log(`Reconciling M-Pesa pushes older than ${minutes.toString()} minute(s):`);
  for (const tenant of tenants) {
    const db = getTenantDb(tenant.dbSchema);
    try {
      const report = await reconcilePendingMpesa(db, await resolveTenantContext(tenant.id), { olderThanMinutes: minutes });
      const tally = new Map<string, number>();
      for (const outcome of report.outcomes) {
        tally.set(outcome.result, (tally.get(outcome.result) ?? 0) + 1);
      }
      const summary = [...tally.entries()].map(([result, count]) => `${result} ${count.toString()}`).join(", ");
      console.log(`  ${tenant.subdomain}: ${report.examined.toString()} examined${summary === "" ? "" : ` — ${summary}`}`);
    } catch (error) {
      if (error instanceof NoActiveCredentialError || error instanceof IntegrationDisabledError) {
        console.log(`  ${tenant.subdomain}: skipped — ${error.message}`);
        continue;
      }
      throw error;
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
    console.error(`mpesa:reconcile failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => console.error("Cleanup:", e));
    await platformDb.$disconnect().catch((e: unknown) => console.error("Cleanup:", e));
    await closePool().catch((e: unknown) => console.error("Cleanup:", e));
    process.exit(1);
  });
