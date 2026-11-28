// ===========================================================================
// REPORT CLASSIFICATION — the ONE map from the chart of accounts to financial-
// statement lines (Module 13).
//
// Every statement places an account by asking this file, and nothing else in the
// codebase decides where an account is presented. The map is by CODE RANGE, and each
// rule also names the `accountClass` it expects: an account whose class disagrees
// with its range, or an account no rule covers, is REFUSED (`ReportClassificationError`)
// rather than dropped or guessed. A new account that nobody classified would
// otherwise vanish from the balance sheet while the ledger still carried it, and the
// statement would stop balancing for a reason nobody could see.
//
// The ranges follow the IFRS-classified chart (the engineering ledger "Double-Entry Ledger
// Formatting"). If they ever prove too rigid, the future plug is an
// `Account.reportCategory` column read here instead — not a second map elsewhere.
// ===========================================================================

import type { AccountClass } from "../generated/tenant/enums";

/** Where an account is presented. CASH is a subset of current assets. */
export type StatementSection =
  | "CASH"
  | "CURRENT_ASSET"
  | "NON_CURRENT_ASSET"
  | "CURRENT_LIABILITY"
  | "LONG_TERM_LIABILITY"
  | "EQUITY"
  | "REVENUE"
  | "COST_OF_SALES"
  | "OPERATING_EXPENSE";

/**
 * Where a NON-CASH balance-sheet account's movement appears in the INDIRECT cash
 * flow. EVERY balance-sheet account outside the cash set is in exactly one bucket —
 * that completeness is what makes "net change in cash == closing − opening cash" an
 * identity rather than a hope, because every balanced entry moves cash only by moving
 * something else that is listed here or in profit.
 */
export type CashFlowBucket = "WORKING_CAPITAL" | "NON_CASH" | "INVESTING" | "FINANCING";

interface Rule {
  from: string;
  to: string;
  section: StatementSection;
  accountClass: AccountClass;
}

// Inclusive code ranges, checked in order. 4-digit codes compare correctly as strings.
const RULES: readonly Rule[] = [
  { from: "1000", to: "1020", section: "CASH", accountClass: "ASSET" }, // 1000 Cash, 1010 M-Pesa Till, 1015 M-Pesa Clearing, 1020 Bank
  { from: "1100", to: "1499", section: "CURRENT_ASSET", accountClass: "ASSET" }, // 1100 AR, 1200 Inventory, 1300 Prepaid, 1400 VAT Input
  { from: "1500", to: "1599", section: "NON_CURRENT_ASSET", accountClass: "ASSET" }, // 1500/1510 fixed assets, 1590 accumulated depreciation (contra)
  { from: "2000", to: "2399", section: "CURRENT_LIABILITY", accountClass: "LIABILITY" }, // AP, GRNI, VAT, TOT, net salaries, statutory heads, accruals
  { from: "2400", to: "2499", section: "LONG_TERM_LIABILITY", accountClass: "LIABILITY" }, // 2400 Loans
  { from: "2500", to: "2599", section: "CURRENT_LIABILITY", accountClass: "LIABILITY" }, // 2500 Customer deposits
  { from: "3000", to: "3999", section: "EQUITY", accountClass: "EQUITY" }, // 3000 Capital, 3100 Drawings (contra), 3200 Retained Earnings
  { from: "4000", to: "4999", section: "REVENUE", accountClass: "REVENUE" }, // 4000/4100/4200, 4900 Returns (contra)
  { from: "5000", to: "5999", section: "COST_OF_SALES", accountClass: "COST_OF_SALES" }, // 5000 COGS, 5100, 5200, 5250 PPV, 5300 write-offs
  { from: "6000", to: "6999", section: "OPERATING_EXPENSE", accountClass: "EXPENSE" }, // 6000–6900
];

/** The cash and cash-equivalents set the cash flow statement ties to. */
export const CASH_ACCOUNTS: ReadonlySet<string> = new Set(["1000", "1010", "1015", "1020"]);

/** Accumulated depreciation — the contra asset whose movement is the non-cash add-back. */
export const ACCUMULATED_DEPRECIATION = "1590";

export class ReportClassificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportClassificationError";
  }
}

/** The statement section an account belongs to, or a refusal naming why it has none. */
export function sectionOf(code: string, accountClass: AccountClass): StatementSection {
  const rule = RULES.find((r) => code >= r.from && code <= r.to);
  if (rule === undefined) {
    throw new ReportClassificationError(
      `Account ${code} (${accountClass}) is not covered by any report-classification range, so no statement would show it. Add it to src/services/report-classification.ts rather than letting it disappear from the balance sheet.`,
    );
  }
  if (rule.accountClass !== accountClass) {
    throw new ReportClassificationError(
      `Account ${code} is ${accountClass} but its code range ${rule.from}–${rule.to} is ${rule.accountClass}. Fix the account or the classification; a statement will not present an account under the wrong class.`,
    );
  }
  return rule.section;
}

/** Profit-and-loss sections. Everything else is a balance-sheet account. */
export function isIncomeStatementSection(section: StatementSection): boolean {
  return section === "REVENUE" || section === "COST_OF_SALES" || section === "OPERATING_EXPENSE";
}

/**
 * The cash flow bucket of a NON-CASH balance-sheet account.
 *   - current assets and current liabilities  -> WORKING_CAPITAL (operating)
 *   - accumulated depreciation (1590)          -> NON_CASH add-back (operating)
 *   - other non-current assets                 -> INVESTING
 *   - long-term liabilities and ALL equity     -> FINANCING (3200 included: a direct
 *     posting to retained earnings is an equity movement and must be listed, or the
 *     tie-out would break the day an accountant made one)
 */
export function cashFlowBucketOf(code: string, section: StatementSection): CashFlowBucket {
  switch (section) {
    case "CURRENT_ASSET":
    case "CURRENT_LIABILITY":
      return "WORKING_CAPITAL";
    case "NON_CURRENT_ASSET":
      return code === ACCUMULATED_DEPRECIATION ? "NON_CASH" : "INVESTING";
    case "LONG_TERM_LIABILITY":
    case "EQUITY":
      return "FINANCING";
    default:
      throw new ReportClassificationError(
        `Account ${code} (${section}) has no cash flow bucket: only non-cash balance-sheet accounts do.`,
      );
  }
}
