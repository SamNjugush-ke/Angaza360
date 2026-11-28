// CLI: live-verify every ACTIVE business's stored M-Pesa and eTIMS credentials (M4.5 W1,
// T-B1) and record their health — see services/integrations/health.ts. Moves no money and
// signs nothing. Wave 4 schedules it; this script is the seam.
//
// Usage: npm run integrations:verify
// A provider with nothing stored is reported and skipped; no secret is ever printed.

import { resolveTenantContext } from "../auth/tenant-registry";
import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { getTenantDb, disconnectAllTenantDbs } from "../db/tenant";
import { NoActiveCredentialError } from "../services/credentials/credential-store";
import { verifyIntegration, VERIFIABLE_PROVIDERS } from "../services/integrations/health";

async function main(): Promise<void> {
  const tenants = await platformDb.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, subdomain: true, dbSchema: true },
    orderBy: { subdomain: "asc" },
  });
  console.log("Verifying integrations:");
  for (const tenant of tenants) {
    const db = getTenantDb(tenant.dbSchema);
    const context = await resolveTenantContext(tenant.id);
    for (const provider of VERIFIABLE_PROVIDERS) {
      try {
        const result = await verifyIntegration(db, context, provider, null);
        console.log(`  ${tenant.subdomain} ${provider} ${result.environment}: ${result.ok ? "HEALTHY" : "FAILING"} — ${result.detail}`);
      } catch (error) {
        if (error instanceof NoActiveCredentialError) {
          console.log(`  ${tenant.subdomain} ${provider}: nothing stored — skipped`);
          continue;
        }
        throw error;
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
    console.error(`integrations:verify failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => console.error("Cleanup:", e));
    await platformDb.$disconnect().catch((e: unknown) => console.error("Cleanup:", e));
    await closePool().catch((e: unknown) => console.error("Cleanup:", e));
    process.exit(1);
  });
