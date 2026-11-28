// CLI: resubmit QUEUED eTIMS invoices — the CONNECTIVITY backlog — each with the
// invoice number it already holds.
//
// This is the ASYNC/NIGHTLY SEAM. There is no cron in MVP; this script is what a
// scheduler calls, and it is safe to run as often as you like.
//
// WHAT IT DOES NOT TOUCH, deliberately:
//   * REJECTED invoices. KRA was REACHABLE and refused those: the payload is
//     wrong, so resubmitting it unchanged just gets refused again while burying
//     the real problem under a rising retry count. They need an operator, which is
//     what GET /v1/etims/invoices?status=REJECTED is for.
//   * The ledger. eTIMS posts nothing, ever — the VAT was posted at sale time.
//   * The sales themselves. Every sale in this backlog is already committed,
//     correct and final; only the attestation to KRA is outstanding.
//
// It NEVER reallocates an invoice number. Resubmitting the SAME number is safe
// whether or not KRA saw the original: if it did not, the invoice files; if it
// did, KRA rejects the duplicate and we learn the truth. A fresh number would file
// the same sale twice and overstate the tenant's declared revenue.
//
// Usage: npm run etims:retry -- [--minutes 10] [--tenant <subdomain>]
//   --minutes: only retry invoices last attempted more than this many minutes ago
//              (default 10). Pass 0 to retry everything queued.
//   --tenant:  restrict to one tenant subdomain, for investigating a single shop.

import { platformDb } from "../db/platform";
import { closePool } from "../db/pool";
import { getTenantDb, disconnectAllTenantDbs } from "../db/tenant";
import { retryQueuedInvoices } from "../services/etims/etims-signing";
import { NoActiveCredentialError } from "../services/credentials/credential-store";
import { EtimsNotConfiguredError } from "../services/etims/etims-signing";
import { EtimsDisabledError } from "../services/etims/factory";

function parseMinutes(argv: string[]): number {
  const idx = argv.indexOf("--minutes");
  if (idx === -1) {
    return 10;
  }
  const raw = argv[idx + 1];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--minutes must be a non-negative integer, got "${String(raw)}".`);
  }
  return parsed;
}

function parseTenant(argv: string[]): string | null {
  const idx = argv.indexOf("--tenant");
  if (idx === -1) {
    return null;
  }
  const raw = argv[idx + 1];
  if (raw === undefined || raw === "") {
    throw new Error("--tenant requires a tenant subdomain.");
  }
  return raw;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const minutes = parseMinutes(argv);
  const onlyTenant = parseTenant(argv);

  const tenants = await platformDb.tenant.findMany({
    where: {
      status: "ACTIVE",
      ...(onlyTenant !== null ? { subdomain: onlyTenant } : {}),
    },
    select: { subdomain: true, dbSchema: true },
    orderBy: { subdomain: "asc" },
  });
  if (tenants.length === 0) {
    console.log(
      onlyTenant === null
        ? "No ACTIVE tenants."
        : `No ACTIVE tenant with subdomain "${onlyTenant}".`,
    );
    return;
  }

  console.log(
    `Retrying QUEUED eTIMS invoices last attempted more than ${minutes.toString()} minute(s) ago:`,
  );

  for (const tenant of tenants) {
    const db = getTenantDb(tenant.dbSchema);
    try {
      const result = await retryQueuedInvoices(db, minutes);
      if (result.attempted === 0) {
        console.log(`  ${tenant.subdomain}: nothing queued`);
        continue;
      }
      console.log(
        `  ${tenant.subdomain}: ${result.attempted.toString()} attempted — ` +
          `${result.signed.toString()} signed, ${result.rejected.toString()} rejected by KRA, ` +
          `${result.stillQueued.toString()} still unreachable, ${result.exhausted.toString()} retries exhausted`,
      );
      for (const row of result.rows) {
        console.log(
          `    invoice #${row.etimsInvoiceNumber.toString()} (${row.saleNumber}): ` +
            `${row.previousStatus} -> ${row.status} [attempt ${row.retryCount.toString()}]` +
            (row.resultMsg === null ? "" : ` — ${row.resultMsg}`),
        );
      }
    } catch (error) {
      // A tenant that has not onboarded eTIMS, or has it switched off, is not a
      // failure of the sweep: most tenants will never use eTIMS at all. Report it
      // and carry on to the next tenant rather than aborting the run.
      if (
        error instanceof EtimsNotConfiguredError ||
        error instanceof EtimsDisabledError ||
        error instanceof NoActiveCredentialError
      ) {
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
    console.error(`etims:retry failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => console.error("Cleanup:", e));
    await platformDb.$disconnect().catch((e: unknown) => console.error("Cleanup:", e));
    await closePool().catch((e: unknown) => console.error("Cleanup:", e));
    process.exit(1);
  });
