// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DataProvider } from "@/components/providers/data-provider";
import { Dashboard } from "@/components/dashboard/dashboard";
import { moneyScale } from "@/lib/charts/scale";
import { actionFor, buildAttention, canAct, type AttentionSources } from "@/lib/dashboard/attention";
import { deltaDisplay } from "@/lib/dashboard/delta-display";
import { ABSENT, NOT_PERMITTED } from "@/lib/dashboard/fetch";
import { firstNameOf, greetingFor } from "@/lib/dashboard/greeting";
import { customRangeError, periodFor, periodKindOf, presetOf } from "@/lib/dashboard/periods";
import { fixFor, showReadiness } from "@/lib/dashboard/readiness";
import type { CustomerList, DashboardSummary, OpenReceivables, Readiness, RecentSales, TopProduct, TrendBucket, VatReturn } from "@/lib/dashboard/types";
import { displayQuantity } from "@/components/dashboard/top-products";
import { shareOf } from "@/components/dashboard/position-panels";
import { customerLabel, paidBy, saleTime } from "@/components/dashboard/recent-sales";
import type { Role } from "@/lib/auth/landing";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

// 30 Oct 2026, 14:00 in Nairobi (11:00 UTC).
const NOW = new Date("2026-10-30T11:00:00.000Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

// ---- Fixtures: the seeded Nakuru figures -----------------------------------------------------

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    period: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" },
    revenue: "65306300",
    costOfSales: "47263000",
    grossProfit: "18043300",
    operatingExpenses: "6824189",
    netProfit: "11219111",
    cashPosition: {
      total: "129550500",
      accounts: [
        { code: "1000", name: "Cash on Hand", amount: "4622300" },
        { code: "1010", name: "M-Pesa Till / Paybill", amount: "3072700" },
        { code: "1020", name: "Bank Account", amount: "121855500" },
      ],
    },
    receivables: "5250000",
    payables: "65565500",
    topExpenseCategories: [
      { code: "6000", name: "Rent", amount: "3500000" },
      { code: "6110", name: "Turnover Tax", amount: "1959189" },
    ],
    lowStockCount: 2,
    ...over,
  };
}
const SEPTEMBER = summary({ revenue: "62031100", netProfit: "2815167", grossProfit: "17956100", operatingExpenses: "15140933" });
const ZERO = summary({ revenue: "0", costOfSales: "0", grossProfit: "0", operatingExpenses: "0", netProfit: "0", lowStockCount: 0 });

const TREND: TrendBucket[] = [
  ["2026-05", "0", "0"],
  ["2026-06", "0", "0"],
  ["2026-07", "36227900", "-2819937"],
  ["2026-08", "53479700", "763309"],
  ["2026-09", "62031100", "2815167"],
  ["2026-10", "65306300", "11219111"],
].map(([month, revenue, netProfit], i) => ({
  month: month ?? "",
  from: `${month ?? ""}-01`,
  to: `${month ?? ""}-28`,
  partial: i === 5,
  revenue: revenue ?? "0",
  costOfSales: "0",
  grossProfit: "0",
  operatingExpenses: "0",
  netProfit: netProfit ?? "0",
}));

const OPEN: OpenReceivables = {
  data: [
    { saleId: "s1", saleNumber: "SALE-1", customerId: "c1", customerName: "Kiptoo", saleDate: "2026-08-05", saleTotal: "3000000", creditTotal: "3000000", arReceived: "0", outstanding: "3000000", daysOutstanding: 86 },
    { saleId: "s2", saleNumber: "SALE-2", customerId: "c1", customerName: "Kiptoo", saleDate: "2026-09-26", saleTotal: "1480000", creditTotal: "1480000", arReceived: "0", outstanding: "1480000", daysOutstanding: 34 },
    { saleId: "s3", saleNumber: "SALE-3", customerId: "c1", customerName: "Kiptoo", saleDate: "2026-10-30", saleTotal: "770000", creditTotal: "770000", arReceived: "0", outstanding: "770000", daysOutstanding: 0 },
  ],
  count: 3,
  totalOutstanding: "5250000",
};

