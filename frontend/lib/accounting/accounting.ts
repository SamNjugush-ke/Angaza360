import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// Accounting & reports: the chart of accounts, the journal and an account's ledger, accounting
// periods, and the Module 13 statements. Shapes from the generated API types; money in a REQUEST
// is shillings ("150.00"), in a RESPONSE cents. Every figure on a statement is the server's — the
// screen lays the statement out, it never computes a balance.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

export type AccountList = Json<paths["/v1/accounts/"]["get"]["responses"][200]>;
export type Account = AccountList["data"][number];
export type AccountClass = Account["accountClass"];
export type EntryList = Json<paths["/v1/ledger/entries"]["get"]["responses"][200]>;
export type EntryRow = EntryList["data"][number];
export type EntryDetail = Json<paths["/v1/ledger/entries/{id}"]["get"]["responses"][200]>;
export type EntryBody = Body<paths["/v1/ledger/entries"]["post"]>;
export type PostedEntry = Json<paths["/v1/ledger/entries"]["post"]["responses"][201]>;
export type ReversedEntry = Json<paths["/v1/ledger/entries/{id}/reverse"]["post"]["responses"][201]>;
export type AccountLedger = Json<paths["/v1/ledger/accounts/{code}/ledger"]["get"]["responses"][200]>;
export type PeriodList = Json<paths["/v1/ledger/periods"]["get"]["responses"][200]>;
export type Period = PeriodList["data"][number];
export type IncomeStatement = Json<paths["/v1/reports/income-statement"]["get"]["responses"][200]>;
export type BalanceSheet = Json<paths["/v1/reports/balance-sheet"]["get"]["responses"][200]>;
export type CashFlow = Json<paths["/v1/reports/cash-flow"]["get"]["responses"][200]>;
export type TrialBalance = Json<paths["/v1/reports/trial-balance"]["get"]["responses"][200]>;
export type ControlReconciliation = Json<paths["/v1/reports/control-reconciliation"]["get"]["responses"][200]>;
export type TopProducts = Json<paths["/v1/reports/top-products"]["get"]["responses"][200]>;
export type Section = IncomeStatement["revenue"];
export type Figure = IncomeStatement["netProfit"];

// ---- Who may do what (the API's guards) ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
export const accountingPermissions = (role: Role) => ({
  /** POST /entries, /entries/:id/reverse and /periods/:y/:m/close — the owner and the accountant. */
  canPost: has(["MSME_OWNER", "ACCOUNTANT"])(role),
  canClosePeriod: has(["MSME_OWNER", "ACCOUNTANT"])(role),
  /** POST /periods/:y/:m/reopen — the owner alone. */
  canReopenPeriod: has(["MSME_OWNER"])(role),
});
export type AccountingPermissions = ReturnType<typeof accountingPermissions>;

/**
 * Accounts a MANUAL entry must not touch — the backend's subledger control set
 * (src/services/control-accounts.ts, T-B-JE-CONTROL-GUARD), which the API refuses (400) and migration
 * 0032 holds at the database: 1015 M-Pesa Clearing, 1100 Receivables, 1200 Inventory, 2000 Payables and
 * 2050 GRNI. They are left out of the journal form's account picker.
 */
export const CONTROL_ACCOUNTS: ReadonlySet<string> = new Set(["1015", "1100", "1200", "2000", "2050"]);

// ---- Calls ----

export const fetchAccounts = () => getJson<AccountList>("/accounts");
export const fetchEntries = (params: { from?: string; to?: string; accountCode?: string; skip: number; take: number }) =>
  getJson<EntryList>(withParams("/ledger/entries", { from: params.from, to: params.to, accountCode: params.accountCode, skip: params.skip.toString(), take: params.take.toString() }));
export const fetchEntry = (id: string) => getJson<EntryDetail>(`/ledger/entries/${encodeURIComponent(id)}`);
export const postEntry = (body: EntryBody) => sendJson<PostedEntry>("POST", "/ledger/entries", body);
export const reverseEntry = (id: string, reason: string) => sendJson<ReversedEntry>("POST", `/ledger/entries/${encodeURIComponent(id)}/reverse`, { reason });
export const fetchAccountLedger = (code: string, skip: number, take: number) =>
  getJson<AccountLedger>(withParams(`/ledger/accounts/${encodeURIComponent(code)}/ledger`, { skip: skip.toString(), take: take.toString() }));
