import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { comparisonPeriodOf, type Period, type PeriodKind } from "@/lib/datetime";
import { computeDeltas, type DashboardDeltas } from "./deltas";
import { getGated, getOptional, isNotPermitted, NOT_PERMITTED, withQuery, type Absent, type Gated } from "./fetch";
import type {
  CustomerList,
  DashboardSummary,
  EtimsBacklog,
  EtimsDevice,
  EtimsInvoiceList,
  OpenReceivables,
  LowStock,
  PayablesAging,
  ReceivablesAging,
  Readiness,
  RecentSales,
  TopProduct,
  TopProductsRanking,
  TrendBucket,
  VatReturn,
} from "./types";

// The dashboard's data hooks. Each reads ONE backend source through the BFF proxy (lib/api/
// browser.ts — CSRF and the single-flight refresh), is typed from schema.d.ts, and keeps money as
// the string of cents the API sent. A source the role may not read resolves to NOT_PERMITTED (the
// panel hides); a failure throws (that panel shows its error).
//
// Query keys are built by `dashboardKeys`, so a period or option change is a different cache
// entry and nothing is ever served for the wrong period.

export const dashboardKeys = {
  all: ["dashboard"] as const,
  summary: (period: Period) => ["dashboard", "summary", period.from, period.to] as const,
  readiness: () => ["dashboard", "readiness"] as const,
  trend: (months: number) => ["dashboard", "trend", months] as const,
  topProducts: (period: Period, limit: number, by: TopProductsRanking) =>
    ["dashboard", "top-products", period.from, period.to, limit, by] as const,
  recentSales: (limit: number) => ["dashboard", "recent-sales", limit] as const,
  receivablesAging: () => ["dashboard", "receivables-aging"] as const,
  payablesAging: () => ["dashboard", "payables-aging"] as const,
  lowStock: () => ["dashboard", "low-stock"] as const,
  vatReturn: (period: Period) => ["dashboard", "vat-return", period.from, period.to] as const,
  etims: () => ["dashboard", "etims-device"] as const,
  etimsBacklog: () => ["dashboard", "etims-backlog"] as const,
  openReceivables: () => ["dashboard", "open-receivables"] as const,
  customers: () => ["dashboard", "customers"] as const,
};

/** The URL each hook requests (under /api/v1) — exported so the mapping is testable. */
export const dashboardPaths = {
  summary: (period: Period) => withQuery("/dashboard", { from: period.from, to: period.to }),
  readiness: () => "/dashboard/readiness",
  trend: (months: number) => withQuery("/dashboard/trend", { months }),
  topProducts: (period: Period, limit: number, by: TopProductsRanking) =>
    withQuery("/reports/top-products", { from: period.from, to: period.to, limit, by }),
  recentSales: (limit: number) => withQuery("/pos/sales", { take: limit }),
  receivablesAging: () => "/receivables/aging",
  payablesAging: () => "/payables/aging",
  lowStock: () => "/allocations/low-stock",
  vatReturn: (period: Period) => withQuery("/reports/vat-return", { from: period.from, to: period.to }),
  etims: () => "/etims/device",
  etimsInvoices: (status: "QUEUED" | "FAILED") => withQuery("/etims/invoices", { status }),
  openReceivables: () => "/receivables/open",
  customers: () => "/customers",
};

export function useDashboard(period: Period): UseQueryResult<Gated<DashboardSummary>> {
  return useQuery({ queryKey: dashboardKeys.summary(period), queryFn: () => getGated<DashboardSummary>(dashboardPaths.summary(period)) });
}

/** Readiness is only meaningful to the people who set the business up; `enabled` skips it for others. */
export function useReadiness(enabled = true): UseQueryResult<Gated<Readiness>> {
  return useQuery({ queryKey: dashboardKeys.readiness(), queryFn: () => getGated<Readiness>(dashboardPaths.readiness()), enabled });
}

export function useTrend(months: number): UseQueryResult<Gated<TrendBucket[]>> {
  return useQuery({ queryKey: dashboardKeys.trend(months), queryFn: () => getGated<TrendBucket[]>(dashboardPaths.trend(months)) });
}

export function useTopProducts(
  period: Period,
  { limit = 5, by = "revenue" }: { limit?: number; by?: TopProductsRanking } = {},
): UseQueryResult<Gated<TopProduct[]>> {
  return useQuery({
    queryKey: dashboardKeys.topProducts(period, limit, by),
    queryFn: () => getGated<TopProduct[]>(dashboardPaths.topProducts(period, limit, by)),
  });
}

