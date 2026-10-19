// CLI entry point for the one-time corrective rebuild of every product's
// carrying value from its immutable stock-movement history (Task 3.1-FIX).
//
// Usage:
//   npm run inventory:rebuild-stock-value           # every ACTIVE tenant
//   npm run inventory:rebuild-stock-value -- --dry-run
//
// WHY THIS EXISTS. The pre-fix valuation model recomputed Product.stockValue as
// quantity * a rounded average cost, while the general ledger accumulated the
// EXACT cost of each movement. Any average that did not divide evenly put the
// two out of step, breaking sum(Product.stockValue) = GL balance of account
// 1200. The fix makes stockValue authoritative and moved only by exact posted
// deltas; this script brings already-drifted data onto that model.
//
// WHAT IT DOES NOT DO. It does not edit a stock movement or a journal entry —
// both are immutable and both are already correct, since a movement's totalCost
// IS the amount its journal entry posted. It does not rewrite stockCount. It
// does not zero a ghost balance. Anything it cannot decide from the history it
// refuses, loudly, with the product named.
//
// Idempotent: a second run reports zero corrections. Each tenant is rebuilt in
// its own transaction; a failure on one is reported but does not abort the
// others, and the process exits 1 if ANY tenant failed.

import { pool, closePool } from "../db/pool";
import { assertValidSchemaName, disconnectAllTenantDbs, getTenantDb } from "../db/tenant";
import { formatCents } from "../lib/money";
import { rebuildStockValueFromHistory, type StockValueRebuildResult } from "../services/inventory";

interface TenantRow {
  subdomain: string;
  dbSchema: string;
}

interface TenantOutcome {
  subdomain: string;
  schema: string;
  result?: StockValueRebuildResult;
  error?: string;
}

async function listActiveTenants(): Promise<TenantRow[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<TenantRow>(
      `SELECT "subdomain", "dbSchema" FROM public.tenants WHERE "status" = 'ACTIVE'::"TenantStatus" ORDER BY "subdomain"`,
    );
    return result.rows;
  } finally {
    client.release();
  }
}

function reportTenant(outcome: TenantOutcome, dryRun: boolean): void {
  console.log("-".repeat(78));
  console.log(`${outcome.subdomain} (${outcome.schema})`);

  if (outcome.error !== undefined) {
    console.log(`  [FAIL] ${outcome.error}`);
    return;
  }
  const result = outcome.result;
  if (result === undefined) {
    console.log("  [FAIL] no result returned.");
    return;
  }

  for (const row of result.rows) {
    const marker = row.correction === 0n ? "    " : "  * ";
    console.log(
      `${marker}${row.sku.padEnd(14)} qty ${row.stockCount.padStart(10)}  ` +
        `stockValue ${formatCents(row.previousStockValue).padStart(14)} -> ${formatCents(row.postedValue).padStart(14)}  ` +
        `(${row.correction >= 0n ? "+" : ""}${formatCents(row.correction)})  ` +
        `avgCost ${formatCents(row.avgCost)} [${row.avgCostPrecise}]`,
    );
  }

  console.log(
    `  products corrected: ${result.changed}  net correction: ${formatCents(result.totalCorrection)}`,
  );
  console.log(
    `  BEFORE  sum(stockValue) ${formatCents(result.before.inventoryValue)}  GL(1200) ${formatCents(result.before.glAccount1200Balance)}  difference ${formatCents(result.before.difference)}`,
  );
  console.log(
    `  AFTER   sum(stockValue) ${formatCents(result.after.inventoryValue)}  GL(1200) ${formatCents(result.after.glAccount1200Balance)}  difference ${formatCents(result.after.difference)}`,
  );
  if (result.after.difference !== 0n) {
    console.log(
      `  [WARN] sum(stockValue) still differs from GL account 1200 by ${formatCents(result.after.difference)}. ` +
        `The history and the ledger disagree; do NOT adjust either to match — investigate.`,
    );
  }
  if (dryRun) {
    console.log("  (dry run — nothing was written; AFTER is what a real run would produce)");
  }
}

async function main(): Promise<boolean> {
  const dryRun = process.argv.includes("--dry-run");
  const tenants = await listActiveTenants();

  if (tenants.length === 0) {
    console.log("No ACTIVE tenants to rebuild.");
    return true;
  }

  console.log(
    dryRun
      ? "Rebuilding stock value from movement history (DRY RUN — no writes committed)."
      : "Rebuilding stock value from movement history.",
  );

  const outcomes: TenantOutcome[] = [];
  for (const tenant of tenants) {
    const schema = tenant.dbSchema;
    try {
      assertValidSchemaName(schema);
      const db = getTenantDb(schema);
      const result = await rebuildStockValueFromHistory(db, { apply: !dryRun });
      outcomes.push({ subdomain: tenant.subdomain, schema, result });
    } catch (error) {
      outcomes.push({
        subdomain: tenant.subdomain,
        schema,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let anyFailed = false;
  let anyUnreconciled = false;
  for (const outcome of outcomes) {
    reportTenant(outcome, dryRun);
    if (outcome.error !== undefined) {
      anyFailed = true;
    } else if (outcome.result !== undefined && outcome.result.after.difference !== 0n) {
      anyUnreconciled = true;
    }
  }
  console.log("-".repeat(78));
  console.log(
    `${outcomes.length} tenant(s) processed, ${outcomes.filter((o) => o.error !== undefined).length} failure(s).`,
  );

  return !anyFailed && !anyUnreconciled;
}

main()
  .then(async (ok) => {
    await disconnectAllTenantDbs();
    await closePool();
    process.exit(ok ? 0 : 1);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Stock value rebuild failed: ${message}`);
    await disconnectAllTenantDbs().catch((e: unknown) => {
      console.error("Cleanup: failed to disconnect tenant clients:", e);
    });
    await closePool().catch((e: unknown) => {
      console.error("Cleanup: failed to close pool:", e);
    });
    process.exit(1);
  });
