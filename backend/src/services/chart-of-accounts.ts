import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { assertValidSchemaName } from "../db/tenant";
import type { AccountClass, NormalBalance } from "../generated/tenant/enums";

// ---------------------------------------------------------------------------
// Default Chart of Accounts for a Kenyan MSME (TechSpec §6.5.1). Seeded as
// system accounts into every tenant schema at provisioning. Codes are 4-digit
// and class-ranged; statement structure derives from accountClass + code order.
//
// A handful of accounts are CONTRA accounts — their normalBalance is
// deliberately the opposite of their class default (e.g. Accumulated
// Depreciation is an ASSET carried CREDIT). That is intentional, not a typo.
// ---------------------------------------------------------------------------

export interface ChartAccount {
  readonly code: string;
  readonly name: string;
  readonly accountClass: AccountClass;
  readonly normalBalance: NormalBalance;
  readonly description?: string;
}

export const DEFAULT_CHART_OF_ACCOUNTS: readonly ChartAccount[] = [
  // ---- ASSET (1000-1999, normal DEBIT unless noted) ----
  { code: "1000", name: "Cash on Hand", accountClass: "ASSET", normalBalance: "DEBIT" },
  { code: "1010", name: "M-Pesa Till / Paybill", accountClass: "ASSET", normalBalance: "DEBIT" },
  {
    code: "1015",
    name: "M-Pesa Clearing (STK Pending)",
    accountClass: "ASSET",
    normalBalance: "DEBIT",
    description:
      "Holds M-Pesa STK Push amounts promised but not yet settled to the till. Debited for the M-Pesa portion of a tender at sale time (money is not yet received); cleared to 1010 M-Pesa Till on a confirmed callback, or reversed on failure/timeout. TechSpec 6.3 / Task 3.3.",
  },
  { code: "1020", name: "Bank Account", accountClass: "ASSET", normalBalance: "DEBIT" },
  { code: "1100", name: "Accounts Receivable (Trade Debtors)", accountClass: "ASSET", normalBalance: "DEBIT" },
  { code: "1200", name: "Inventory", accountClass: "ASSET", normalBalance: "DEBIT" },
  { code: "1300", name: "Prepaid Expenses", accountClass: "ASSET", normalBalance: "DEBIT" },
  { code: "1400", name: "VAT Input (Recoverable)", accountClass: "ASSET", normalBalance: "DEBIT" },
  { code: "1500", name: "Fixed Assets — Equipment", accountClass: "ASSET", normalBalance: "DEBIT" },
  { code: "1510", name: "Fixed Assets — Furniture & Fittings", accountClass: "ASSET", normalBalance: "DEBIT" },
  // CONTRA — an ASSET carried with a CREDIT normal balance.
  { code: "1590", name: "Accumulated Depreciation", accountClass: "ASSET", normalBalance: "CREDIT" },

  // ---- LIABILITY (2000-2999, normal CREDIT) ----
  { code: "2000", name: "Accounts Payable (Trade Creditors)", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  {
    code: "2050",
    name: "Goods Received Not Invoiced (GRNI)",
    accountClass: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Received-not-invoiced clearing. Credited when goods arrive against a purchase order (the GRN accrues what is owed before the supplier's tax invoice exists); cleared to 2000 Accounts Payable when the bill is booked (Task 5.2). NEVER a destination for a sale, a payment, a transfer, a write-off or an adjustment — only a goods receipt puts value here and only a supplier bill takes it out. Task 5.1.",
  },
  { code: "2100", name: "VAT Output Payable", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  {
    code: "2110",
    name: "Turnover Tax (TOT) Payable",
    accountClass: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Turnover Tax accrued at 3% for MSMEs on the turnover tax regime (annual turnover KES 1M-50M). TechSpec 6.6.2.",
  },
  {
    code: "2120",
    name: "Net Salaries Payable",
    accountClass: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Net pay owed to employees between the payroll ACCRUAL and the day it is actually paid. A payroll run credits it with the sum of every payslip's net pay (Task 8.1); settling it debits it against cash (Task 8.2). It is the employee-facing counterpart of 2000 Accounts Payable, kept separate because what is owed to staff and what is owed to suppliers are answered by different reports and paid on different days.",
  },
  { code: "2200", name: "PAYE Payable", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2210", name: "NSSF Payable", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2220", name: "SHA Payable", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2230", name: "Housing Levy Payable", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2300", name: "Accrued Expenses", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  { code: "2400", name: "Loans Payable", accountClass: "LIABILITY", normalBalance: "CREDIT" },
  {
    code: "2500",
    name: "Customer Deposits & Layaway",
    accountClass: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Advance payments and layaway deposits received from customers. A liability until goods are delivered; never recognised as revenue on receipt. TechSpec 6.3.2.",
  },

  // ---- EQUITY (3000-3999, normal CREDIT unless noted) ----
  { code: "3000", name: "Owner's Capital", accountClass: "EQUITY", normalBalance: "CREDIT" },
  // CONTRA — EQUITY carried with a DEBIT normal balance.
  { code: "3100", name: "Owner's Drawings", accountClass: "EQUITY", normalBalance: "DEBIT" },
  { code: "3200", name: "Retained Earnings", accountClass: "EQUITY", normalBalance: "CREDIT" },

  // ---- REVENUE (4000-4999, normal CREDIT unless noted) ----
  { code: "4000", name: "Sales Revenue", accountClass: "REVENUE", normalBalance: "CREDIT" },
  { code: "4100", name: "Service Income", accountClass: "REVENUE", normalBalance: "CREDIT" },
  { code: "4200", name: "Other Income", accountClass: "REVENUE", normalBalance: "CREDIT" },
  // CONTRA — REVENUE carried with a DEBIT normal balance.
  { code: "4900", name: "Sales Returns & Discounts", accountClass: "REVENUE", normalBalance: "DEBIT" },

  // ---- COST_OF_SALES (5000-5999, normal DEBIT) ----
  { code: "5000", name: "Cost of Goods Sold", accountClass: "COST_OF_SALES", normalBalance: "DEBIT" },
  { code: "5100", name: "Direct Labour", accountClass: "COST_OF_SALES", normalBalance: "DEBIT" },
  { code: "5200", name: "Freight Inwards", accountClass: "COST_OF_SALES", normalBalance: "DEBIT" },
  {
    code: "5250",
    name: "Purchase Price Variance",
    accountClass: "COST_OF_SALES",
    normalBalance: "DEBIT",
    description:
      "The difference between the cost a goods receipt accrued (the PO's unit cost) and the net cost the supplier actually invoiced. Posted when a bill is booked against a GRN (Task 5.2), so that inventory keeps the cost it was received at and the discrepancy is visible in cost of sales rather than silently restating stock. Task 5.1 creates the account; 5.2 posts to it.",
  },
  {
    code: "5300",
    name: "Inventory Write-offs (Damage, Expiry & Shrinkage)",
    accountClass: "COST_OF_SALES",
    normalBalance: "DEBIT",
    description:
      "Inventory losses from damage, expiry and stock count variances. Recognised within cost of sales per IFRS for SMEs so gross margin reflects true product cost. TechSpec 6.4.1.",
  },

  // ---- EXPENSE (6000-6999, normal DEBIT) ----
  { code: "6000", name: "Rent", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6010", name: "Utilities (Electricity & Water)", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6020", name: "Salaries & Wages", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  {
    code: "6025",
    name: "Employer Statutory Contributions",
    accountClass: "EXPENSE",
    normalBalance: "DEBIT",
    description:
      "The EMPLOYER's own share of statutory contributions — matched NSSF and the employer half of the Affordable Housing Levy (Task 8.1). It is a cost of employment ON TOP of gross pay, which is why it is its own expense line and not folded into 6020: an employee's gross is what they earned, while this is what employing them additionally cost. The employee's own deductions are never an expense — they come OUT of the gross already in 6020.",
  },
  { code: "6030", name: "Transport & Fuel", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6040", name: "Marketing & Advertising", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6050", name: "Communication (Airtime & Internet)", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6060", name: "Repairs & Maintenance", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6070", name: "Professional Fees", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6080", name: "Bank & M-Pesa Charges", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6090", name: "Depreciation Expense", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  { code: "6100", name: "Insurance", accountClass: "EXPENSE", normalBalance: "DEBIT" },
  {
    code: "6110",
    name: "Turnover Tax",
    accountClass: "EXPENSE",
    normalBalance: "DEBIT",
    description:
      "Turnover Tax accrued on gross sales by a TURNOVER_TAX tenant (Task 3B.2): rate x turnover per sale, credited to 2110 TOT Payable in the same entry. A final tax on the BUSINESS, not charged to the customer — which is why it is an expense rather than a deduction from revenue, and why it never appears on a receipt.",
  },
  { code: "6900", name: "Miscellaneous Expenses", accountClass: "EXPENSE", normalBalance: "DEBIT" },
];

// Inclusive numeric band for each account class (TechSpec §6.5.1).
const CLASS_RANGES: Record<AccountClass, readonly [number, number]> = {
  ASSET: [1000, 1999],
  LIABILITY: [2000, 2999],
  EQUITY: [3000, 3999],
  REVENUE: [4000, 4999],
  COST_OF_SALES: [5000, 5999],
  EXPENSE: [6000, 6999],
};

/**
 * Throw if a code is not a 4-digit number inside its class band. Codes are not
 * money, so Number() is fine here — the no-float rule applies only to money.ts.
 */
export function assertCodeInClassRange(code: string, accountClass: AccountClass): void {
  if (!/^\d{4}$/.test(code)) {
    throw new Error(`Account code "${code}" must be exactly 4 digits.`);
  }
  const numeric = Number(code);
  const [low, high] = CLASS_RANGES[accountClass];
  if (numeric < low || numeric > high) {
    throw new Error(
      `Account code "${code}" is outside the ${accountClass} band ${low}-${high}.`,
    );
  }
}

// Fail fast at module load: a mis-banded code becomes a startup error rather
// than a silently misfiled statement line at runtime.
for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
  assertCodeInClassRange(account.code, account.accountClass);
}

/**
 * Seed the default chart of accounts into a tenant schema using an EXISTING
 * pooled client (so it can join the provisioning transaction). Idempotent via
 * ON CONFLICT ("code") DO NOTHING. Returns the number of rows actually
 * inserted. The enum casts are schema-qualified because the AccountClass /
 * NormalBalance types live in the tenant schema, not on the current
 * search_path.
 */
export async function seedChartOfAccounts(
  client: PoolClient,
  schema: string,
): Promise<number> {
  assertValidSchemaName(schema);

  let inserted = 0;
  for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
    const result = await client.query(
      `INSERT INTO "${schema}"."accounts"
         ("id", "code", "name", "accountClass", "normalBalance", "description",
          "isSystem", "isActive", "createdAt", "updatedAt")
       VALUES
         ($1, $2, $3, $4::"${schema}"."AccountClass", $5::"${schema}"."NormalBalance", $6,
          true, true, now(), now())
       ON CONFLICT ("code") DO NOTHING`,
      [
        randomUUID(),
        account.code,
        account.name,
        account.accountClass,
        account.normalBalance,
        account.description ?? null,
      ],
    );
    inserted += result.rowCount ?? 0;
  }

  return inserted;
}