export function useRecentSales(limit = 5): UseQueryResult<Gated<RecentSales>> {
  return useQuery({ queryKey: dashboardKeys.recentSales(limit), queryFn: () => getGated<RecentSales>(dashboardPaths.recentSales(limit)) });
}

export function useReceivablesAging(): UseQueryResult<Gated<ReceivablesAging>> {
  return useQuery({ queryKey: dashboardKeys.receivablesAging(), queryFn: () => getGated<ReceivablesAging>(dashboardPaths.receivablesAging()) });
}

export function usePayablesAging(): UseQueryResult<Gated<PayablesAging>> {
  return useQuery({ queryKey: dashboardKeys.payablesAging(), queryFn: () => getGated<PayablesAging>(dashboardPaths.payablesAging()) });
}

export function useLowStock(): UseQueryResult<Gated<LowStock>> {
  return useQuery({ queryKey: dashboardKeys.lowStock(), queryFn: () => getGated<LowStock>(dashboardPaths.lowStock()) });
}

export function useVatReturn(period: Period): UseQueryResult<Gated<VatReturn>> {
  return useQuery({ queryKey: dashboardKeys.vatReturn(period), queryFn: () => getGated<VatReturn>(dashboardPaths.vatReturn(period)) });
}

/**
 * The eTIMS device, CONDITIONAL: a business that never initialised eTIMS answers 404 — the normal
 * state — which resolves to ABSENT so the card hides. `enabled` lets a caller skip it entirely.
 */
export function useEtimsStatus(enabled = true): UseQueryResult<Gated<EtimsDevice> | Absent> {
  return useQuery({ queryKey: dashboardKeys.etims(), queryFn: () => getOptional<EtimsDevice>(dashboardPaths.etims()), enabled });
}

/** The open credit sales, each with its days outstanding — the source of "N overdue invoices". */
export function useOpenReceivables(): UseQueryResult<Gated<OpenReceivables>> {
  return useQuery({ queryKey: dashboardKeys.openReceivables(), queryFn: () => getGated<OpenReceivables>(dashboardPaths.openReceivables()) });
}

/** Customer names for the recent-sales list (owner, manager and cashier may read them). */
export function useCustomers(): UseQueryResult<Gated<CustomerList>> {
  return useQuery({ queryKey: dashboardKeys.customers(), queryFn: () => getGated<CustomerList>(dashboardPaths.customers()) });
}

/** Invoices waiting on KRA — only worth asking once a device exists (`enabled`). */
export function useEtimsBacklog(enabled: boolean): UseQueryResult<Gated<EtimsBacklog>> {
  return useQuery({
    queryKey: dashboardKeys.etimsBacklog(),
    enabled,
    queryFn: async (): Promise<Gated<EtimsBacklog>> => {
      const [queued, failed] = await Promise.all([
        getGated<EtimsInvoiceList>(dashboardPaths.etimsInvoices("QUEUED")),
        getGated<EtimsInvoiceList>(dashboardPaths.etimsInvoices("FAILED")),
      ]);
      if (isNotPermitted(queued) || isNotPermitted(failed)) return NOT_PERMITTED;
      return { queued: queued.count, failed: failed.count };
    },
  });
}

export interface DeltasResult {
  /** Percent change per figure; null where the baseline is ≤ 0. NOT_PERMITTED hides the deltas. */
  deltas: Gated<DashboardDeltas> | undefined;
  baseline: Period;
  /** What the change is measured against: "last month", "last year", "previous period"… */
  comparedWith: string;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Period-over-period change: a SECOND /v1/dashboard call for the FAIR comparison of the period's
 * kind (datetime.comparisonPeriodOf) — month to date vs the same days last month, year to date vs
 * the same days last year, a whole month vs the month before, a custom range vs the span before
 * it. (No compare=previous parameter: T-F-DASH-3 is not approved.)
 */
export function useDashboardDeltas(period: Period, kind: PeriodKind): DeltasResult {
  const { period: baseline, label } = comparisonPeriodOf(period, kind);
  const current = useDashboard(period);
  const prior = useDashboard(baseline);
  let deltas: DeltasResult["deltas"];
  if (current.data !== undefined && prior.data !== undefined) {
    deltas = isNotPermitted(current.data) || isNotPermitted(prior.data) ? NOT_PERMITTED : computeDeltas(current.data, prior.data);
  }
  return {
    deltas,
    baseline,
    comparedWith: label,
    isLoading: current.isLoading || prior.isLoading,
    isError: current.isError || prior.isError,
  };
}
