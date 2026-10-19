// ===========================================================================
// TAX CONFIGURATION READS (Task 3B.1) — the effective standard VAT rate.
//
// READ-ONLY. The rate lives on the effective-dated StatutorySchedule (its only copy in
// the system) and is resolved for the BUSINESS DATE of the document being priced: a
// sale for the day it happened, a supplier bill for its bill date, a receipt for the
// day it arrived. A rate change is therefore a new dated schedule row, and a document
// dated before it keeps the rate in force on its own date.
//
// It returns null rather than throwing when no schedule covers the date, so each caller
// can refuse with its OWN domain error — a sale's refusal, for instance, is what routes
// an offline capture to the resolution queue instead of failing the whole sync. It
// never falls back to "the latest" rate: pricing a sale on a rate that was not in force
// on its date is exactly the error the effective-dated table exists to prevent.
// ===========================================================================

import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import { businessDateOf } from "../lib/business-time";
import type { LedgerTx } from "./ledger";

export interface StandardVatRate {
  /** A RATE as a decimal-percentage string, e.g. "16.00". Never money. */
  rate: string;
  scheduleLabel: string;
}

export async function resolveStandardVatRate(
  db: TenantPrismaClient | LedgerTx,
  onDate: Date,
): Promise<StandardVatRate | null> {
  const day = businessDateOf(onDate);
  const covering = await db.statutorySchedule.findMany({
    where: {
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }],
    },
    select: { label: true, vatStandardRate: true },
  });
  // More than one covering schedule is impossible (0021's GiST exclusion); if it ever
  // happened, refusing is the only answer that is not a guess.
  if (covering.length !== 1) {
    return null;
  }
  const only = covering[0];
  return only === undefined ? null : { rate: only.vatStandardRate.toString(), scheduleLabel: only.label };
}

/**
 * The Turnover Tax rate in force on a business date (Task 3B.2), from the same single
 * covering schedule, under the same refuse-rather-than-guess rule.
 */
export async function resolveTurnoverTaxRate(
  db: TenantPrismaClient | LedgerTx,
  onDate: Date,
): Promise<StandardVatRate | null> {
  const day = businessDateOf(onDate);
  const covering = await db.statutorySchedule.findMany({
    where: {
      effectiveFrom: { lte: day },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }],
    },
    select: { label: true, totRatePercent: true },
  });
  if (covering.length !== 1) {
    return null;
  }
  const only = covering[0];
  return only === undefined ? null : { rate: only.totRatePercent.toString(), scheduleLabel: only.label };
}

/** The message every caller uses when no schedule covers a date. */
export function noVatRateMessage(onDate: Date): string {
  return `No statutory schedule covers ${businessDateOf(onDate).toISOString().slice(0, 10)}, so there is no VAT or Turnover Tax rate in force for that date. Seed the schedule for that period rather than pricing tax on a rate that did not apply.`;
}
