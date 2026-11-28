// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { computeDeltas } from "@/lib/dashboard/deltas";
import { ABSENT, ApiHttpError, isNotPermitted, NOT_PERMITTED, withQuery } from "@/lib/dashboard/fetch";
import {
  dashboardKeys,
  dashboardPaths,
  useDashboard,
  useCustomers,
  useDashboardDeltas,
  useEtimsBacklog,
  useEtimsStatus,
  useOpenReceivables,
  useLowStock,
  usePayablesAging,
  useReadiness,
  useReceivablesAging,
  useRecentSales,
  useTopProducts,
  useTrend,
  useVatReturn,
} from "@/lib/dashboard/hooks";
import { PeriodProvider, usePeriod } from "@/lib/dashboard/period";
import { makeQueryClient, shouldRetry, STALE_TIME_MS } from "@/lib/dashboard/query-client";
import type { DashboardSummary, TopProduct, TrendBucket } from "@/lib/dashboard/types";
import { monthToDate } from "@/lib/datetime";

const OCTOBER = { from: "2026-10-01", to: "2026-10-30" };

let requested: string[];
let answer: (url: string) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requested = [];
  answer = () => json(200, {});
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url);
    return answer(url);
  });
});
afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } });
  function TestQueryProvider({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return TestQueryProvider;
}

/** Any of the hooks, as far as the URL-mapping table cares. */
type AnyHook = () => { isSuccess: boolean };

function summary(figures: Partial<Record<"revenue" | "costOfSales" | "grossProfit" | "operatingExpenses" | "netProfit" | "receivables" | "payables" | "cash", string>>): DashboardSummary {
  const v = (key: keyof typeof figures) => figures[key] ?? "0";
  return {
    period: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" },
    revenue: v("revenue"),
    costOfSales: v("costOfSales"),
    grossProfit: v("grossProfit"),
    operatingExpenses: v("operatingExpenses"),
    netProfit: v("netProfit"),
    cashPosition: { total: v("cash"), accounts: [] },
    receivables: v("receivables"),
    payables: v("payables"),
    topExpenseCategories: [],
    lowStockCount: 0,
  };
}

describe("the types come from the generated schema — money is a string", () => {
  it("keeps every money field a string", () => {
    expectTypeOf<DashboardSummary["revenue"]>().toEqualTypeOf<string>();
    expectTypeOf<DashboardSummary["cashPosition"]["total"]>().toEqualTypeOf<string>();
    expectTypeOf<TrendBucket["netProfit"]>().toEqualTypeOf<string>();
    expectTypeOf<TrendBucket["partial"]>().toEqualTypeOf<boolean>();
    expectTypeOf<TopProduct["revenue"]>().toEqualTypeOf<string>();
    expectTypeOf<TopProduct["quantity"]>().toEqualTypeOf<string>();
  });
});

describe("query keys and parameter mapping", () => {
  it("maps each hook to its BFF path and query", () => {
    expect(dashboardPaths.summary(OCTOBER)).toBe("/dashboard?from=2026-10-01&to=2026-10-30");
    expect(dashboardPaths.readiness()).toBe("/dashboard/readiness");
    expect(dashboardPaths.trend(6)).toBe("/dashboard/trend?months=6");
    expect(dashboardPaths.topProducts(OCTOBER, 5, "quantity")).toBe("/reports/top-products?from=2026-10-01&to=2026-10-30&limit=5&by=quantity");
    expect(dashboardPaths.recentSales(8)).toBe("/pos/sales?take=8");
    expect(dashboardPaths.receivablesAging()).toBe("/receivables/aging");
    expect(dashboardPaths.payablesAging()).toBe("/payables/aging");
    expect(dashboardPaths.lowStock()).toBe("/allocations/low-stock");
    expect(dashboardPaths.vatReturn(OCTOBER)).toBe("/reports/vat-return?from=2026-10-01&to=2026-10-30");
    expect(dashboardPaths.etims()).toBe("/etims/device");
    expect(withQuery("/x", { a: undefined, b: 2 })).toBe("/x?b=2");
  });

  it("gives every period and option its own cache entry", () => {
    const september = { from: "2026-09-01", to: "2026-09-30" };
    expect(dashboardKeys.summary(OCTOBER)).not.toEqual(dashboardKeys.summary(september));
    expect(dashboardKeys.topProducts(OCTOBER, 5, "revenue")).not.toEqual(dashboardKeys.topProducts(OCTOBER, 5, "quantity"));
    expect(dashboardKeys.topProducts(OCTOBER, 5, "revenue")).not.toEqual(dashboardKeys.topProducts(OCTOBER, 10, "revenue"));
    expect(dashboardKeys.trend(6)).not.toEqual(dashboardKeys.trend(12));
    for (const key of [dashboardKeys.summary(OCTOBER), dashboardKeys.trend(6), dashboardKeys.lowStock()]) expect(key[0]).toBe("dashboard");
  });

  it.each<[string, AnyHook, string]>([
    ["useDashboard", () => useDashboard(OCTOBER), "/api/v1/dashboard?from=2026-10-01&to=2026-10-30"],
    ["useReadiness", () => useReadiness(), "/api/v1/dashboard/readiness"],
    ["useTrend", () => useTrend(6), "/api/v1/dashboard/trend?months=6"],
    ["useTopProducts", () => useTopProducts(OCTOBER, { limit: 10, by: "revenue" }), "/api/v1/reports/top-products?from=2026-10-01&to=2026-10-30&limit=10&by=revenue"],
    ["useTopProducts (defaults)", () => useTopProducts(OCTOBER), "/api/v1/reports/top-products?from=2026-10-01&to=2026-10-30&limit=5&by=revenue"],
    ["useRecentSales", () => useRecentSales(5), "/api/v1/pos/sales?take=5"],
    ["useReceivablesAging", () => useReceivablesAging(), "/api/v1/receivables/aging"],
    ["usePayablesAging", () => usePayablesAging(), "/api/v1/payables/aging"],
    ["useLowStock", () => useLowStock(), "/api/v1/allocations/low-stock"],
    ["useVatReturn", () => useVatReturn(OCTOBER), "/api/v1/reports/vat-return?from=2026-10-01&to=2026-10-30"],
    ["useEtimsStatus", () => useEtimsStatus(), "/api/v1/etims/device"],
    ["useOpenReceivables", () => useOpenReceivables(), "/api/v1/receivables/open"],
    ["useCustomers", () => useCustomers(), "/api/v1/customers"],
  ])("%s requests the right URL through the BFF", async (_, hook, url) => {
    const { result } = renderHook(hook, { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requested).toEqual([url]);
  });

  it("reads the eTIMS backlog (queued + failed) only once a device exists", async () => {
    answer = (url) => json(200, { data: [], count: url.includes("QUEUED") ? 2 : 1 });
    const { result } = renderHook(() => useEtimsBacklog(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ queued: 2, failed: 1 });
    expect([...requested].sort()).toEqual(["/api/v1/etims/invoices?status=FAILED", "/api/v1/etims/invoices?status=QUEUED"]);
    requested = [];
    renderHook(() => useEtimsBacklog(false), { wrapper: wrapper() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requested).toEqual([]);
  });

  it("does not request eTIMS at all when disabled", async () => {
    renderHook(() => useEtimsStatus(false), { wrapper: wrapper() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requested).toEqual([]);
  });
});

describe("resilience", () => {
  it("a 403 resolves to the NOT_PERMITTED sentinel (the panel hides) — not an error", async () => {
    answer = () => json(403, { statusCode: 403, error: "Forbidden", message: "Insufficient role." });
    const { result } = renderHook(() => usePayablesAging(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(NOT_PERMITTED);
    expect(result.current.isError).toBe(false);
    expect(requested).toHaveLength(1); // a refusal is never retried
  });

  it("eTIMS never initialised (404) resolves to ABSENT; a 404 elsewhere is an error", async () => {
    answer = () => json(404, { statusCode: 404, error: "Not Found", message: "No device." });
    const etims = renderHook(() => useEtimsStatus(), { wrapper: wrapper() });
    await waitFor(() => expect(etims.result.current.isSuccess).toBe(true));
    expect(etims.result.current.data).toBe(ABSENT);
    const summaryHook = renderHook(() => useDashboard(OCTOBER), { wrapper: wrapper() });
    await waitFor(() => expect(summaryHook.result.current.isError).toBe(true));
  });

  it("a 5xx surfaces an error for THAT panel only, after one retry; other panels still load", async () => {
    answer = (url) => (url.includes("/trend") ? json(503, { statusCode: 503, error: "Service Unavailable", message: "down" }) : json(200, []));
    const trend = renderHook(() => useTrend(6), { wrapper: wrapper() });
    const top = renderHook(() => useTopProducts(OCTOBER), { wrapper: wrapper() });
    await waitFor(() => expect(trend.result.current.isError).toBe(true));
    await waitFor(() => expect(top.result.current.isSuccess).toBe(true));
    const error = trend.result.current.error;
    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).status).toBe(503);
    expect(requested.filter((u) => u.includes("/trend"))).toHaveLength(2);
  });

  it("a network failure is an error with status 0", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const { result } = renderHook(() => useLowStock(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as ApiHttpError).status).toBe(0);
  });

  it("retries 5xx and network failures once, never a 4xx; fresh for 30s; no refetch on focus", () => {
    for (const status of [400, 401, 403, 404, 429]) expect(shouldRetry(0, new ApiHttpError(status, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiHttpError(500, "x"))).toBe(true);
    expect(shouldRetry(1, new ApiHttpError(500, "x"))).toBe(false);
    expect(shouldRetry(0, new ApiHttpError(0, "x"))).toBe(true);
    const defaults = makeQueryClient().getDefaultOptions().queries;
    expect(defaults?.staleTime).toBe(STALE_TIME_MS);
    expect(STALE_TIME_MS).toBe(30_000);
    expect(defaults?.refetchOnWindowFocus).toBe(false);
  });
});

describe("period-over-period deltas", () => {
  it("compares against the EQUIVALENT PRIOR PERIOD with a second /v1/dashboard call", async () => {
    answer = (url) =>
      url.includes("from=2026-09-01")
        ? json(200, summary({ revenue: "62031100", netProfit: "2815167", grossProfit: "17956100", cash: "0" }))
        : json(200, summary({ revenue: "65306300", netProfit: "11219111", grossProfit: "18043300", cash: "129550500" }));
    const { result } = renderHook(() => useDashboardDeltas(OCTOBER, "month-to-date"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.deltas).toBeDefined());
    expect(result.current.baseline).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(result.current.comparedWith).toBe("last month");
    expect([...requested].sort()).toEqual([
      "/api/v1/dashboard?from=2026-09-01&to=2026-09-30",
      "/api/v1/dashboard?from=2026-10-01&to=2026-10-30",
    ]);
    const deltas = result.current.deltas;
    if (deltas === undefined || isNotPermitted(deltas)) throw new Error("expected deltas");
    expect(deltas.revenue).toBe(5.28); // 653,063.00 vs 620,311.00
    expect(deltas.netProfit).toBe(298.52); // 112,191.11 vs 28,151.67
    expect(deltas.cashPosition).toBeNull(); // a zero baseline has no percentage
  });

  it("year to date compares with the same days LAST YEAR — and is null when last year had nothing", async () => {
    answer = (url) => (url.includes("from=2025-") ? json(200, summary({ revenue: "0", netProfit: "0" })) : json(200, summary({ revenue: "217045000", netProfit: "11954000" })));
    const { result } = renderHook(() => useDashboardDeltas({ from: "2026-01-01", to: "2026-10-31" }, "year-to-date"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.deltas).toBeDefined());
    expect(result.current.comparedWith).toBe("last year");
    expect(result.current.baseline).toEqual({ from: "2025-01-01", to: "2025-10-31" });
    expect(requested).toContain("/api/v1/dashboard?from=2025-01-01&to=2025-10-31");
    const deltas = result.current.deltas;
    if (deltas === undefined || isNotPermitted(deltas)) throw new Error("expected deltas");
    expect(deltas.revenue).toBeNull();
    expect(deltas.netProfit).toBeNull();
  });

  it("is null for a baseline at or below zero, and NOT_PERMITTED when the dashboard is refused", async () => {
    const d = computeDeltas(summary({ netProfit: "5000", revenue: "100" }), summary({ netProfit: "-2000", revenue: "0" }));
    expect(d.netProfit).toBeNull();
    expect(d.revenue).toBeNull();
    answer = () => json(403, { statusCode: 403, error: "Forbidden", message: "x" });
    const { result } = renderHook(() => useDashboardDeltas(OCTOBER, "month-to-date"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.deltas).toBe(NOT_PERMITTED));
  });
});

describe("money never passes through Number()", () => {
  it("hands the API's cents strings through unchanged — even beyond 2^53", async () => {
    const huge = "900719925474099312"; // > Number.MAX_SAFE_INTEGER
    answer = () => json(200, summary({ revenue: huge }));
    const { result } = renderHook(() => useDashboard(OCTOBER), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect((result.current.data as DashboardSummary).revenue).toBe(huge);
    // Deltas compare exact BigInt cents: a 1-cent change on a huge base is not lost to floats.
    const base = summary({ revenue: "900719925474099300" });
    const doubled = summary({ revenue: "1801439850948198600" });
    expect(computeDeltas(doubled, base).revenue).toBe(100);
    expect(() => computeDeltas(summary({ revenue: "12.50" }), base)).toThrow(TypeError);
  });

  it("no money-handling source converts with Number(), parseFloat or parseInt", () => {
    const dir = join(process.cwd(), "lib", "dashboard");
    // Date and clock arithmetic (calendar parts, the hour of day) is not money.
    const NOT_MONEY = new Set(["periods.ts", "greeting.ts"]);
    for (const file of readdirSync(dir).filter((name) => !NOT_MONEY.has(name))) {
      const source = readFileSync(join(dir, file), "utf8");
      expect([file, /\bNumber\(|parseFloat\(|parseInt\(/.test(source)]).toEqual([file, false]);
    }
  });
});

describe("the period", () => {
  it("defaults to the current month to date and drives the hooks", () => {
    const { result } = renderHook(() => usePeriod(), { wrapper: ({ children }) => <PeriodProvider>{children}</PeriodProvider> });
    expect(result.current.period).toEqual(monthToDate());
  });

  it("is required for usePeriod", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => usePeriod())).toThrow(/PeriodProvider/);
  });
});
