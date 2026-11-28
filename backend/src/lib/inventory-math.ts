// ---------------------------------------------------------------------------
// Inventory arithmetic — carrying-value allocation and quantity/cost extension.
// Kept separate from money.ts because it mixes quantities (thousandths) with
// costs (cents); money.ts stays a pure money primitive.
//
// NO FLOATING POINT. Quantities arrive as thousandths (Decimal(14,3) * 1000)
// so every operation is exact integer arithmetic routed through roundHalfUp.
//
// THE VALUATION HIERARCHY (Task 3.1-FIX). Read this before changing anything
// here, because the ordering is the whole fix:
//
//   Product.stockValue  is AUTHORITATIVE — the carrying amount in cents. It
//                       moves ONLY by exact posted deltas.
//   Product.stockCount  is AUTHORITATIVE — the aggregate physical quantity.
//   avgCost             is DERIVED — stockValue / stockCount. A projection,
//                       reconstructable at any moment from the two figures
//                       above, and NEVER an input to a stockValue computation.
//
// The old model computed stockValue as quantity * a rounded avgCost. That
// recomputation is the defect this file was rewritten to make impossible: the
// general ledger accumulates EXACT posted costs, so any average that does not
// divide evenly (17 @ 140.00 then 10 @ 50.00 -> 106.6666...) put the two out of
// step by a cent or more on every movement. There is therefore no
// weightedAverageCost() here any more — an average computed from the previous
// rounded average is exactly the feedback loop that drifted.
// ---------------------------------------------------------------------------

import type { Prisma } from "../generated/tenant/client";
import { roundHalfUp, type Cents } from "./money";

/**
 * Scale of the high-precision derived unit rate: micro-cents per whole unit.
 * 10^6 keeps six fractional digits of a cent, far finer than any rounding a
 * single movement can introduce, and it is a plain bigint — not a float.
 */
export const AVG_COST_SCALE = 1_000_000n;

/**
 * The DERIVED weighted-average unit cost, in micro-cents per whole unit.
 *
 *   rate = stockValue / (quantityMilli / 1000)  -> scaled by AVG_COST_SCALE
 *
 * This is a CACHE/PROJECTION in the strict sense: it is a pure function of the
 * two authoritative figures and holds no state of its own. Zero quantity yields
 * zero — a product that owns nothing has no unit rate — which is consistent
 * with the zero invariant (stockCount == 0 implies stockValue == 0).
 */
export function deriveAvgCost(stockValueCents: Cents, quantityMilli: bigint): bigint {
  if (quantityMilli === 0n) {
    return 0n;
  }
  return roundHalfUp(stockValueCents * 1000n * AVG_COST_SCALE, quantityMilli);
}

/** Round the high-precision derived rate to whole cents, for display and for the avgCost cache column. */
export function displayAvgCost(rateMicro: bigint): Cents {
  return roundHalfUp(rateMicro, AVG_COST_SCALE);
}

/**
 * Render a micro-cent rate as a decimal string of CENTS with six fractional
 * digits, e.g. 10666666667n -> "10666.666667". A rate is not money, so it never
 * goes through the money formatter.
 */
export function formatAvgCost(rateMicro: bigint): string {
  const negative = rateMicro < 0n;
  const magnitude = negative ? -rateMicro : rateMicro;
  const digits = magnitude.toString().padStart(7, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

/**
 * The share of a carrying value that `partQtyMilli` out of `totalQtyMilli`
 * represents:
 *
 *   share = roundHalfUp(partQty * stockValue / totalQty)
 *
 * This is `quantity * deriveAvgCost(...)` evaluated with the rate held EXACT —
 * one rounding at the end, never a rounded rate multiplied back up. It is used
 * for partial outbound COGS and for the per-location value allocation, and it
 * can never exceed stockValue while partQty <= totalQty, so it cannot drive the
 * carrying value negative.
 */
export function proportionalCost(
  partQtyMilli: bigint,
  totalQtyMilli: bigint,
  stockValueCents: Cents,
): Cents {
  if (totalQtyMilli === 0n) {
    throw new Error("proportionalCost: total quantity is zero; there is nothing to apportion.");
  }
  const part = partQtyMilli < 0n ? -partQtyMilli : partQtyMilli;
  const total = totalQtyMilli < 0n ? -totalQtyMilli : totalQtyMilli;
  return roundHalfUp(part * stockValueCents, total);
}

/**
 * Extended cost of a movement: |quantity| * unitCost, with the quantity given
 * in thousandths and divided back out via roundHalfUp. Sign of the quantity is
 * ignored — cost is always a non-negative magnitude.
 *
 * VALID ONLY where unitCost is an EXACT per-unit figure the caller supplied — a
 * purchase receipt's cost, a sale line's price. It must NOT be used with a
 * derived average cost to produce a carrying value; that is the forbidden
 * pattern. Use proportionalCost for anything apportioned out of stockValue.
 */
export function extendCost(quantityMilli: bigint, unitCost: Cents): Cents {
  const magnitude = quantityMilli < 0n ? -quantityMilli : quantityMilli;
  return roundHalfUp(magnitude * unitCost, 1000n);
}

/**
 * Convert a Decimal(14,3) value (as a Prisma.Decimal or its string form) to an
 * exact bigint count of thousandths. Rejects more than 3 fractional digits.
 * Parses digits directly — no Number(), no parseFloat.
 */
export function decimalToMilli(value: Prisma.Decimal | string): bigint {
  const raw = typeof value === "string" ? value : value.toString();
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("decimalToMilli: empty input.");
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`decimalToMilli: "${raw}" is not a valid decimal.`);
  }

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dotIndex = unsigned.indexOf(".");
  const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? "" : unsigned.slice(dotIndex + 1);

  if (fracPart.length > 3) {
    throw new Error(`decimalToMilli: "${raw}" has more than 3 decimal places.`);
  }

  const fracPadded = (fracPart + "000").slice(0, 3);
  const magnitude = BigInt(intPart + fracPadded);
  return negative ? -magnitude : magnitude;
}

/** Render a bigint count of thousandths back as a Decimal(14,3) string. Sign preserved. */
export function milliToDecimalString(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const digits = magnitude.toString().padStart(4, "0");
  const intPart = digits.slice(0, -3);
  const fracPart = digits.slice(-3);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}
