import { failureMessage } from "@/lib/api/messages";
import { apiFetch } from "@/lib/api/browser";
import { ApiHttpError } from "@/lib/dashboard/fetch";
import type {
  Customer,
  CustomerCreateBody,
  CustomerList,
  Quote,
  QuoteBody,
  Receipt,
  Sale,
  SaleBody,
  SaleList,
  SaleRecord,
  ShiftSummary,
  StkPush,
  StkPushBody,
  StkStatus,
  VoidResult,
} from "./types";

// The till's calls, through the BFF proxy (CSRF and the single-flight refresh come with apiFetch).
// A refusal is thrown as an ApiHttpError carrying the backend's own message; the till translates
// the few that are not written for a cashier (see messages.ts).

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    throw new ApiHttpError(0, "The till could not reach the server. Check the connection and try again.");
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
    throw new ApiHttpError(response.status, failureMessage(response.status, message));
  }
  return response;
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The cashier's open shift, or null when none is open (the API's 404). */
export async function fetchCurrentShift(): Promise<ShiftSummary | null> {
  try {
    return (await (await call("/pos/shifts/current")).json()) as ShiftSummary;
  } catch (error) {
    if (error instanceof ApiHttpError && error.status === 404) return null;
    throw error;
  }
}

export async function fetchShiftSummary(shiftId: string): Promise<ShiftSummary> {
  return (await (await call(`/pos/shifts/${encodeURIComponent(shiftId)}/summary`)).json()) as ShiftSummary;
}

/** openingFloat in shillings ("1000.00"); locationId only for an owner or manager (a cashier's is their assignment). */
export async function openShift(openingFloat: string, locationId?: string): Promise<ShiftSummary> {
  return (await (await call("/pos/shifts/open", post({ openingFloat, ...(locationId ? { locationId } : {}) }))).json()) as ShiftSummary;
}

/** closingFloat in shillings ("1250.00"). */
export async function closeShift(shiftId: string, closingFloat: string): Promise<ShiftSummary> {
  return (await (await call(`/pos/shifts/${encodeURIComponent(shiftId)}/close`, post({ closingFloat }))).json()) as ShiftSummary;
}

export async function quoteSale(body: QuoteBody): Promise<Quote> {
  return (await (await call("/pos/sales/quote", post(body))).json()) as Quote;
}

export async function createSale(body: SaleBody): Promise<Sale> {
  return (await (await call("/pos/sales", post(body))).json()) as Sale;
}

export async function fetchReceipt(saleId: string): Promise<Receipt> {
  return (await (await call(`/pos/sales/${encodeURIComponent(saleId)}/receipt`)).json()) as Receipt;
}

export async function fetchCustomers(): Promise<CustomerList> {
  return (await (await call("/customers")).json()) as CustomerList;
}

export async function createCustomer(body: CustomerCreateBody): Promise<Customer> {
  return (await (await call("/customers", post(body))).json()) as Customer;
}

/** A PRE-SALE M-Pesa prompt to the customer's phone; amount in shillings ("1500.00"). Posts nothing. */
export async function pushStk(body: StkPushBody): Promise<StkPush> {
  return (await (await call("/pos/mpesa/stk-push", post(body))).json()) as StkPush;
}

/** Where an STK prompt stands: INITIATED until M-Pesa answers (CALLBACK_OK / CALLBACK_FAILED / TIMED_OUT). */
export async function fetchStkStatus(checkoutRequestId: string): Promise<StkStatus> {
  return (await (await call(`/pos/mpesa/${encodeURIComponent(checkoutRequestId)}`)).json()) as StkStatus;
}

export async function fetchSale(saleId: string): Promise<SaleRecord> {
  return (await (await call(`/pos/sales/${encodeURIComponent(saleId)}`)).json()) as SaleRecord;
}

/** This shift's sales, most recent first. */
export async function fetchShiftSales(shiftId: string): Promise<SaleList> {
  const query = new URLSearchParams({ shiftId, take: "20" });
  return (await (await call(`/pos/sales?${query.toString()}`)).json()) as SaleList;
}

/** Void a sale (manager or owner): the payment is reversed and the stock goes back where it came from. */
export async function voidSale(saleId: string, reason: string): Promise<VoidResult> {
  return (await (await call(`/pos/sales/${encodeURIComponent(saleId)}/void`, post({ reason }))).json()) as VoidResult;
}
