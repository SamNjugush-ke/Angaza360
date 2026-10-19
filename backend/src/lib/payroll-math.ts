// ===========================================================================
// THE GROSS-TO-NET ENGINE (Module 8, Task 8.1).
//
// **THIS FILE IS PURE.** It imports no database client, no Prisma type and no
// service. It takes an employee's earnings plus a RESOLVED statutory ruleset and
// returns the payslip figures. That purity is not tidiness: it is what lets the
// worked examples in the task's acceptance be checked as ARITHMETIC rather than as a
// system test, and what lets a disputed payslip be re-derived years later from the
// schedule it recorded.
//
// NO STATUTORY FIGURE APPEARS HERE. Every rate, limit, floor and band arrives in the
// `PayrollRuleset` argument, read from the effective-dated `statutory_schedules` row
// the run recorded. The engineering ledger "Configurable Statutory & Regulatory Values" requires
// it, and the reason is that a run for a PAST period must stay correct against the
// rates in force THEN.
//
// MONEY IS BigInt KES CENTS THROUGHOUT. Rates are decimal STRINGS and go through
// `applyRatePercent`; every component is rounded EXACTLY ONCE through the single
// `roundHalfUp` primitive that `applyRatePercent` wraps. There is no floating point
// anywhere in this file: no `Number()`, no `parseFloat`, no arithmetic on a JS
// number.
//
// ---------------------------------------------------------------------------
// THE COMPUTE ORDER, AND WHY IT IS LOAD-BEARING
//
//   grossPay      = basic + Σ(all allowances)
//   taxableGross  = basic + Σ(allowances WHERE taxable)
//   nssfEmployee  = nssfRate% × min(grossPay, UEL)          -- capped at the ceiling
//   nssfEmployer  = nssfEmployee                            -- matched, not computed twice
//   shifEmployee  = max(shifMinimum, shifRate% × grossPay)  -- a FLOOR, not a cap
//   ahlEmployee   = ahlRate% × grossPay
//   ahlEmployer   = ahlEmployee                             -- matched
//   taxablePay    = taxableGross − nssfEmployee − shifEmployee − ahlEmployee
//   payeBefore    = Σ over bands of (bandRate% × the portion of taxablePay in band)
//   paye          = max(0, payeBefore − personalRelief)
//   netPay        = grossPay − nssfEmployee − shifEmployee − ahlEmployee − paye
//
// **THE THIRD-FROM-LAST LINE IS THE ONE THAT MATTERS.** Under the Tax Laws
// (Amendment) Act 2024, effective 27 December 2024, NSSF, SHIF and AHL are ALLOWABLE
// DEDUCTIONS against taxable pay — they reduce the income PAYE is computed on. They
// are NOT reliefs against the tax, which is what they used to be, and the two give
// different answers: a deduction saves tax at the employee's MARGINAL rate, a relief
// saves it shilling for shilling. Applying them in the wrong place mis-states PAYE
// for every employee the business has.
//
// THE THREE STATUTORY BASES ARE ALSO DIFFERENT, deliberately:
//   * NSSF, SHIF and AHL are computed on GROSS — including non-taxable allowances,
//     because they are not income taxes and the exemptions do not carry over.
//   * PAYE is computed on TAXABLE gross less the allowable deductions.
// Collapsing those into one base is the other way this computation goes wrong.
// ===========================================================================

import { applyRatePercent, type Cents } from "./money";

/** One PAYE band: `[lowerBound, upperBound)` of monthly taxable pay. */
export interface PayeBandRule {
  /** Position in the ladder, from 1. Bands must arrive contiguous and ascending. */
  readonly ordinal: number;
  readonly lowerBound: Cents;
  /** NULL means the top band — unbounded above. */
  readonly upperBound: Cents | null;
  /** A decimal percentage string, e.g. "30.00". A RATE, never money. */
  readonly ratePercent: string;
}

/**
 * The resolved statutory ruleset for the period being computed — a direct read of
 * one `statutory_schedules` row plus its bands.
 */
export interface PayrollRuleset {
  readonly label: string;
  readonly personalRelief: Cents;
  readonly nssfRatePercent: string;
  readonly nssfLowerLimit: Cents;
  readonly nssfUpperLimit: Cents;
  readonly shifRatePercent: string;
  readonly shifMinimum: Cents;
  readonly ahlRatePercent: string;
  readonly bands: readonly PayeBandRule[];
}

/** One earning line as it stood when the run was computed. */
export interface EarningInput {
  readonly name: string;
  readonly amount: Cents;
  readonly taxable: boolean;
}

export interface PayrollComputationInput {
  readonly basicSalary: Cents;
  readonly allowances: readonly EarningInput[];
}