function vatReturn(over: Partial<VatReturn["turnoverTax"]> = {}): VatReturn {
  return {
    period: { from: "2026-10-01", to: "2026-10-30" },
    taxRegime: "TURNOVER_TAX",
    isVatRegistered: false,
    presentation: "TOT_POSITION",
    vat: {
      outputVat: { charged: "0", reversed: "0", net: "0" },
      inputVat: { claimed: "0", reversed: "0", net: "0" },
      netVat: "0",
      position: "NIL",
      salesByCode: { standardRated: { turnover: "0", vat: "0" }, zeroRated: { turnover: "0" }, exempt: { turnover: "0" }, nonVat: { turnover: "0" } },
      taxablePurchases: "0",
    },
    turnoverTax: { accountCode: "2110", ratePercent: "3.00", turnover: "65306300", accrued: "1959189", ledgerMovement: "1959189", closingBalance: "1959189", reconciles: true, ...over },
    anomalies: [],
  };
}

const TOP: TopProduct[] = [
  ["Bamburi Cement 50kg", "GOOD", "231.000", "19558600"],
  ["Iron Sheet 30 Gauge 3m", "GOOD", "157.000", "19475000"],
  ["Y12 Steel Bar 12m", "GOOD", "80.000", "8789000"],
  ["Crown Emulsion Paint 4L", "GOOD", "36.000", "8580000"],
  ["Plumbing Installation (per point)", "SERVICE", "6.000", "900000"],
].map(([name, kind, quantity, revenue], i) => ({
  productId: `p${i.toString()}`,
  sku: `SKU-${i.toString()}`,
  name: name ?? "",
  kind: kind === "SERVICE" ? ("SERVICE" as const) : ("GOOD" as const),
  quantity: quantity ?? "0",
  revenue: revenue ?? "0",
}));

type Sale = RecentSales["data"][number];
type Tender = Sale["tenders"][number];
const tender = (tenderType: Tender["tenderType"], amount: string): Tender => ({
  id: `t-${tenderType}`,
  tenderType,
  amount,
  status: "CONFIRMED",
  mpesaReference: null,
  mpesaTransactionId: null,
  mpesaChannel: null,
  cashReceived: null,
});
function sale(over: Partial<Sale>): Sale {
  return {
    id: "sale-x",
    saleNumber: "SALE-20261030-000001",
    shiftId: "shift-1",
    customerId: null,
    status: "COMPLETED",
    paymentStatus: "FULLY_SETTLED",
    subtotal: "100000",
    vatTotal: "0",
    total: "100000",
    cogsTotal: "0",
    saleJournalEntryId: "je",
    totAccrued: "3000",
    voidedByEntryId: null,
    voidReason: null,
    reference: null,
    createdBy: "u",
    createdAt: "2026-10-30T10:05:00.000Z",
    sellingLocationId: "loc",
    origin: "ONLINE",
    businessTimestamp: null,
    syncedAt: null,
    deviceId: null,
    idempotencyKey: null,
    originalBusinessDate: null,
    fiscalStatus: "NOT_REQUESTED",
    lines: [],
    tenders: [tender("CASH", "100000")],
    ...over,
  };
}
const RECENT: RecentSales = {
  data: [
    sale({ id: "s-today", total: "1530000", tenders: [tender("MPESA", "1530000")] }),
    sale({ id: "s-credit", customerId: "c1", total: "770000", tenders: [tender("CREDIT", "770000")] }),
    sale({ id: "s-synced", origin: "OFFLINE_SYNCED", createdAt: "2026-10-30T10:00:00.000Z", businessTimestamp: "2026-10-29T08:30:00.000Z", total: "425000" }),
    sale({ id: "s-void", status: "VOIDED", total: "250000" }),
  ],
  pagination: { take: 6, skip: 0, total: 4 },
};
type Customer = CustomerList["data"][number];
const CUSTOMERS: CustomerList = { data: [{ id: "c1", name: "Kiptoo Construction Ltd" } as Customer] };

const check = (key: Readiness["checks"][number]["key"], required: boolean, pass: boolean): Readiness["checks"][number] => ({ key, label: `${key} label`, required, pass, detail: `${key} detail` });
const TRADING: Readiness = {
  readyToTrade: true,
  checks: [check("ACTIVE_PRODUCT", true, true), check("STOCK_OR_SERVICE", true, true), check("TAX_REGIME_SET", true, true), check("FIRST_SALE", false, true), check("KRA_PIN", false, false), check("STAFF_BEYOND_OWNER", false, true)],
};
const NOT_READY: Readiness = {
  readyToTrade: false,
  checks: [check("ACTIVE_PRODUCT", true, false), check("STOCK_OR_SERVICE", true, false), check("TAX_REGIME_SET", true, true), check("FIRST_SALE", false, false), check("KRA_PIN", false, false), check("STAFF_BEYOND_OWNER", false, false)],
};

// ---- The stubbed BFF -----------------------------------------------------------------------------

