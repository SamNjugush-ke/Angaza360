// CLI: the ID-document retention schedule (M4.5 W2) — purge the documents of applications
// decided long enough ago, and of abandoned drafts (services/tenants/documents.ts). The
// ciphertext is removed; a stub records the purge. Idempotent. Wave 4 schedules it.
//
// Usage: npm run applications:purge-documents -- [--dry-run]

import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { purgeExpiredDocuments, RETAIN_AFTER_DECISION_DAYS, RETAIN_DRAFT_DAYS } from "../services/tenants/documents";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const report = await purgeExpiredDocuments(new Date(), { dryRun });
  console.log(
    `${dryRun ? "Would purge" : "Purged"} ${report.purged.toString()} ID document(s) across ${report.applications.toString()} application(s) ` +
      `(decided > ${RETAIN_AFTER_DECISION_DAYS.toString()} days ago, or drafts idle > ${RETAIN_DRAFT_DAYS.toString()} days).`,
  );
}

main()
  .then(async () => {
    await platformDb.$disconnect();
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(`applications:purge-documents failed: ${error instanceof Error ? error.message : String(error)}`);
    await platformDb.$disconnect().catch((e: unknown) => console.error("Cleanup:", e));
    await closePool().catch((e: unknown) => console.error("Cleanup:", e));
    process.exit(1);
  });
