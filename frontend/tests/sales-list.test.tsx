// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessToday, toBusinessDate } from "@/lib/datetime";
import type { SaleRecord } from "@/lib/pos/types";
import { salesQuery, type SalesFilters } from "@/lib/sales/sales";
import { axeViolations } from "./support/catalog";
import { installPosFetch, json, receipt, refusal, type Call, type Route } from "./support/pos";
import { lastListQuery, listCalls, sale, salesRoute, showSales, standardSales } from "./support/sales";

// Sales & receipts, Wave 1c part 1: the list, filtered and paged by the SERVER — sale number,
// status, customer, business-day dates, or only the caller's open shift — with the filtered total,
// every state (loading, empty, no match, error, no open shift), and the role's view. The BFF is
// stubbed at fetch, filtering like the server, so each test checks the query sent and the result.

vi.mock("next/navigation", () => ({ usePathname: () => "/sales", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];
let sales: SaleRecord[];
const today = businessToday();

beforeEach(() => {
  sales = standardSales();
  ({ calls, routes } = installPosFetch());
  routes.push(salesRoute(() => sales));
  routes.push((call) => (call.url.pathname.endsWith("/receipt") ? json(200, receipt({ saleNumber: "SALE-20261105-000001" })) : null));
  routes.push((call) => (/^\/api\/v1\/pos\/sales\/sale-\d+$/.test(call.url.pathname) ? json(200, sales.find((s) => `/api/v1/pos/sales/${s.id}` === call.url.pathname)) : null));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const table = () => screen.getByRole("table", { name: "Sales" });
const rowNumbers = () => within(table()).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
async function loaded() {
  await screen.findByRole("table", { name: "Sales" });
}

describe("the list", () => {
  it("opens on today's sales: business-day dates, the filtered total, and every column", async () => {
    showSales();
    await loaded();
    expect(lastListQuery(calls)).toEqual({ take: "25", skip: "0", from: today, to: today });
    expect(rowNumbers()).toEqual(["SALE-20261105-000001", "SALE-20261105-000002", "SALE-20261105-000003", "SALE-20261105-000004"]);
    const [first, second, , fourth] = within(table()).getAllByRole("row").slice(1);
    if (!first || !second || !fourth) throw new Error("rows");
    expect(first).toHaveTextContent("Kiptoo Hardware");
    expect(first).toHaveTextContent("845.00");
    expect(within(first).getByText("M-Pesa · Till")).toBeInTheDocument();
    expect(within(first).getByText("Completed")).toBeInTheDocument();
    expect(within(second).getByText("Voided")).toBeInTheDocument();
    expect(second).toHaveTextContent("Walk-in");
    expect(within(fourth).getByText("Cash")).toBeInTheDocument();
    expect(within(fourth).getByText("M-Pesa · STK")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–4 of 4 sales")).toBeInTheDocument();
    // The same sales as cards for a phone.
    expect(within(screen.getByRole("list", { name: "Sales" })).getAllByRole("button")).toHaveLength(4);
    expect(await axeViolations()).toEqual([]);
  });

  it("searches the sale number, after a pause in typing", async () => {
    const user = userEvent.setup();
    showSales();
    await loaded();
    await user.type(screen.getByLabelText("Sale number"), "000003");
    await waitFor(() => expect(lastListQuery(calls).q).toBe("000003"));
    await waitFor(() => expect(rowNumbers()).toEqual(["SALE-20261105-000003"]));
    expect(screen.getByText("Showing 1–1 of 1 sale")).toBeInTheDocument();
    // Typing is debounced: one query for the whole number, not one per key.
    expect(listCalls(calls).filter((call) => call.url.searchParams.has("q"))).toHaveLength(1);
  });

  it("filters to voided sales", async () => {
    const user = userEvent.setup();
    showSales();
    await loaded();
    await user.selectOptions(screen.getByLabelText("Status"), "Voided");
    await waitFor(() => expect(rowNumbers()).toEqual(["SALE-20261105-000002"]));
    expect(lastListQuery(calls)).toMatchObject({ status: "VOIDED" });
  });

  it("filters to one customer, found by name", async () => {
    const user = userEvent.setup();
    showSales();
    await loaded();
    await user.type(screen.getByLabelText("Find a customer"), "Wanj");
    const picker = screen.getByLabelText("Customer");
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["All customers", "Wanjiru Builders · 0722000000"]);
    await user.selectOptions(picker, "c-2");
    await waitFor(() => expect(rowNumbers()).toEqual(["SALE-20261105-000003"]));
    expect(lastListQuery(calls)).toMatchObject({ customerId: "c-2" });
  });

  it("widens the dates to find an older sale; a backwards range asks for a fix and queries nothing", async () => {
    showSales();
    await loaded();
    const tenDaysAgo = toBusinessDate(new Date(Date.now() - 10 * 86_400_000));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: tenDaysAgo } });
    await waitFor(() => expect(rowNumbers()).toContain("SALE-20261105-000009"));
    expect(lastListQuery(calls)).toMatchObject({ from: tenDaysAgo, to: today });

    const before = listCalls(calls).length;
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2099-01-01" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("The start date is after the end date. Change the dates to see sales.");
    expect(listCalls(calls)).toHaveLength(before);
  });

  it("current shift only: the open shift's id replaces the dates", async () => {
    const user = userEvent.setup();
    showSales("CASHIER");
    await loaded();
    await user.click(screen.getByRole("checkbox", { name: "Current shift only" }));
    await waitFor(() => expect(lastListQuery(calls)).toEqual({ take: "25", skip: "0", shiftId: "shift-1" }));
    expect(screen.getByLabelText("From")).toBeDisabled();
    expect(screen.getByText(/the dates don’t apply/)).toBeInTheDocument();
    await waitFor(() => expect(rowNumbers()).not.toContain("SALE-20261105-000009"));
  });

  it("with no open shift, current shift only says so and offers a way on", async () => {
    routes.unshift((call) => (call.url.pathname === "/api/v1/pos/shifts/current" ? refusal(404, "No open shift.") : null));
    const user = userEvent.setup();
    showSales("CASHIER");
    await loaded();
    const before = listCalls(calls).length;
    await user.click(screen.getByRole("checkbox", { name: "Current shift only" }));
    expect(await screen.findByText("You have no open shift")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the till" })).toHaveAttribute("href", "/pos");
    expect(listCalls(calls)).toHaveLength(before);
    await user.click(screen.getByRole("button", { name: "Show sales by date" }));
    expect(screen.getByRole("checkbox", { name: "Current shift only" })).not.toBeChecked();
    await loaded();
  });

  it("pages through the filtered total", async () => {
    sales = Array.from({ length: 30 }, (_, i) => sale(i + 1));
    const user = userEvent.setup();
    showSales();
    await loaded();
    expect(screen.getByText("Showing 1–25 of 30 sales")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Showing 26–30 of 30 sales")).toBeInTheDocument());
    expect(lastListQuery(calls)).toMatchObject({ skip: "25", take: "25" });
    expect(rowNumbers()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    // A new filter starts again at page 1.
    await user.selectOptions(screen.getByLabelText("Status"), "Completed");
    await waitFor(() => expect(lastListQuery(calls)).toMatchObject({ skip: "0", status: "COMPLETED" }));
  });

  it("no match: says so, and Clear filters goes back to today", async () => {
    const user = userEvent.setup();
    showSales();
    await loaded();
    await user.type(screen.getByLabelText("Sale number"), "777");
    expect(await screen.findByText("No sales match")).toBeInTheDocument();
    const clear = screen.getAllByRole("button", { name: "Clear filters" });
    await user.click(clear[clear.length - 1] as HTMLElement);
    expect(screen.getByLabelText("Sale number")).toHaveValue("");
    await waitFor(() => expect(rowNumbers()).toHaveLength(4));
  });

  it("nothing today: offers the last seven days", async () => {
    sales = [sale(9, { createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })];
    const user = userEvent.setup();
    showSales();
    expect(await screen.findByText("No sales today yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the last 7 days" }));
    await waitFor(() => expect(rowNumbers()).toEqual(["SALE-20261105-000009"]));
  });

  it("a failed load can be retried", async () => {
    let fail = true;
    routes.unshift((call) => (call.url.pathname === "/api/v1/pos/sales" && fail ? refusal(500, "Something went wrong on our side.") : null));
    const user = userEvent.setup();
    showSales();
    // A 5xx is retried once before the error shows (the query client's policy).
    expect(await screen.findByText("Couldn’t load sales", undefined, { timeout: 5_000 })).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /Try again|Retry/ }));
    await loaded();
  });

  it("a row opens the sale; closing it returns to the list exactly as filtered", async () => {
    const user = userEvent.setup();
    showSales();
    await loaded();
    await user.selectOptions(screen.getByLabelText("Status"), "Completed");
    await waitFor(() => expect(rowNumbers()).not.toContain("SALE-20261105-000002"));
    await user.click(within(table()).getByRole("button", { name: "SALE-20261105-000001" }));
    const sheet = await screen.findByRole("dialog", { name: "SALE-20261105-000001" });
    expect(await within(sheet).findByRole("heading", { name: "Items" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("COMPLETED");
    expect(rowNumbers()).toEqual(["SALE-20261105-000001", "SALE-20261105-000003", "SALE-20261105-000004"]);
  });
});

describe("role-adaptive", () => {
  it("an accountant reads sales without customer names, the customer filter or the shift toggle", async () => {
    showSales("ACCOUNTANT");
    await loaded();
    expect(screen.queryByLabelText("Customer")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Current shift only" })).not.toBeInTheDocument();
    expect(within(table()).getAllByRole("row")[1]).toHaveTextContent("Account customer");
    expect(calls.some((call) => call.url.pathname === "/api/v1/customers")).toBe(false);
    expect(calls.some((call) => call.url.pathname === "/api/v1/pos/shifts/current")).toBe(false);
  });

  it("a cashier has the customer filter and the shift toggle", async () => {
    showSales("CASHIER");
    await loaded();
    expect(screen.getByLabelText("Customer")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Current shift only" })).toBeInTheDocument();
  });
});

describe("the query, pure", () => {
  const base: SalesFilters = { q: "  12 ", status: "VOIDED", customerId: "c-1", from: "2026-11-01", to: "2026-11-05", currentShift: false };
  it("sends only what is set, trimmed, with the page as take/skip", () => {
    expect(new URLSearchParams(salesQuery(base, 2, null) ?? "").toString()).toBe("take=25&skip=50&q=12&status=VOIDED&customerId=c-1&from=2026-11-01&to=2026-11-05");
    expect(salesQuery({ ...base, q: "", status: "", customerId: "" }, 0, null)).toBe("take=25&skip=0&from=2026-11-01&to=2026-11-05");
  });
  it("the shift replaces the dates, and is not asked until its id is known", () => {
    expect(salesQuery({ ...base, currentShift: true }, 0, null)).toBeNull();
    expect(salesQuery({ ...base, currentShift: true }, 0, "shift-7")).toBe("take=25&skip=0&q=12&status=VOIDED&customerId=c-1&shiftId=shift-7");
  });
});
