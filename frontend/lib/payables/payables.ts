import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// Expenses & payables: paid expenses, supplier bills (DRAFT → posted → paid / cancelled), supplier
// payments allocated against bills, the AP aging and supplier statements. Shapes from the generated
// API types; money in a REQUEST is shillings ("150.00"), in a RESPONSE cents. The screen books
// nothing itself — every figure (GRNI cleared, price variance, VAT, totals) is the server's.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

export type ExpenseList = Json<paths["/v1/expenses/"]["get"]["responses"][200]>;
export type Expense = ExpenseList["data"][number];
export type ExpenseBody = Body<paths["/v1/expenses/"]["post"]>;
export type ExpenseMethod = Expense["paymentMethod"];
export type BillList = Json<paths["/v1/payables/bills"]["get"]["responses"][200]>;
export type Bill = BillList["data"][number];
export type BillLine = Bill["lines"][number];
export type BillStatus = Bill["status"];
export type BillCreateBody = Body<paths["/v1/payables/bills"]["post"]>;
export type BillUpdateBody = Body<paths["/v1/payables/bills/{id}"]["patch"]>;
export type BillLineBody = BillCreateBody["lines"][number];
export type PaymentList = Json<paths["/v1/payables/payments"]["get"]["responses"][200]>;
export type Payment = PaymentList["data"][number];
export type PaymentMethod = Payment["method"];
export type PaymentBody = Body<paths["/v1/payables/payments"]["post"]>;
export type ApAging = Json<paths["/v1/payables/aging"]["get"]["responses"][200]>;
export type SupplierStatement = Json<paths["/v1/payables/suppliers/{id}/statement"]["get"]["responses"][200]>;
export type AccountList = Json<paths["/v1/accounts/"]["get"]["responses"][200]>;
export type Account = AccountList["data"][number];

// ---- Who may do what (the API's guards) ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
const WRITERS: readonly Role[] = ["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT"];
export const payablesPermissions = (role: Role) => ({
  /** POST /v1/expenses and /:id/void. */
  canRecordExpense: has(WRITERS)(role),
  /** POST / PATCH bills, post, cancel. */
  canEnterBills: has(WRITERS)(role),
  /** POST /v1/payables/payments. */
  canPay: has(WRITERS)(role),
  /**
   * GET /v1/inventory/suppliers is the owner's and manager's. The accountant enters bills too, so
   * for them the supplier is chosen from the purchase orders and bills they can read.
   */
  canReadSuppliers: has(["MSME_OWNER", "MSME_MANAGER"])(role),
});
export type PayablesPermissions = ReturnType<typeof payablesPermissions>;

// ---- Calls ----

export const fetchExpenses = (includeVoided: boolean) => getJson<ExpenseList>(withParams("/expenses", { includeVoided: includeVoided ? "true" : undefined }));
export const recordExpense = (body: ExpenseBody) => sendJson<Expense>("POST", "/expenses", body);
export const voidExpense = (id: string, reason: string) => sendJson<Expense>("POST", `/expenses/${encodeURIComponent(id)}/void`, { reason });
export const fetchBills = (status: BillStatus | "", supplierId?: string) => getJson<BillList>(withParams("/payables/bills", { status: status || undefined, supplierId }));
export const fetchBill = (id: string) => getJson<Bill>(`/payables/bills/${encodeURIComponent(id)}`);
export const createBill = (body: BillCreateBody) => sendJson<Bill>("POST", "/payables/bills", body);
export const updateBill = (id: string, body: BillUpdateBody) => sendJson<Bill>("PATCH", `/payables/bills/${encodeURIComponent(id)}`, body);
export const postBill = (id: string) => sendJson<Bill>("POST", `/payables/bills/${encodeURIComponent(id)}/post`);
export const cancelBill = (id: string, reason: string) => sendJson<Bill>("POST", `/payables/bills/${encodeURIComponent(id)}/cancel`, { reason });
export const fetchPayments = () => getJson<PaymentList>("/payables/payments");
export const payBills = (body: PaymentBody) => sendJson<Payment>("POST", "/payables/payments", body);
export const fetchApAging = (asOf: string) => getJson<ApAging>(withParams("/payables/aging", { asOf }));
export const fetchSupplierStatement = (id: string) => getJson<SupplierStatement>(`/payables/suppliers/${encodeURIComponent(id)}/statement`);
export const fetchAccounts = () => getJson<AccountList>("/accounts");

