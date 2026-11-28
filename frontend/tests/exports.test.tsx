// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Exports } from "@/components/exports/exports";
import { axeViolations } from "./support/catalog";
import { show } from "./support/mentorship";

// T-B4 (M4.5 W4) — a business exports its own records. The screen lists only what the server's
// library offers this role, runs a report with the chosen filters, and exports EXACTLY the
// applied filters (never a half-typed change) as the file the server returns — or, for a large
// export, a background export collected from "Your exports". A stateful fake API stands in.

vi.mock("next/navigation", () => ({ usePathname: () => "/exports", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

interface Call {
  method: string;
  url: URL;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const CATALOGUE = {
  data: [
    {
      id: "sales",
      title: "Sales",
      description: "Every sale in the period.",
      category: "operations",
      sensitive: false,
      filters: [
        { key: "from", label: "From", type: "date", defaultHint: "the 1st of this month" },
        { key: "status", label: "Status", type: "select", options: [{ value: "COMPLETED", label: "Completed" }, { value: "VOIDED", label: "Voided" }] },
        { key: "locationId", label: "Location", type: "entity", entity: "location" },
        { key: "customerId", label: "Customer", type: "entity", entity: "customer" },
      ],
    },
    { id: "payroll-muster", title: "Payroll muster roll", description: "Employee-level pay.", category: "payroll", sensitive: true, filters: [{ key: "runId", label: "Payroll run", type: "entity", entity: "payrollRun", required: true }] },
  ],
};

const VIEW = (rows: number) => ({
  reportId: "sales",
  title: "Sales",
  brandName: "Nakuru Hardware",
  filters: [{ label: "Status", value: "Completed" }],
  period: { from: "2026-11-01", to: "2026-11-17" },
  generatedAt: "2026-11-17T08:00:00.000Z",
  sections: [
    {
      name: "Sales",
      note: null,
      columns: [
        { key: "number", header: "Sale", kind: "text", total: false },
        { key: "total", header: "Total (KES)", kind: "money", total: true },
      ],
      totalRows: rows,
      rows: Array.from({ length: Math.min(rows, 50) }, (_, i) => ({ number: `SALE-${(i + 1).toString()}`, total: "123450" })),
      totals: { total: (123450 * rows).toString() },
    },
  ],
});

let calls: Call[];
let exportAnswer: (call: Call) => Response;
let exports: Array<Record<string, unknown>>;
const saved: string[] = [];

beforeEach(() => {
  calls = [];
  exports = [];
  saved.length = 0;
  exportAnswer = () => new Response("PK-small", { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": 'attachment; filename="nakuru-hardware-sales-2026-11-01_2026-11-17-202611170800.xlsx"' } });
  document.cookie = "ag_csrf=csrf-token; path=/";
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push(this.download);
  });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: new URL(input, "http://app.test") };
    calls.push(call);
    const path = call.url.pathname.replace(/^\/api\/v1/, "");
    if (path === "/report-library/") return json(200, CATALOGUE);
    if (path === "/locations") return json(200, { data: [{ id: "loc-till", name: "Till 1" }] });
    if (path === "/customers") return json(403, { statusCode: 403, error: "Forbidden", message: "Your role does not permit this action." });
    if (path === "/payroll/runs") return json(200, { data: [{ id: "run-4", runNumber: 4, periodYear: 2026, periodMonth: 10 }] });
    if (path === "/report-library/exports") return json(200, { data: exports });
    if (path === "/report-library/sales") return json(200, VIEW(3));
    if (path === "/report-library/payroll-muster") return json(200, { ...VIEW(2), reportId: "payroll-muster", title: "Payroll muster roll" });
    if (path === "/report-library/sales/export") return exportAnswer(call);
    if (/^\/report-library\/exports\/[^/]+\/download$/.test(path)) {
      return new Response("PK-big", { status: 200, headers: { "content-disposition": 'attachment; filename="big.xlsx"' } });
    }
    return json(404, { statusCode: 404, error: "Not Found", message: "unrouted" });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const exportCalls = () => calls.filter((c) => c.url.pathname.endsWith("/export"));

describe("the export screen", () => {
  it("lists what the library offers this role, runs a report and exports exactly the applied filters", async () => {
    const user = userEvent.setup();
    show(<Exports />);
    const nav = await screen.findByRole("navigation", { name: "Reports" });
    expect(within(nav).getByRole("heading", { name: "Sales, stock and purchasing" })).toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Sales" }));
    // A report with no required filter runs at once with its stated defaults.
    const table = await screen.findByRole("region", { name: "Results: Sales" });
    expect(within(table).getByText("SALE-1")).toBeInTheDocument();
    expect(within(table).getByText("3,703.50")).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await user.selectOptions(screen.getByLabelText("Status"), "COMPLETED");
    await user.selectOptions(await screen.findByLabelText("Location"), "loc-till");
    await user.click(screen.getByRole("button", { name: "Show report" }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === "/api/v1/report-library/sales" && c.url.searchParams.get("status") === "COMPLETED")).toBe(true));

    // A change NOT yet shown does not reach the export: the file is exactly the view.
    await user.selectOptions(screen.getByLabelText("Status"), "VOIDED");
    await user.click(screen.getByRole("button", { name: /Export Excel/ }));
    expect(await screen.findByText(/Saved nakuru-hardware-sales-2026-11-01_2026-11-17-202611170800\.xlsx/)).toBeInTheDocument();
    const exported = exportCalls()[0]?.url.searchParams;
    expect(exported?.get("format")).toBe("xlsx");
    expect(exported?.get("status")).toBe("COMPLETED");
    expect(exported?.get("locationId")).toBe("loc-till");
    expect(saved).toEqual(["nakuru-hardware-sales-2026-11-01_2026-11-17-202611170800.xlsx"]);
  });

  it("does not offer a filter whose list this role may not read", async () => {
    const user = userEvent.setup();
    show(<Exports />);
    await user.click(await screen.findByRole("button", { name: "Sales" }));
    await screen.findByLabelText("Location");
    await waitFor(() => expect(calls.some((c) => c.url.pathname === "/api/v1/customers")).toBe(true));
    expect(screen.queryByLabelText("Customer")).toBeNull();
  });

  it("a large export is prepared in the background and downloaded from Your exports", async () => {
    const user = userEvent.setup();
    exportAnswer = () => {
      exports = [{ id: "exp-1", reportId: "sales", format: "xlsx", status: "PENDING", rowCount: 9000, filename: null, byteSize: null, error: null, createdAt: "2026-11-17T08:00:00.000Z", finishedAt: null, expiresAt: "2026-11-17T09:00:00.000Z" }];
      return json(202, exports[0]);
    };
    show(<Exports />);
    await user.click(await screen.findByRole("button", { name: "Sales" }));
    await screen.findByRole("region", { name: "Results: Sales" });
    await user.click(screen.getByRole("button", { name: /Export Excel/ }));
    expect(await screen.findByText(/has 9000 rows, so it is being prepared/)).toBeInTheDocument();
    const mine = await screen.findByRole("list", { name: "Your exports" });
    expect(within(mine).getByText(/Being prepared/)).toBeInTheDocument();
    exports = [{ ...exports[0], status: "READY", filename: "big.xlsx", byteSize: 1234, finishedAt: "2026-11-17T08:01:00.000Z", expiresAt: "2026-11-17T08:31:00.000Z" }];
    await user.click(await within(await screen.findByRole("list", { name: "Your exports" }, { timeout: 5000 })).findByRole("button", { name: /Download/ }, { timeout: 5000 }));
    await waitFor(() => expect(saved).toEqual(["big.xlsx"]));
    expect(calls.some((c) => c.url.pathname === "/api/v1/report-library/exports/exp-1/download")).toBe(true);
  });

  it("a confidential report says so, and a required filter must be chosen first", async () => {
    const user = userEvent.setup();
    show(<Exports />);
    await user.click(await screen.findByRole("button", { name: "Payroll muster roll" }));
    expect(screen.getByText(/Confidential: this report holds personal or pay details/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.pathname === "/api/v1/report-library/payroll-muster")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Show report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose payroll run first.");
    await user.selectOptions(await screen.findByLabelText("Payroll run"), "run-4");
    await user.click(screen.getByRole("button", { name: "Show report" }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === "/api/v1/report-library/payroll-muster" && c.url.searchParams.get("runId") === "run-4")).toBe(true));
  });

  it("an export the server refuses says why, and nothing is saved", async () => {
    const user = userEvent.setup();
    exportAnswer = () => json(400, { statusCode: 400, error: "BadRequest", message: "Choose a period of at most 1100 days." });
    show(<Exports />);
    await user.click(await screen.findByRole("button", { name: "Sales" }));
    await screen.findByRole("region", { name: "Results: Sales" });
    await user.click(screen.getByRole("button", { name: /Export CSV/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a period of at most 1100 days.");
    expect(saved).toEqual([]);
  });
});
