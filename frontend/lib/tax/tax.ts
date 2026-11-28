import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { paths } from "@/lib/api/schema";
import { getJson, sendJson, withParams } from "@/lib/api/request";
import type { Role } from "@/lib/auth/landing";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import type { SaleList } from "@/lib/pos/types";

// KRA eTIMS & tax: the fiscal invoices KRA has (or has not yet) accepted, filing a sale after the
// fact, the tenant's OSCU device, and the VAT return / Turnover Tax position. eTIMS posts NOTHING
// to the books — every sale here is already final with its VAT posted; what an invoice adds is the
// attestation to KRA. Money in a response is cents strings; the tax figures are the server's.

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type InvoiceList = Json<paths["/v1/etims/invoices"]["get"]["responses"][200]>;
export type Invoice = InvoiceList["data"][number];
export type InvoiceStatus = Invoice["status"];
export type Device = Json<paths["/v1/etims/device"]["get"]["responses"][200]>;
export type InitResult = Json<paths["/v1/etims/device/initialize"]["post"]["responses"][200]>;
export type SignResult = Json<paths["/v1/etims/sales/{saleId}/sign"]["post"]["responses"][200]>;
export type CreditNoteResult = Json<paths["/v1/etims/sales/{saleId}/credit-note"]["post"]["responses"][200]>;
export type VatReturn = Json<paths["/v1/reports/vat-return"]["get"]["responses"][200]>;

// ---- Who may do what (the API's guards, routes/etims.ts) ----

const has = (roles: readonly Role[]) => (role: Role) => roles.includes(role);
export const taxPermissions = (role: Role) => ({
  /** POST /sales/:id/sign — a till action (the cashier too, at the till). */
  canSign: has(["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER"])(role),
  /** POST /invoices/:id/retry and /sales/:id/credit-note — an accounting correction. */
  canCorrect: has(["MSME_OWNER", "ACCOUNTANT"])(role),
  /** GET /device. */
  canReadDevice: has(["MSME_OWNER", "ACCOUNTANT"])(role),
  /** POST /device/initialize — committing the business to file under its own KRA PIN. */
  canInitialize: has(["MSME_OWNER"])(role),
});
export type TaxPermissions = ReturnType<typeof taxPermissions>;

// ---- Calls ----

export const fetchInvoices = (filters: { status?: InvoiceStatus | ""; invoiceType?: Invoice["invoiceType"] | ""; saleId?: string }) =>
  getJson<InvoiceList>(withParams("/etims/invoices", { status: filters.status || undefined, invoiceType: filters.invoiceType || undefined, saleId: filters.saleId }));
export const fetchInvoice = (id: string) => getJson<Invoice>(`/etims/invoices/${encodeURIComponent(id)}`);
export const retryInvoice = (id: string) => sendJson<Invoice>("POST", `/etims/invoices/${encodeURIComponent(id)}/retry`);
export const signSale = (saleId: string) => sendJson<SignResult>("POST", `/etims/sales/${encodeURIComponent(saleId)}/sign`);
export const creditNote = (saleId: string, reason: string) => sendJson<CreditNoteResult>("POST", `/etims/sales/${encodeURIComponent(saleId)}/credit-note`, { reason });
export const initializeDevice = () => sendJson<InitResult>("POST", "/etims/device/initialize");
export const fetchVatReturn = (query: Readonly<Record<string, string | undefined>>) => getJson<VatReturn>(withParams("/reports/vat-return", query));
/** Completed sales whose number contains `q` — to pick one to file with KRA. */
export const searchSales = (q: string) => getJson<SaleList>(withParams("/pos/sales", { q, status: "COMPLETED", take: "10" }));

/** The device, or null when none has ever been initialized (a 404 is the normal state for a business that does not file). */
export async function fetchDevice(): Promise<Device | null> {
  try {
    return await getJson<Device>("/etims/device");
  } catch (failure) {
    if (failure instanceof ApiHttpError && failure.status === 404) return null;
    throw failure;
  }
}

// ---- Queries ----