export const fetchPeriods = () => getJson<PeriodList>("/ledger/periods");
export const setPeriod = (year: number, month: number, action: "close" | "reopen") => sendJson<Period>("POST", `/ledger/periods/${year.toString()}/${month.toString()}/${action}`);

/** A report request: a period (from/to, year+month, or year) or an as-at date; comparative on or off. */
export type ReportQuery = Readonly<Record<string, string | undefined>>;
const report = <T>(path: string) => (query: ReportQuery) => getJson<T>(withParams(`/reports/${path}`, query));
export const fetchIncomeStatement = report<IncomeStatement>("income-statement");
export const fetchBalanceSheet = report<BalanceSheet>("balance-sheet");
export const fetchCashFlow = report<CashFlow>("cash-flow");
export const fetchTrialBalance = report<TrialBalance>("trial-balance");
export const fetchTopProducts = report<TopProducts>("top-products");
export const fetchControls = () => getJson<ControlReconciliation>("/reports/control-reconciliation");

// ---- Queries ----

export const accountingKeys = {
  all: ["accounting"] as const,
  accounts: () => ["accounts"] as const,
  entries: (query: string) => ["accounting", "entries", query] as const,
  entry: (id: string) => ["accounting", "entry", id] as const,
  ledger: (code: string, page: number) => ["accounting", "ledger", code, page] as const,
  periods: () => ["accounting", "periods"] as const,
  report: (name: string, query: ReportQuery) => ["accounting", "report", name, query] as const,
};

export const useAccounts = () => useQuery({ queryKey: accountingKeys.accounts(), queryFn: fetchAccounts });
export const ENTRIES_PAGE = 25;
export function useEntries(params: { from?: string; to?: string; accountCode?: string }, page: number) {
  const query = { ...params, skip: page * ENTRIES_PAGE, take: ENTRIES_PAGE };
  return useQuery({ queryKey: accountingKeys.entries(JSON.stringify(query)), queryFn: () => fetchEntries(query), placeholderData: keepPreviousData, staleTime: 0 });
}
export const useEntry = (id: string) => useQuery({ queryKey: accountingKeys.entry(id), queryFn: () => fetchEntry(id), staleTime: 0 });
export const LEDGER_PAGE = 50;
export const useAccountLedger = (code: string, page: number) =>
  useQuery({ queryKey: accountingKeys.ledger(code, page), queryFn: () => fetchAccountLedger(code, page * LEDGER_PAGE, LEDGER_PAGE), placeholderData: keepPreviousData, staleTime: 0 });
export const usePeriods = () => useQuery({ queryKey: accountingKeys.periods(), queryFn: fetchPeriods, staleTime: 0 });
export function useReport<T>(name: string, fetcher: (query: ReportQuery) => Promise<T>, query: ReportQuery | null) {
  return useQuery({ queryKey: accountingKeys.report(name, query ?? {}), queryFn: () => fetcher(query ?? {}), enabled: query !== null, staleTime: 0, retry: false });
}

/** After a posting, a reversal or a period change: every ledger read and every statement is stale. */
export function useInvalidateAccounting(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: accountingKeys.all });
  }, [client]);
}

// ---- Words ----

export const CLASS_LABEL: Readonly<Record<AccountClass, string>> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  REVENUE: "Revenue",
  COST_OF_SALES: "Cost of sales",
  EXPENSE: "Expenses",
};
export const CLASS_ORDER: readonly AccountClass[] = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "COST_OF_SALES", "EXPENSE"];

export const SOURCE_LABEL: Readonly<Record<EntryRow["source"], string>> = {
  MANUAL: "Manual",
  POS: "Sale",
  SALE_RETURN: "Sale return",
  PURCHASE: "Purchase",
  PAYROLL: "Payroll",
  EXPENSE: "Expense",
  INVENTORY_ADJUSTMENT: "Stock adjustment",
  BANK_RECONCILIATION: "Bank reconciliation",
  OPENING_BALANCE: "Opening balance",
  DEPRECIATION: "Depreciation",
} as Record<EntryRow["source"], string>;

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const periodName = (year: number, month: number) => `${MONTHS[month - 1] ?? ""} ${year.toString()}`;
