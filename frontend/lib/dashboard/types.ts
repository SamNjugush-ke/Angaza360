import type { paths } from "@/lib/api/schema";

// Every dashboard source's 200 body, straight from the generated schema — money stays a string.

type Ok<P extends keyof paths> = paths[P] extends { get: { responses: { 200: { content: { "application/json": infer B } } } } }
  ? B
  : never;

export type DashboardSummary = Ok<"/v1/dashboard/">;
export type Readiness = Ok<"/v1/dashboard/readiness">;
export type TrendBucket = Ok<"/v1/dashboard/trend">[number];
export type TopProduct = Ok<"/v1/reports/top-products">[number];
export type RecentSales = Ok<"/v1/pos/sales">;
export type ReceivablesAging = Ok<"/v1/receivables/aging">;
export type PayablesAging = Ok<"/v1/payables/aging">;
export type LowStock = Ok<"/v1/allocations/low-stock">;
export type VatReturn = Ok<"/v1/reports/vat-return">;
export type EtimsDevice = Ok<"/v1/etims/device">;
export type OpenReceivables = Ok<"/v1/receivables/open">;
export type CustomerList = Ok<"/v1/customers/">;
export type EtimsInvoiceList = Ok<"/v1/etims/invoices">;

/** Invoices waiting on KRA: QUEUED (to retry) and FAILED (parked for an operator). */
export interface EtimsBacklog {
  queued: number;
  failed: number;
}

export type TopProductsRanking = "revenue" | "quantity";