export const taxKeys = {
  all: ["etims"] as const,
  invoices: (filters: string) => ["etims", "invoices", filters] as const,
  invoice: (id: string) => ["etims", "invoice", id] as const,
  device: () => ["etims", "device"] as const,
  sales: (q: string) => ["etims", "sales", q] as const,
  vat: (query: string) => ["etims", "vat", query] as const,
};

export const useInvoices = (filters: { status: InvoiceStatus | ""; invoiceType: Invoice["invoiceType"] | "" }) =>
  useQuery({ queryKey: taxKeys.invoices(JSON.stringify(filters)), queryFn: () => fetchInvoices(filters), staleTime: 0 });
export const useInvoice = (id: string) => useQuery({ queryKey: taxKeys.invoice(id), queryFn: () => fetchInvoice(id), staleTime: 0 });
/** The credit notes filed against one sale — to know whether its reversal is already on record. */
export const useSaleInvoices = (saleId: string) => useQuery({ queryKey: taxKeys.invoices(JSON.stringify({ saleId })), queryFn: () => fetchInvoices({ saleId }), staleTime: 0 });
export const useDevice = (enabled: boolean) => useQuery({ queryKey: taxKeys.device(), queryFn: fetchDevice, enabled, staleTime: 0 });
export const useSaleSearch = (q: string) => useQuery({ queryKey: taxKeys.sales(q), queryFn: () => searchSales(q), enabled: q !== "", staleTime: 0 });
export const useVatReturn = (query: Readonly<Record<string, string | undefined>> | null) =>
  useQuery({ queryKey: taxKeys.vat(JSON.stringify(query ?? {})), queryFn: () => fetchVatReturn(query ?? {}), enabled: query !== null, staleTime: 0, retry: false });

/** After a sign, a retry, a credit note or a device change: every eTIMS read is stale, and so is any sale list. */
export function useInvalidateTax(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([client.invalidateQueries({ queryKey: taxKeys.all }), client.invalidateQueries({ queryKey: ["sales"] })]);
  }, [client]);
}

// ---- Words ----

/**
 * An INVOICE's status, and what it means for the SALE. The list filters by the invoice's status;
 * the sale reads PENDING_ETIMS while its invoice is PENDING or QUEUED and FAILED once it is
 * REJECTED or FAILED. A sale with no invoice at all is NOT_REQUESTED — it is found under "File a sale".
 */
export const STATUS_LABEL: Readonly<Record<InvoiceStatus, string>> = {
  SIGNED: "Signed by KRA",
  PENDING: "Pending submission",
  QUEUED: "Queued — KRA unreachable",
  REJECTED: "Rejected by KRA",
  FAILED: "Failed — retries used up",
};
export const STATUS_MEANING: Readonly<Record<InvoiceStatus, string>> = {
  SIGNED: "KRA accepted it. The receipt number, signature and QR are now a permanent fiscal record.",
  PENDING: "Recorded and waiting to be submitted. The sale reads “KRA invoice pending”.",
  QUEUED: "KRA could not be reached. It is retried automatically with the same invoice number, so it can never be filed twice.",
  REJECTED: "KRA was reached and refused it, for the reason shown. It is never retried on its own: fix the cause, then resubmit.",
  FAILED: "The automatic retries were used up without reaching KRA. Resubmit it once KRA is reachable.",
};
export const STATUS_ORDER: readonly InvoiceStatus[] = ["REJECTED", "FAILED", "QUEUED", "PENDING", "SIGNED"];
export const TYPE_LABEL: Readonly<Record<Invoice["invoiceType"], string>> = { SALE: "Sale invoice", CREDIT_NOTE: "Credit note" };

/** Whether a 400 from eTIMS means "not set up" (no credentials, eTIMS off, or an uninitialized device) rather than a problem with the sale. */
export function isNotSetUp(failure: unknown): boolean {
  return failure instanceof ApiHttpError && failure.status === 400 && /no active eTIMS credentials|has not been initialized|initialize|switched off|no active .*credential/i.test(failure.message);
}
