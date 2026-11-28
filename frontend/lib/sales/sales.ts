import { failureMessage } from "@/lib/api/messages";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/browser";
import type { Role } from "@/lib/auth/landing";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import type { BusinessDate } from "@/lib/datetime";
import type { MpesaChannel, SaleList, SaleRecord, SaleTenderBody } from "@/lib/pos/types";

// The Sales & receipts screen's data: the server filters and pages the sales (q on the sale
// number, status, customer, business-day dates, shift) and counts the filtered total; this module
// only builds the query and reads the answer. Money stays cents strings end to end.

export const PAGE_SIZE = 25;

export type SaleRow = SaleList["data"][number];
export type SaleStatusFilter = "" | "COMPLETED" | "VOIDED";

export interface SalesFilters {
  q: string;
  status: SaleStatusFilter;
  customerId: string;
  /** Business days (Africa/Nairobi), both inclusive. Ignored while `currentShift` is on. */
  from: BusinessDate;
  to: BusinessDate;
  /** Only the caller's open shift (its id from GET /pos/shifts/current). */
  currentShift: boolean;
}

/** Who may read customers (names, the customer filter) and the caller's own shift — the API's guards. */
const CUSTOMER_READERS: readonly Role[] = ["MSME_OWNER", "MSME_MANAGER", "CASHIER"];
const TILL_ROLES: readonly Role[] = ["MSME_OWNER", "MSME_MANAGER", "CASHIER"];
export const canReadCustomers = (role: Role) => CUSTOMER_READERS.includes(role);
export const hasTill = (role: Role) => TILL_ROLES.includes(role);

/** The query string for one page of filtered sales; null when the filters cannot be asked yet. */
export function salesQuery(filters: SalesFilters, page: number, shiftId: string | null): string | null {
  const params = new URLSearchParams({ take: PAGE_SIZE.toString(), skip: (page * PAGE_SIZE).toString() });
  const q = filters.q.trim();
  if (q !== "") params.set("q", q);
  if (filters.status !== "") params.set("status", filters.status);
  if (filters.customerId !== "") params.set("customerId", filters.customerId);
  if (filters.currentShift) {
    if (shiftId === null) return null;
    params.set("shiftId", shiftId);
  } else {
    if (filters.from !== "") params.set("from", filters.from);
    if (filters.to !== "") params.set("to", filters.to);
  }
  return params.toString();
}

/** A date range that cannot be asked: the start after the end. */
export function rangeProblem(filters: SalesFilters): string | null {
  if (filters.currentShift || filters.from === "" || filters.to === "") return null;
  return filters.from > filters.to ? "The start date is after the end date." : null;
}

async function call(path: string): Promise<Response> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    throw new ApiHttpError(0, "Couldn’t reach the server. Check the connection and try again.");
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
    throw new ApiHttpError(response.status, failureMessage(response.status, message));
  }
  return response;
}

export async function fetchSales(query: string): Promise<SaleList> {
  return (await (await call(`/pos/sales?${query}`)).json()) as SaleList;
}

export const salesKeys = {
  all: ["sales"] as const,
  list: (query: string) => ["sales", "list", query] as const,
  detail: (saleId: string) => ["pos", "sale", saleId] as const,
};

export function useSales(query: string | null) {
  return useQuery({
    queryKey: salesKeys.list(query ?? ""),
    queryFn: () => fetchSales(query ?? ""),
    enabled: query !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

// ---- Labels: words for the API's enums, so nothing on screen is a code ----

export const CHANNEL_LABEL: Readonly<Record<MpesaChannel, string>> = { STK: "STK", TILL: "Till", PAYBILL: "Paybill" };

type Tender = Pick<SaleRecord["tenders"][number], "tenderType" | "mpesaChannel">;

/** "M-Pesa · Till", "Cash", "Bank transfer", "Credit". */
export function tenderName(tender: Tender): string {
  const label: Record<SaleTenderBody["tenderType"], string> = { CASH: "Cash", MPESA: "M-Pesa", BANK_TRANSFER: "Bank transfer", CREDIT: "Credit" };
  const base = label[tender.tenderType];
  return tender.tenderType === "MPESA" && tender.mpesaChannel ? `${base} · ${CHANNEL_LABEL[tender.mpesaChannel]}` : base;
}

export const PAYMENT_STATUS_LABEL: Readonly<Record<SaleRecord["paymentStatus"], string>> = {
  FULLY_SETTLED: "Paid in full",
  PARTIALLY_SETTLED: "Partly paid",
  UNSETTLED: "Not paid",
};

export const TENDER_STATUS_LABEL: Readonly<Record<SaleRecord["tenders"][number]["status"], string>> = {
  CONFIRMED: "Confirmed",
  PENDING: "Pending",
  FAILED: "Failed",
};

export const FISCAL_LABEL: Readonly<Record<SaleRecord["fiscalStatus"], string>> = {
  NOT_REQUESTED: "No KRA invoice requested",
  PENDING_ETIMS: "KRA invoice pending",
  SIGNED: "Signed by KRA (eTIMS)",
  FAILED: "KRA invoice failed",
};

/** When the sale happened: its business time (an offline capture), else when it was rung. */
export function businessTimeOf(sale: Pick<SaleRow, "businessTimestamp" | "createdAt">): string {
  return sale.businessTimestamp ?? sale.createdAt;
}
