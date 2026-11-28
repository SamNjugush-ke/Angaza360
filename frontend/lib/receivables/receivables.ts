import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";

// Customers & receivables: the customer directory (owner, manager, cashier), and what customers owe
// on credit — open credit sales, receipts, aging, statements (owner, manager, accountant, auditor).
// Shapes from the generated API types; money in a REQUEST is shillings, in a RESPONSE cents.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Body<T> = T extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

export type CustomerList = Json<paths["/v1/customers/"]["get"]["responses"][200]>;
export type Customer = CustomerList["data"][number];
export type CustomerCreateBody = Body<paths["/v1/customers/"]["post"]>;
export type CustomerUpdateBody = Body<paths["/v1/customers/{id}"]["patch"]>;
export type OpenList = Json<paths["/v1/receivables/open"]["get"]["responses"][200]>;
export type OpenSale = OpenList["data"][number];
export type ReceiptList = Json<paths["/v1/receivables/receipts"]["get"]["responses"][200]>;
export type Receipt = ReceiptList["data"][number];
export type ReceiptMethod = Receipt["method"];
export type ReceiptBody = Body<paths["/v1/receivables/receipts"]["post"]>;
export type ArAging = Json<paths["/v1/receivables/aging"]["get"]["responses"][200]>;
export type ArAgingRow = ArAging["customers"][number];
export type CustomerStatement = Json<paths["/v1/receivables/customers/{id}/statement"]["get"]["responses"][200]>;

// ---- Who may do what (the API's guards) ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
export const receivablesPermissions = (role: Role) => ({
  /** GET /v1/customers — the directory. Not the accountant or the auditor. */
  canReadDirectory: has(["MSME_OWNER", "MSME_MANAGER", "CASHIER"])(role),
  canCreateCustomer: has(["MSME_OWNER", "MSME_MANAGER", "CASHIER"])(role),
  /** PATCH /v1/customers/:id, and setting a credit limit. */
  canEditCustomer: has(["MSME_OWNER", "MSME_MANAGER"])(role),
  /** Every /v1/receivables read. Not the cashier. */
  canReadReceivables: has(["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR"])(role),
  /** POST /v1/receivables/receipts. */
  canRecordReceipt: has(["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT"])(role),
});
export type ReceivablesPermissions = ReturnType<typeof receivablesPermissions>;

// ---- Calls ----

export const fetchCustomers = () => getJson<CustomerList>("/customers");
export const createCustomer = (body: CustomerCreateBody) => sendJson<Customer>("POST", "/customers", body);
export const updateCustomer = (id: string, body: CustomerUpdateBody) => sendJson<Customer>("PATCH", `/customers/${encodeURIComponent(id)}`, body);
export const fetchOpen = (customerId?: string) => getJson<OpenList>(withParams("/receivables/open", { customerId }));
export const fetchReceipts = (method: ReceiptMethod | "", customerId?: string) => getJson<ReceiptList>(withParams("/receivables/receipts", { method: method || undefined, customerId }));
export const recordReceipt = (body: ReceiptBody) => sendJson<Receipt>("POST", "/receivables/receipts", body);
export const fetchArAging = (asOf: string) => getJson<ArAging>(withParams("/receivables/aging", { asOf }));
export const fetchStatement = (customerId: string) => getJson<CustomerStatement>(`/receivables/customers/${encodeURIComponent(customerId)}/statement`);

// ---- Queries ----

export const receivablesKeys = {
  all: ["receivables"] as const,
  customers: () => ["pos", "customers"] as const,
  open: (customerId: string) => ["receivables", "open", customerId] as const,
  receipts: (method: string, customerId: string) => ["receivables", "receipts", method, customerId] as const,
  aging: (asOf: string) => ["receivables", "aging", asOf] as const,
  statement: (customerId: string) => ["receivables", "statement", customerId] as const,
};

export const useCustomers = (enabled: boolean) => useQuery({ queryKey: receivablesKeys.customers(), queryFn: fetchCustomers, enabled, staleTime: 0 });
export const useOpen = (customerId: string, enabled: boolean) => useQuery({ queryKey: receivablesKeys.open(customerId), queryFn: () => fetchOpen(customerId || undefined), enabled, staleTime: 0 });
export const useReceipts = (method: ReceiptMethod | "", customerId: string, enabled: boolean) =>
  useQuery({ queryKey: receivablesKeys.receipts(method, customerId), queryFn: () => fetchReceipts(method, customerId || undefined), enabled, staleTime: 0 });
export const useArAging = (asOf: string, enabled: boolean) => useQuery({ queryKey: receivablesKeys.aging(asOf), queryFn: () => fetchArAging(asOf), enabled, staleTime: 0 });
export const useStatement = (customerId: string, enabled: boolean) => useQuery({ queryKey: receivablesKeys.statement(customerId), queryFn: () => fetchStatement(customerId), enabled, staleTime: 0 });

/** After a receipt or a customer edit: balances, open items, statements and aging are stale. */
export function useInvalidateReceivables(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await client.invalidateQueries({ queryKey: receivablesKeys.all });
    await client.invalidateQueries({ queryKey: receivablesKeys.customers() });
  }, [client]);
}

export const METHOD_LABEL: Readonly<Record<ReceiptMethod, string>> = { CASH: "Cash", BANK: "Bank", MPESA: "M-Pesa" };