export interface PayrollComputation {
  readonly grossPay: Cents;
  readonly taxableGross: Cents;
  readonly nssfEmployee: Cents;
  readonly nssfEmployer: Cents;
  /** The reportable Tier I / Tier II split. Always totals `nssfEmployee`. */
  readonly nssfTier1: Cents;
  readonly nssfTier2: Cents;
  readonly shifEmployee: Cents;
  readonly ahlEmployee: Cents;
  readonly ahlEmployer: Cents;
  readonly taxablePay: Cents;
  readonly payeBeforeRelief: Cents;
  readonly personalReliefApplied: Cents;
  readonly paye: Cents;
  readonly totalEmployeeDeductions: Cents;
  readonly netPay: Cents;
  /** basic + each allowance, as snapshotted onto the payslip. */
  readonly earnings: readonly EarningInput[];
}

/** A malformed ruleset (an empty or non-contiguous band ladder). */
export class PayrollRulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollRulesetError";
  }
}

/** Bad computation input (a negative salary or allowance). */
export class PayrollInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollInputError";
  }
}

function min(a: Cents, b: Cents): Cents {
  return a < b ? a : b;
}

function max(a: Cents, b: Cents): Cents {
  return a > b ? a : b;
}

/**
 * Validate the band ladder before anything is computed from it.
 *
 * Migration 0021's DEFERRED `paye_bands_contiguous_check` already guarantees this at
 * the database, so this is the ergonomic half of the pair the engineering ledger requires: it
 * fails with a message naming the defect rather than silently under-taxing the
 * portion of pay that fell in a gap. **The engine refuses to compute on a ladder it
 * cannot trust**, which is the right direction — an exception is recoverable, a
 * quietly wrong PAYE figure is discovered by KRA.
 */
export function assertUsableBands(ruleset: PayrollRuleset): void {
  const bands = [...ruleset.bands].sort((a, b) => a.ordinal - b.ordinal);
  if (bands.length === 0) {
    throw new PayrollRulesetError(
      `Statutory schedule ${ruleset.label} has no PAYE bands, so there is no ladder to compute tax on.`,
    );
  }
  const first = bands[0];
  if (first === undefined || first.lowerBound !== 0n) {
    throw new PayrollRulesetError(
      `Statutory schedule ${ruleset.label}: the lowest PAYE band must start at 0 so that every shilling of taxable pay falls in a band.`,
    );
  }
  for (const [index, band] of bands.entries()) {
    const previous = index === 0 ? null : bands[index - 1];
    if (previous !== null && previous !== undefined) {
      if (previous.upperBound === null) {
        throw new PayrollRulesetError(
          `Statutory schedule ${ruleset.label}: band ${previous.ordinal.toString()} is open-topped but is not the highest band.`,
        );
      }
      if (previous.upperBound !== band.lowerBound) {
        throw new PayrollRulesetError(
          `Statutory schedule ${ruleset.label}: PAYE bands are not contiguous — band ${band.ordinal.toString()} starts at ${band.lowerBound.toString()} but the band below it ends at ${previous.upperBound.toString()}. A gap would tax nothing in it; an overlap would tax the same shillings twice.`,
        );
      }
    }
    if (band.upperBound !== null && band.upperBound <= band.lowerBound) {
      throw new PayrollRulesetError(
        `Statutory schedule ${ruleset.label}: band ${band.ordinal.toString()} is empty or inverted.`,
      );
    }
  }
  const last = bands[bands.length - 1];
  if (last === undefined || last.upperBound !== null) {
    throw new PayrollRulesetError(
      `Statutory schedule ${ruleset.label}: the highest PAYE band must be open-topped, or pay above it would be untaxed.`,
    );
  }
}

/**
 * PAYE from the bands, before personal relief.
 *
 * Each band is taxed on its OWN PORTION of taxable pay and rounded ONCE — never a
 * single rate applied to the whole, and never a rounded subtotal carried into the
 * next band. The worked example makes the difference visible: the 25% band's portion
 * is 8,333.00 and yields 2,083.25, a figure with a non-zero half-cent that only
 * survives if the band is rounded in isolation.
 */
export function computePayeOnBands(taxablePay: Cents, ruleset: PayrollRuleset): Cents {
  assertUsableBands(ruleset);
  if (taxablePay <= 0n) {
    return 0n;
  }
  const bands = [...ruleset.bands].sort((a, b) => a.ordinal - b.ordinal);
  let tax = 0n;
  for (const band of bands) {
    if (taxablePay <= band.lowerBound) {
      break;
    }
    const ceiling = band.upperBound === null ? taxablePay : min(taxablePay, band.upperBound);
    const portion = ceiling - band.lowerBound;
    if (portion <= 0n) {
      continue;
    }
    tax += applyRatePercent(portion, band.ratePercent);
  }
  return tax;
}

/**
 * THE GROSS-TO-NET COMPUTATION. See the compute order at the top of this file.
 *
 * Every component is floored at zero. That is not defensive padding: a deduction
 * that exceeded what it is deducted from would produce a negative payslip line, and
 * migration 0021 refuses to store one — so the engine and the database agree that it
 * cannot happen rather than one of them discovering it.
 */