// ---- Queries ----

export const payablesKeys = {
  all: ["payables"] as const,
  expenses: (includeVoided: boolean) => ["payables", "expenses", includeVoided] as const,
  bills: (status: string, supplierId: string) => ["payables", "bills", status, supplierId] as const,
  bill: (id: string) => ["payables", "bill", id] as const,
  payments: () => ["payables", "payments"] as const,
  aging: (asOf: string) => ["payables", "aging", asOf] as const,
  statement: (id: string) => ["payables", "statement", id] as const,
  accounts: () => ["accounts"] as const,
};

export const useExpenses = (includeVoided: boolean) => useQuery({ queryKey: payablesKeys.expenses(includeVoided), queryFn: () => fetchExpenses(includeVoided), staleTime: 0 });
export const useBills = (status: BillStatus | "", supplierId = "", enabled = true) =>
  useQuery({ queryKey: payablesKeys.bills(status, supplierId), queryFn: () => fetchBills(status, supplierId || undefined), enabled, staleTime: 0 });
export const useBill = (id: string, initial: Bill | undefined) => useQuery({ queryKey: payablesKeys.bill(id), queryFn: () => fetchBill(id), placeholderData: initial, staleTime: 0 });
export const usePayments = () => useQuery({ queryKey: payablesKeys.payments(), queryFn: fetchPayments, staleTime: 0 });
export const useApAging = (asOf: string, enabled: boolean) => useQuery({ queryKey: payablesKeys.aging(asOf), queryFn: () => fetchApAging(asOf), enabled, staleTime: 0 });
export const useSupplierStatement = (id: string) => useQuery({ queryKey: payablesKeys.statement(id), queryFn: () => fetchSupplierStatement(id), staleTime: 0 });
export const useAccounts = (enabled: boolean) => useQuery({ queryKey: payablesKeys.accounts(), queryFn: fetchAccounts, enabled });

/** After any payables write: bills, payments, aging, statements and the stock-side GRNI views are stale. */
export function useInvalidatePayables(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: payablesKeys.all });
    await client.invalidateQueries({ queryKey: ["procurement"] });
  }, [client]);
}

// ---- Which accounts each form may charge (the API's rules; the server enforces them) ----

const NOT_AN_EXPENSE_CATEGORY = new Set(["6020", "6025", "6090", "6110"]);
/** An expense category: an active operating-expense account 6000–6999, except payroll (6020, 6025), depreciation (6090) and Turnover Tax (6110). */
export const expenseCategories = (accounts: readonly Account[]) =>
  accounts.filter((a) => a.isActive && a.accountClass === "EXPENSE" && /^6\d{3}$/.test(a.code) && !NOT_AN_EXPENSE_CATEGORY.has(a.code));

const NOT_A_BILL_ACCOUNT = new Set(["1200", "2000", "2050", "1400", "5250"]);
/** A bill line charged straight to an account: an expense, cost-of-sales or asset account, but none of this posting's own control accounts. */
export const billLineAccounts = (accounts: readonly Account[]) =>
  accounts.filter((a) => a.isActive && (a.accountClass === "EXPENSE" || a.accountClass === "COST_OF_SALES" || a.accountClass === "ASSET") && !NOT_A_BILL_ACCOUNT.has(a.code));

// ---- Words ----

export const METHOD_LABEL: Readonly<Record<PaymentMethod, string>> = { CASH: "Cash", BANK: "Bank", MPESA: "M-Pesa" };
export const BILL_STATUS_LABEL: Readonly<Record<BillStatus, string>> = {
  DRAFT: "Draft",
  AWAITING_PAYMENT: "Awaiting payment",
  PARTIALLY_PAID: "Part paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
};
export const BILL_STATUSES = Object.keys(BILL_STATUS_LABEL) as BillStatus[];
export const isOpenBill = (status: BillStatus) => status === "AWAITING_PAYMENT" || status === "PARTIALLY_PAID";