type Route = (url: URL) => Response;
let routes: Record<string, Route>;
let requested: string[];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const forbidden = () => json(403, { statusCode: 403, error: "Forbidden", message: "x" });

beforeEach(() => {
  requested = [];
  routes = {
    "/api/v1/dashboard/readiness": () => json(200, TRADING),
    "/api/v1/dashboard": (url) => json(200, url.searchParams.get("from") === "2026-09-01" ? SEPTEMBER : summary()),
    "/api/v1/dashboard/trend": () => json(200, TREND),
    "/api/v1/receivables/open": () => json(200, OPEN),
    "/api/v1/reports/vat-return": () => json(200, vatReturn()),
    "/api/v1/etims/device": () => json(404, { statusCode: 404, error: "Not Found", message: "x" }),
    "/api/v1/reports/top-products": () => json(200, TOP),
    "/api/v1/pos/sales": () => json(200, RECENT),
    "/api/v1/customers": () => json(200, CUSTOMERS),
  };
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://app.test");
    requested.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    return route ? route(url) : json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(role: Role) {
  return render(
    <DataProvider>
      <main>
        <Dashboard role={role} fullName="Wanjiku Kamau" businessName="Nakuru Hardware & Supplies" />
      </main>
    </DataProvider>,
  );
}

async function violations(): Promise<string[]> {
  document.documentElement.lang = "en-KE";
  document.title = "Dashboard";
  const result = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/** A money-overview figure: "KES" is a quiet prefix element, so match the paragraph's whole text. */
const figure = (amount: string) => (_: string, element: Element | null) => element?.tagName === "P" && element.textContent === `KES ${amount}`;

// ---- Pure logic ---------------------------------------------------------------------------------

describe("periods", () => {
  it("maps each preset to Nairobi business days", () => {
    expect(periodFor("month-to-date", "2026-10-30")).toEqual({ from: "2026-10-01", to: "2026-10-30" });
    expect(periodFor("last-month", "2026-10-30")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(periodFor("last-month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(periodFor("last-month", "2028-03-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(periodFor("year-to-date", "2026-10-30")).toEqual({ from: "2026-01-01", to: "2026-10-30" });
    expect(presetOf({ from: "2026-09-01", to: "2026-09-30" }, "2026-10-30")).toBe("last-month");
    expect(presetOf({ from: "2026-09-03", to: "2026-09-30" }, "2026-10-30")).toBe("custom");
    expect(periodKindOf({ from: "2026-10-01", to: "2026-10-30" }, "2026-10-30")).toBe("month-to-date");
    expect(periodKindOf({ from: "2026-09-01", to: "2026-09-30" }, "2026-10-30")).toBe("month");
    expect(periodKindOf({ from: "2026-01-01", to: "2026-10-30" }, "2026-10-30")).toBe("year-to-date");
    expect(periodKindOf({ from: "2026-10-20", to: "2026-10-25" }, "2026-10-30")).toBe("custom");
  });

  it("explains a bad custom range in plain words", () => {
    expect(customRangeError("", "2026-10-01", "2026-10-30")).toMatch(/both/);
    expect(customRangeError("2026-10-05", "2026-10-01", "2026-10-30")).toMatch(/on or before/);
    expect(customRangeError("2026-10-01", "2026-11-01", "2026-10-30")).toMatch(/future/);
    expect(customRangeError("2026-10-01", "2026-10-30", "2026-10-30")).toBeNull();
  });
});

describe("greeting", () => {
  it("follows the Nairobi clock", () => {
    expect(greetingFor(new Date("2026-10-30T05:00:00Z"))).toBe("Good morning"); // 08:00 EAT
    expect(greetingFor(new Date("2026-10-30T11:00:00Z"))).toBe("Good afternoon"); // 14:00 EAT
    expect(greetingFor(new Date("2026-10-30T15:00:00Z"))).toBe("Good evening"); // 18:00 EAT
    expect(greetingFor(new Date("2026-10-29T22:30:00Z"))).toBe("Good morning"); // 01:30 EAT next day
    expect(firstNameOf("  Wanjiku   Kamau ")).toBe("Wanjiku");
  });
});

describe("attention", () => {
  const sources = (over: Partial<AttentionSources> = {}): AttentionSources => ({
    openReceivables: OPEN,
    dashboard: summary(),
    vatReturn: vatReturn(),
    statutoryMonth: "October 2026",
    etimsDevice: ABSENT,
    etimsBacklog: undefined,
    ...over,
  });

  it("raises only what is live, with actions for the people who can act", () => {
    const items = buildAttention("MSME_OWNER", sources());
    expect(items.map((i) => [i.key, i.figure, i.action?.label, i.action?.href])).toEqual([
      ["overdue-receivables", "KES 44,800.00", "Review 2 invoices", "/customers"],
      ["low-stock", "2 items", "Reorder", "/inventory"],
      ["tax", "KES 19,591.89", "Open tax return", "/tax"],
    ]);
    expect(items[0]?.detail).toBe("2 invoices from 1 customer");
  });

  it("shows figures without actions to read-only roles", () => {
    for (const role of ["VIEWER_AUDITOR", "ACCOUNTANT"] as const) {
      const items = buildAttention(role, sources());
      expect(items).toHaveLength(3);
      expect(items.every((i) => i.action === undefined)).toBe(true);
    }
  });

  it("drops a card whose source the role cannot read, or that has nothing to act on", () => {
    expect(buildAttention("MSME_OWNER", sources({ openReceivables: NOT_PERMITTED, vatReturn: NOT_PERMITTED })).map((i) => i.key)).toEqual(["low-stock"]);
    expect(buildAttention("MSME_OWNER", sources({ openReceivables: { ...OPEN, data: OPEN.data.filter((s) => s.daysOutstanding === 0) } })).map((i) => i.key)).not.toContain("overdue-receivables");
    expect(buildAttention("MSME_OWNER", sources({ vatReturn: vatReturn({ accrued: "0" }) })).map((i) => i.key)).not.toContain("tax");
    expect(buildAttention("MSME_OWNER", sources({ dashboard: summary({ lowStockCount: 0 }) })).map((i) => i.key)).not.toContain("low-stock");
  });

  it("shows eTIMS only when a device exists and invoices are waiting", () => {
    const device = { id: "d", tin: "t", bhfId: "00", dvcSrlNo: "s", initialized: true, lastInitAt: null, lastInvoiceNo: 9, createdAt: "", updatedAt: "" };
    expect(buildAttention("MSME_OWNER", sources({ etimsDevice: ABSENT, etimsBacklog: { queued: 3, failed: 0 } })).map((i) => i.key)).not.toContain("etims");
    const etims = buildAttention("MSME_OWNER", sources({ etimsDevice: device, etimsBacklog: { queued: 2, failed: 1 } })).find((i) => i.key === "etims");
    expect(etims).toMatchObject({ figure: "3 invoices", detail: "1 need attention", action: { label: "File now", href: "/tax" } });
  });

  it("offers an action only where the role's route guard admits it", () => {
    expect(canAct("MSME_MANAGER")).toBe(true);
    expect(canAct("ACCOUNTANT")).toBe(false);
    expect(actionFor("MSME_MANAGER", "Invite", "/people")).toBeUndefined(); // People & access is owner-only
    expect(fixFor("MSME_MANAGER", "STAFF_BEYOND_OWNER")).toBeUndefined();
    expect(fixFor("MSME_OWNER", "STAFF_BEYOND_OWNER")).toEqual({ label: "Invite staff", href: "/people" });
  });
});

describe("readiness gate", () => {
  it("shows the canvas until required checks pass AND the first sale is recorded", () => {
    expect(showReadiness(NOT_READY)).toBe(true);
    expect(showReadiness({ ...TRADING, checks: TRADING.checks.map((c) => (c.key === "FIRST_SALE" ? { ...c, pass: false } : c)) })).toBe(true);
    expect(showReadiness(TRADING)).toBe(false);
  });
});

describe("the trend scale", () => {
  it("always includes zero, on round ticks, and puts a loss below the baseline", () => {
    const scale = moneyScale([36227900n, -2819937n, 65306300n], 200);
    expect(scale.min).toBeLessThan(0n);
    expect(scale.ticks).toContain(0n);
    expect(scale.ticks.every((t) => t % 10_000_000n === 0n)).toBe(true); // KES 100K steps
    expect(scale.y(-2819937n)).toBeGreaterThan(scale.y(0n));
    expect(scale.y(scale.max)).toBe(0);
    expect(scale.y(scale.min)).toBe(200);
    const flat = moneyScale([0n, 0n], 100);
    expect(flat.ticks[0]).toBe(0n);
    expect(flat.y(0n)).toBe(100);
  });
});

describe("delta display", () => {
  it("uses sign, arrow and words — and a dash with no comparison", () => {
    expect(deltaDisplay(5.28, "September")).toEqual({ direction: "up", text: "+5.3%", description: "Up 5.3% on September" });
    expect(deltaDisplay(-12.04, "September")).toMatchObject({ direction: "down", text: "−12.0%" });
    expect(deltaDisplay(null, "September")).toEqual({ direction: "none", text: "—", description: "No comparison with September" });
    expect(deltaDisplay(0.01, "September").direction).toBe("flat");
  });
});

// ---- The rendered dashboard ----------------------------------------------------------------------

describe("the dashboard, rendered", () => {
  it("shows a trading owner the operational dashboard with the seeded figures and deltas", async () => {
    show("MSME_OWNER");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good afternoon, Wanjiku");
    expect(await screen.findByText(figure("653,063.00"))).toBeInTheDocument();
    expect(screen.getByText(figure("112,191.11"))).toBeInTheDocument();
    expect(await screen.findByText("Up 5.3% on last month (1–30 Sept 2026)")).toBeInTheDocument();
    expect(screen.getByText("Up 298.5% on last month (1–30 Sept 2026)")).toBeInTheDocument();
    // The attention strip with owner actions.
    const attention = within(await screen.findByRole("region", { name: "Needs attention" }));
    expect(attention.getByRole("link", { name: "Review 2 invoices" })).toHaveAttribute("href", "/customers");
    expect(attention.getByRole("link", { name: "Reorder" })).toHaveAttribute("href", "/inventory");
    expect(attention.getByRole("link", { name: "Open tax return" })).toHaveAttribute("href", "/tax");
    expect(attention.queryByText(/eTIMS/)).toBeNull(); // no device: no card
    // The trend: an accessible figure whose description carries the numbers, and a table.
    const chart = await screen.findByRole("img", { name: /Revenue and net profit by month/ });
    expect(chart).toHaveAccessibleDescription(/July 2026: revenue KES 362,279.00, net profit -KES 28,199.37/);
    expect(chart).toHaveAccessibleDescription(/October 2026 \(to date\)/);
    expect(screen.getByRole("table", { name: "Revenue and net profit by month" })).toBeInTheDocument();
  });

  it("shows a business that is not ready the readiness canvas — and nothing operational", async () => {
    routes["/api/v1/dashboard/readiness"] = () => json(200, NOT_READY);
    show("MSME_OWNER");
    expect(await screen.findByRole("heading", { name: "Get ready to trade" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 required steps done. Your dashboard fills in once you start selling.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add a product" })).toHaveAttribute("href", "/products");
    expect(screen.getByRole("link", { name: "Invite staff" })).toHaveAttribute("href", "/people");
    expect(screen.queryByText("Money overview")).toBeNull();
    expect(requested.some((u) => u.startsWith("/api/v1/dashboard?"))).toBe(false);
    expect(await violations()).toEqual([]);
  });

  it("celebrates readiness until the first sale", async () => {
    routes["/api/v1/dashboard/readiness"] = () => json(200, { ...TRADING, checks: TRADING.checks.map((c) => (c.key === "FIRST_SALE" ? { ...c, pass: false } : c)) });
    show("MSME_MANAGER");
    expect(await screen.findByRole("heading", { name: "You’re ready — record your first sale" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Record a sale" })).toHaveAttribute("href", "/pos");
    expect(screen.queryByRole("link", { name: "Invite staff" })).toBeNull(); // a manager cannot open People & access
  });

  it("gives a viewer/auditor the operational dashboard, read-only, without asking for readiness", async () => {
    show("VIEWER_AUDITOR");
    expect(await screen.findByText(figure("653,063.00"))).toBeInTheDocument();
    const attention = within(await screen.findByRole("region", { name: "Needs attention" }));
    expect(attention.getByText("Overdue receivables")).toBeInTheDocument();
    expect(attention.queryAllByRole("link")).toEqual([]);
    expect(requested).not.toContain("/api/v1/dashboard/readiness");
  });

  it("hides a card whose source answers 403, and keeps the rest", async () => {
    routes["/api/v1/reports/vat-return"] = forbidden;
    routes["/api/v1/receivables/open"] = forbidden;
    show("ACCOUNTANT");
    const attention = within(await screen.findByRole("region", { name: "Needs attention" }));
    expect(attention.getByText("Low stock")).toBeInTheDocument();
    await waitFor(() => expect(requested).toContain("/api/v1/receivables/open"));
    expect(attention.queryByText("Overdue receivables")).toBeNull();
    expect(attention.queryByText("Turnover Tax")).toBeNull();
  });

  it("isolates a failing panel: an error with a retry that recovers, the rest unaffected", async () => {
    const user = userEvent.setup();
    let failing = true;
    routes["/api/v1/dashboard/trend"] = () => (failing ? json(503, { statusCode: 503, error: "x", message: "x" }) : json(200, TREND));
    show("MSME_OWNER");
    const trendPanel = within(await screen.findByRole("region", { name: "Last 6 months" }));
    expect(await trendPanel.findByText("We couldn't load your sales trend right now.", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(figure("653,063.00"))).toBeInTheDocument();
    failing = false;
    await user.click(trendPanel.getByRole("button", { name: "Try again" }));
    expect(await trendPanel.findByRole("img", { name: /Revenue and net profit/ })).toBeInTheDocument();
  });

  it("is honest when there is nothing yet: a CTA for owners, a plain note for others", async () => {
    routes["/api/v1/dashboard"] = () => json(200, ZERO);
    routes["/api/v1/receivables/open"] = () => json(200, { data: [], count: 0, totalOutstanding: "0" });
    routes["/api/v1/reports/vat-return"] = () => json(200, vatReturn({ accrued: "0" }));
    show("MSME_OWNER");
    expect(await screen.findByText("No sales yet this period")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Record a sale" })).toHaveAttribute("href", "/pos");
    expect(await screen.findByText("All clear — nothing needs your attention right now.")).toBeInTheDocument();
    cleanup();
    show("VIEWER_AUDITOR");
    expect(await screen.findByText("No activity this period")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Record a sale" })).toBeNull();
  });

  it("refetches every period-driven panel when the period changes", async () => {
    const user = userEvent.setup();
    show("MSME_OWNER");
    await screen.findByText(figure("653,063.00"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "last-month");
    expect(await screen.findByText(figure("620,311.00"))).toBeInTheDocument();
    expect(requested).toContain("/api/v1/dashboard?from=2026-09-01&to=2026-09-30");
    expect(requested).toContain("/api/v1/dashboard?from=2026-08-01&to=2026-08-31"); // the whole month before
    expect(await screen.findAllByText("vs previous month · 1–31 Aug 2026")).toHaveLength(2);
    expect(screen.getByText("1 Sept 2026 – 30 Sept 2026")).toBeInTheDocument();
  });

  it("compares this year to date with the same days LAST year — a dash when last year had nothing", async () => {
    const user = userEvent.setup();
    routes["/api/v1/dashboard"] = (url) => {
      const from = url.searchParams.get("from");
      if (from?.startsWith("2025-")) return json(200, ZERO);
      return json(200, from === "2026-01-01" ? summary({ revenue: "217045000" }) : summary());
    };
    show("MSME_OWNER");
    await screen.findByText(figure("653,063.00"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "year-to-date");
    expect(await screen.findByText(figure("2,170,450.00"))).toBeInTheDocument();
    expect(requested).toContain("/api/v1/dashboard?from=2026-01-01&to=2026-10-30");
    expect(requested).toContain("/api/v1/dashboard?from=2025-01-01&to=2025-10-30");
    expect(await screen.findAllByText("No comparison with last year (1 Jan – 30 Oct 2025)")).toHaveLength(2); // revenue and net profit
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("accepts a custom range and explains a bad one", async () => {
    const user = userEvent.setup();
    show("MSME_OWNER");
    await screen.findByText(figure("653,063.00"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Period" }), "custom");
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    await user.clear(from);
    await user.type(from, "2026-10-20");
    await user.clear(to);
    await user.type(to, "2026-10-10");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The start date must be on or before the end date.");
    await user.clear(to);
    await user.type(to, "2026-10-25");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(requested).toContain("/api/v1/dashboard?from=2026-10-20&to=2026-10-25"));
    // A custom range compares with the six days before it.
    await waitFor(() => expect(requested).toContain("/api/v1/dashboard?from=2026-10-14&to=2026-10-19"));
    expect(await screen.findAllByText("vs previous period · 14–19 Oct 2026")).toHaveLength(2);
  });

  it("has no accessibility violations on the operational dashboard", async () => {
    show("MSME_OWNER");
    await screen.findByRole("img", { name: /Revenue and net profit/ });
    await screen.findByRole("region", { name: "Needs attention" });
    await act(async () => undefined);
    expect(await violations()).toEqual([]);
  });
});

// ---- Position, what's selling, latest sales (F1-D.1b) --------------------------------------------

describe("panel helpers", () => {
  it("reads quantities, shares, times and payments as people do", () => {
    expect(displayQuantity("231.000")).toBe("231");
    expect(displayQuantity("2.500")).toBe("2.5");
    expect(displayQuantity("12")).toBe("12");
    expect(shareOf(3500000n, 5459189n)).toBe(64n);
    expect(shareOf(0n, 100n)).toBe(0n);
    expect(shareOf(1n, 0n)).toBe(0n);
    // A synced sale reads at its business time (29 Oct 11:30 Nairobi), not its arrival.
    expect(saleTime({ createdAt: "2026-10-30T10:00:00.000Z", businessTimestamp: "2026-10-29T08:30:00.000Z" })).toBe("29 Oct, 11:30");
    expect(saleTime({ createdAt: "2026-10-30T10:05:00.000Z", businessTimestamp: null })).toBe("30 Oct, 13:05");
    expect(paidBy(sale({}))).toBe("Cash");
    expect(paidBy(sale({ tenders: [tender("CASH", "1"), tender("MPESA", "1")] }))).toBe("Split payment");
    expect(customerLabel({ customerId: null }, CUSTOMERS)).toBe("Walk-in");
    expect(customerLabel({ customerId: "c1" }, CUSTOMERS)).toBe("Kiptoo Construction Ltd");
    expect(customerLabel({ customerId: "c1" }, NOT_PERMITTED)).toBe("Account customer");
  });
});

describe("the dashboard's position, products and sales panels", () => {
  it("shows the owner cash by ledger account, what is owed both ways, top products and the latest sales", async () => {
    show("MSME_OWNER");
    const position = within(await screen.findByRole("region", { name: "Cash and balances" }));
    expect(await position.findByText("KES 1,295,505.00")).toBeInTheDocument();
    const accounts = within(position.getByRole("list", { name: "Cash by ledger account" }));
    expect(accounts.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Cash on Hand46,223.00",
      "M-Pesa Till / Paybill30,727.00",
      "Bank Account1,218,555.00",
    ]);
    expect(position.getByText("Ledger balances, as recorded in your books")).toBeInTheDocument();
    expect(position.queryByText(/live/i)).toBeNull();
    expect(position.getByText("KES 52,500.00")).toBeInTheDocument();
    expect(position.getByText("KES 655,655.00")).toBeInTheDocument();
    expect(position.getByRole("link", { name: "Customers" })).toHaveAttribute("href", "/customers");
    expect(position.getByRole("link", { name: "Payables" })).toHaveAttribute("href", "/expenses");

    const top = within(await screen.findByRole("region", { name: "Top products" }));
    const rows = await top.findAllByRole("listitem");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("Bamburi Cement 50kg");
    expect(rows[0]).toHaveTextContent("Product231 sold");
    expect(rows[0]).toHaveTextContent("195,586.00");
    expect(rows[4]).toHaveTextContent("Service6 sold");
    expect(top.getByRole("link", { name: "All products" })).toHaveAttribute("href", "/products");
    expect(requested).toContain("/api/v1/reports/top-products?from=2026-10-01&to=2026-10-30&limit=5&by=revenue");

    const expenses = within(await screen.findByRole("region", { name: "Top expenses" }));
    expect(expenses.getByText("Rent")).toBeInTheDocument();
    expect(expenses.getByText("· 64%")).toBeInTheDocument();

    const latest = within(await screen.findByRole("region", { name: "Latest sales" }));
    const table = within(await latest.findByRole("table", { name: "Latest sales" }));
    expect(table.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time", "Customer", "Paid by", "Amount"]);
    const body = table.getAllByRole("row").slice(1).map((row) => row.textContent);
    expect(body).toEqual([
      "30 Oct, 13:05Walk-inM-Pesa15,300.00",
      "30 Oct, 13:05Kiptoo Construction LtdOn account7,700.00",
      "29 Oct, 11:30Walk-inCash4,250.00",
      "30 Oct, 13:05Walk-inCashVoided2,500.00",
    ]);
    expect(latest.getByRole("link", { name: "All sales" })).toHaveAttribute("href", "/sales");
  });

  it("shows an eTIMS column only for a business that has set up eTIMS", async () => {
    routes["/api/v1/etims/device"] = () =>
      json(200, { id: "d", tin: "t", bhfId: "00", dvcSrlNo: "s", initialized: true, lastInitAt: null, lastInvoiceNo: 4, createdAt: "", updatedAt: "" });
    routes["/api/v1/etims/invoices"] = () => json(200, { data: [], count: 0 });
    routes["/api/v1/pos/sales"] = () => json(200, { ...RECENT, data: [sale({ id: "signed", fiscalStatus: "SIGNED" })] });
    show("MSME_OWNER");
    const table = within(await screen.findByRole("table", { name: "Latest sales" }));
    await waitFor(() => expect(table.getAllByRole("columnheader").map((h) => h.textContent)).toContain("eTIMS"));
    expect(table.getByText("Signed")).toBeInTheDocument();
  });

  it("keeps an accountant to what they may open: no products link, no customer names", async () => {
    routes["/api/v1/customers"] = forbidden;
    show("ACCOUNTANT");
    const top = within(await screen.findByRole("region", { name: "Top products" }));
    await top.findByText("Bamburi Cement 50kg");
    expect(top.queryByRole("link")).toBeNull(); // Products & services is not an accountant's section
    const table = within(await screen.findByRole("table", { name: "Latest sales" }));
    await waitFor(() => expect(table.getByText("Account customer")).toBeInTheDocument());
    expect(table.queryByText("Kiptoo Construction Ltd")).toBeNull();
  });

  it("is honest when nothing has sold: a CTA for owners, a plain note for others", async () => {
    routes["/api/v1/reports/top-products"] = () => json(200, []);
    routes["/api/v1/pos/sales"] = () => json(200, { data: [], pagination: { take: 6, skip: 0, total: 0 } });
    show("MSME_OWNER");
    expect(await within(await screen.findByRole("region", { name: "Top products" })).findByText("No sales in this period.")).toBeInTheDocument();
    const latest = within(await screen.findByRole("region", { name: "Latest sales" }));
    expect(await latest.findByRole("link", { name: "Record your first sale" })).toHaveAttribute("href", "/pos");
    cleanup();
    show("VIEWER_AUDITOR");
    const viewerLatest = within(await screen.findByRole("region", { name: "Latest sales" }));
    expect(await viewerLatest.findByText("No sales yet.")).toBeInTheDocument();
    expect(viewerLatest.queryByRole("link", { name: "Record your first sale" })).toBeNull();
  });

  it("fails one panel at a time: top products down, everything else up", async () => {
    routes["/api/v1/reports/top-products"] = () => json(503, { statusCode: 503, error: "x", message: "x" });
    show("MSME_OWNER");
    const top = within(await screen.findByRole("region", { name: "Top products" }));
    expect(await top.findByText("We couldn't load your top products right now.", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(top.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Latest sales" })).toBeInTheDocument();
    expect(screen.getByText("KES 1,295,505.00")).toBeInTheDocument();
  });

  it("lets every grid item shrink to the screen (a wide table scrolls inside its panel, not the page)", async () => {
    show("MSME_OWNER");
    await screen.findByRole("table", { name: "Latest sales" });
    const grid = (await screen.findByRole("region", { name: "Latest sales" })).parentElement as HTMLElement;
    for (const item of Array.from(grid.children)) expect([item.textContent?.slice(0, 20), item.classList.contains("min-w-0")]).toEqual([item.textContent?.slice(0, 20), true]);
  });

  it("has no accessibility violations with every panel loaded", async () => {
    show("MSME_OWNER");
    await screen.findByRole("table", { name: "Latest sales" });
    await screen.findByRole("img", { name: /Revenue and net profit/ });
    await within(await screen.findByRole("region", { name: "Top products" })).findByText("Bamburi Cement 50kg");
    await act(async () => undefined);
    expect(await violations()).toEqual([]);
  });
});

describe("polish", () => {
  it("greets by first name, and just greets when there is no usable name", async () => {
    render(
      <DataProvider>
        <main>
          <Dashboard role="VIEWER_AUDITOR" fullName="   " businessName="Nakuru Hardware & Supplies" />
        </main>
      </DataProvider>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Good afternoon");
  });

  it("gives phones a list of the latest sales carrying the same facts as the table", async () => {
    show("MSME_OWNER");
    const list = within(await screen.findByRole("list", { name: "Latest sales" }));
    const items = list.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toBe("Walk-in30 Oct, 13:05 · M-Pesa15,300.00");
    expect(items[1]).toBe("Kiptoo Construction Ltd30 Oct, 13:05 · On account7,700.00");
    expect(items[3]).toContain("Voided");
  });

  it("marks a panel busy while it loads", async () => {
    let release: (r: Response) => void = () => undefined;
    routes["/api/v1/dashboard/trend"] = () => new Promise<Response>((resolve) => (release = resolve)) as unknown as Response;
    show("MSME_OWNER");
    const panel = await screen.findByRole("region", { name: "Last 6 months" });
    expect(panel).toHaveAttribute("aria-busy", "true");
    await act(async () => release(json(200, TREND)));
    await waitFor(() => expect(panel).not.toHaveAttribute("aria-busy"));
  });
});