export function computePayroll(
  input: PayrollComputationInput,
  ruleset: PayrollRuleset,
): PayrollComputation {
  if (input.basicSalary < 0n) {
    throw new PayrollInputError("basicSalary must not be negative.");
  }

  const earnings: EarningInput[] = [
    { name: "Basic Salary", amount: input.basicSalary, taxable: true },
  ];
  for (const allowance of input.allowances) {
    if (allowance.amount < 0n) {
      throw new PayrollInputError(`Allowance "${allowance.name}" must not be negative.`);
    }
    earnings.push(allowance);
  }

  let grossPay = 0n;
  let taxableGross = 0n;
  for (const earning of earnings) {
    grossPay += earning.amount;
    if (earning.taxable) {
      taxableGross += earning.amount;
    }
  }

  // NSSF: the rate on pensionable pay, CAPPED at the Upper Earnings Limit, and
  // matched by the employer rather than computed a second time — so the two halves
  // can never disagree by a rounding.
  const pensionable = min(grossPay, ruleset.nssfUpperLimit);
  const nssfEmployee = applyRatePercent(pensionable, ruleset.nssfRatePercent);
  const nssfEmployer = nssfEmployee;

  // The reportable tier split. Tier I is the rate on pensionable pay up to the LOWER
  // earnings limit, Tier II the remainder up to the ceiling. Both carry the SAME
  // rate today, so the split is presentational — and it is computed as a RESIDUAL so
  // that `tier1 + tier2 == nssfEmployee` EXACTLY, whatever the rounding does. The
  // alternative (rounding each tier independently) can differ from the total by a
  // cent, and migration 0021's CHECK would then refuse the payslip.
  const nssfTier1 = applyRatePercent(min(pensionable, ruleset.nssfLowerLimit), ruleset.nssfRatePercent);
  const nssfTier2 = nssfEmployee - nssfTier1;

  // SHIF: a FLOOR, not a cap. A low earner pays the statutory minimum rather than
  // the percentage, which is why this is a maximum and not just the rate.
  const shifEmployee = max(ruleset.shifMinimum, applyRatePercent(grossPay, ruleset.shifRatePercent));

  // The Affordable Housing Levy, matched by the employer.
  const ahlEmployee = applyRatePercent(grossPay, ruleset.ahlRatePercent);
  const ahlEmployer = ahlEmployee;

  // THE ALLOWABLE DEDUCTIONS, applied to TAXABLE gross — not to gross, and not as
  // reliefs against the tax. Tax Laws (Amendment) Act 2024; see the file header.
  const allowableDeductions = nssfEmployee + shifEmployee + ahlEmployee;
  const taxablePay = max(0n, taxableGross - allowableDeductions);

  const payeBeforeRelief = computePayeOnBands(taxablePay, ruleset);

  // The relief is capped at the tax it relieves: a relief reduces tax to zero, it
  // never turns into a refund. Recording what was APPLIED rather than the schedule's
  // headline figure is what makes the payslip's arithmetic self-evident.
  const personalReliefApplied = min(ruleset.personalRelief, payeBeforeRelief);
  const paye = payeBeforeRelief - personalReliefApplied;

  const totalEmployeeDeductions = allowableDeductions + paye;
  const netPay = max(0n, grossPay - totalEmployeeDeductions);

  return {
    grossPay,
    taxableGross,
    nssfEmployee,
    nssfEmployer,
    nssfTier1,
    nssfTier2,
    shifEmployee,
    ahlEmployee,
    ahlEmployer,
    taxablePay,
    payeBeforeRelief,
    personalReliefApplied,
    paye,
    totalEmployeeDeductions,
    netPay,
    earnings,
  };
}

/** The run-level sums the accrual entry's seven legs are built from. */
export interface PayrollRunTotals {
  grossPay: Cents;
  nssfEmployee: Cents;
  nssfEmployer: Cents;
  shifEmployee: Cents;
  ahlEmployee: Cents;
  ahlEmployer: Cents;
  paye: Cents;
  netPay: Cents;
}

/**
 * Total a run's payslips.
 *
 * Kept here, beside the computation, so the figures the ledger posts are summed by
 * the same pure code that produced them — not re-derived in the service where a
 * second interpretation could creep in.
 */
export function totalPayslips(
  payslips: ReadonlyArray<
    Pick<
      PayrollComputation,
      | "grossPay"
      | "nssfEmployee"
      | "nssfEmployer"
      | "shifEmployee"
      | "ahlEmployee"
      | "ahlEmployer"
      | "paye"
      | "netPay"
    >
  >,
): PayrollRunTotals {
  const totals: PayrollRunTotals = {
    grossPay: 0n,
    nssfEmployee: 0n,
    nssfEmployer: 0n,
    shifEmployee: 0n,
    ahlEmployee: 0n,
    ahlEmployer: 0n,
    paye: 0n,
    netPay: 0n,
  };
  for (const slip of payslips) {
    totals.grossPay += slip.grossPay;
    totals.nssfEmployee += slip.nssfEmployee;
    totals.nssfEmployer += slip.nssfEmployer;
    totals.shifEmployee += slip.shifEmployee;
    totals.ahlEmployee += slip.ahlEmployee;
    totals.ahlEmployer += slip.ahlEmployer;
    totals.paye += slip.paye;
    totals.netPay += slip.netPay;
  }
  return totals;
}
