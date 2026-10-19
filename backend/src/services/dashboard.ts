// ===========================================================================
// The operational dashboard + the merchant-readiness signal (Task T-A10). NO MIGRATION.
//
// THE DASHBOARD DERIVES — IT NEVER ACCOUNTS. Every money figure on it comes from a Module
// 13 report builder over the ledger's one balance query:
//   revenue, cost of sales, gross profit, operating expenses, net profit
//                                    <- buildIncomeStatement(period)
//   cash position (1000 / 1010 / 1020), receivables (1100), payables (2000)
//                                    <- buildBalanceSheet(as at the period's last day)
//   top expense categories            <- the income statement's operating-expense lines
// and the low-stock count is the existing low-stock feed's length (getLowStockAlerts).
// There is no SQL over journal lines here and no arithmetic beyond picking lines out and
// summing the three cash lines, so the dashboard can never disagree with the statements.
//
// READINESS is a set of concrete, derived checks over the tenant's own state — each with
// pass / fail and whether it is REQUIRED — and "ready to trade" is every required check
// passing. It writes nothing.
// ===========================================================================

import { tenantSchemaFor } from "../db/tenant";
import { platformDb } from "../db/platform";
import type { PrismaClient as TenantPrismaClient } from "../generated/tenant/client";
import type { Cents } from "../lib/money";
import { getLowStockAlerts } from "./allocation";
import { buildBalanceSheet, buildIncomeStatement, type BalanceSheet, type Period, type ReportLine } from "./reports";

export const DASHBOARD_CASH_ACCOUNTS: readonly string[] = ["1000", "1010", "1020"];
const RECEIVABLES_ACCOUNT = "1100";
const PAYABLES_ACCOUNT = "2000";
const TOP_EXPENSES = 5;

export interface DashboardAccount {
  readonly code: string;
  readonly name: string;
  readonly amount: Cents;
}

export interface Dashboard {
  readonly period: Period;
  readonly revenue: Cents;
  readonly costOfSales: Cents;
  readonly grossProfit: Cents;
  readonly operatingExpenses: Cents;
  readonly netProfit: Cents;
  readonly cashPosition: { readonly total: Cents; readonly accounts: DashboardAccount[] };
  readonly receivables: Cents;
  readonly payables: Cents;
  readonly topExpenseCategories: DashboardAccount[];
  readonly lowStockCount: number;
}

function lineOf(lines: readonly ReportLine[], code: string): ReportLine | undefined {
  return lines.find((line) => line.code === code);
}

/** A balance-sheet line by account code, from whichever section holds it (0 when absent). */
function balanceSheetLine(sheet: BalanceSheet, code: string): DashboardAccount {
  const line =
    lineOf(sheet.assets.current.lines, code) ??
    lineOf(sheet.assets.nonCurrent.lines, code) ??
    lineOf(sheet.liabilities.current.lines, code) ??
    lineOf(sheet.liabilities.longTerm.lines, code);
  return { code, name: line?.name ?? code, amount: line?.amount ?? 0n };
}

export async function buildDashboard(db: TenantPrismaClient, period: Period): Promise<Dashboard> {
  const source = { reader: db, schema: tenantSchemaFor(db) };
  const statement = await buildIncomeStatement(source, period, false);
  const sheet = await buildBalanceSheet(source, period.to, false);
  const cash = DASHBOARD_CASH_ACCOUNTS.map((code) => balanceSheetLine(sheet, code));
  const topExpenseCategories = statement.operatingExpenses.lines
    .filter((line) => line.code !== null && line.amount > 0n)
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
    .slice(0, TOP_EXPENSES)
    .map((line) => ({ code: line.code ?? "", name: line.name, amount: line.amount }));
  return {
    period,
    revenue: statement.revenue.total,
    costOfSales: statement.costOfSales.total,
    grossProfit: statement.grossProfit.amount,
    operatingExpenses: statement.operatingExpenses.total,
    netProfit: statement.netProfit.amount,
    cashPosition: { total: cash.reduce((sum, account) => sum + account.amount, 0n), accounts: cash },
    receivables: balanceSheetLine(sheet, RECEIVABLES_ACCOUNT).amount,
    payables: balanceSheetLine(sheet, PAYABLES_ACCOUNT).amount,
    topExpenseCategories,
    lowStockCount: (await getLowStockAlerts(db)).length,
  };
}

// ---- Readiness ---------------------------------------------------------------------

export type ReadinessKey = "ACTIVE_PRODUCT" | "STOCK_OR_SERVICE" | "TAX_REGIME_SET" | "FIRST_SALE" | "KRA_PIN" | "STAFF_BEYOND_OWNER";

export interface ReadinessCheck {
  readonly key: ReadinessKey;
  readonly label: string;
  /** Required checks decide "ready to trade"; the others are recommended next steps. */
  readonly required: boolean;
  readonly pass: boolean;
  readonly detail: string;
}

export interface Readiness {
  readonly readyToTrade: boolean;
  readonly checks: ReadinessCheck[];
}

export async function buildReadiness(db: TenantPrismaClient, tenantId: string): Promise<Readiness> {
  const activeProducts = await db.product.count({ where: { isActive: true } });
  const stockedGoods = await db.product.count({ where: { isActive: true, kind: "GOOD", stockCount: { gt: 0 } } });
  const activeServices = await db.product.count({ where: { isActive: true, kind: "SERVICE" } });
  const profile = await db.businessProfile.findUnique({ where: { id: "singleton" }, select: { taxRegime: true, kraPin: true } });
  const completedSales = await db.sale.count({ where: { status: "COMPLETED" } });
  const otherStaff = await platformDb.user.count({ where: { tenantId, isActive: true, role: { not: "MSME_OWNER" } } });

  const checks: ReadinessCheck[] = [
    {
      key: "ACTIVE_PRODUCT",
      label: "At least one active product in the catalog",
      required: true,
      pass: activeProducts > 0,
      detail: `${activeProducts.toString()} active product(s).`,
    },
    {
      key: "STOCK_OR_SERVICE",
      label: "Something to sell: goods in stock (opening stock or a receipt) or an active service",
      required: true,
      pass: stockedGoods > 0 || activeServices > 0,
      detail: `${stockedGoods.toString()} stocked good(s), ${activeServices.toString()} active service(s).`,
    },
    {
      key: "TAX_REGIME_SET",
      label: "Tax regime recorded on the business profile",
      required: true,
      pass: profile !== null,
      detail: profile === null ? "No business profile." : `Regime: ${profile.taxRegime}.`,
    },
    {
      key: "FIRST_SALE",
      label: "First sale recorded",
      required: false,
      pass: completedSales > 0,
      detail: `${completedSales.toString()} completed sale(s).`,
    },
    {
      key: "KRA_PIN",
      label: "Business KRA PIN recorded",
      required: false,
      pass: profile?.kraPin !== null && profile?.kraPin !== undefined,
      detail: profile?.kraPin === null || profile?.kraPin === undefined ? "Not recorded." : "Recorded.",
    },
    {
      key: "STAFF_BEYOND_OWNER",
      label: "Staff invited beyond the owner",
      required: false,
      pass: otherStaff > 0,
      detail: `${otherStaff.toString()} other active staff.`,
    },
  ];
  return { readyToTrade: checks.every((check) => !check.required || check.pass), checks };
}
