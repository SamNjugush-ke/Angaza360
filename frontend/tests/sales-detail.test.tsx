// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/landing";
import type { SaleRecord } from "@/lib/pos/types";
import { axeViolations } from "./support/catalog";
import { installPosFetch, json, receipt, refusal, type Call, type Route } from "./support/pos";
import { salesRoute, showSales, standardSales } from "./support/sales";

// Sales & receipts, Wave 1c part 2: the operational sale detail (lines with their tax codes,
// tenders with channel, status and M-Pesa reference, totals, payment and fiscal status, location,
// void reason), the receipt reprint, and the void — a manager's or owner's, with a reason, a
// confirmation, and the closed-shift cash-refund refusal surfaced with the way forward.

vi.mock("next/navigation", () => ({ usePathname: () => "/sales", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];
let sales: SaleRecord[];
const print = vi.fn();

beforeEach(() => {
  sales = standardSales();
  ({ calls, routes } = installPosFetch());
  routes.push(salesRoute(() => sales));
  routes.push((call) => {
    const match = /^\/api\/v1\/pos\/sales\/(sale-\d+)\/receipt$/.exec(call.url.pathname);
    if (!match) return null;
    const found = sales.find((s) => s.id === match[1]);
    return json(200, receipt({ saleNumber: found?.saleNumber ?? "", status: found?.status ?? "COMPLETED" }));
  });
  routes.push((call) => {
    const match = /^\/api\/v1\/pos\/sales\/(sale-\d+)$/.exec(call.url.pathname);
    return match && call.method === "GET" ? json(200, sales.find((s) => s.id === match[1])) : null;
  });
  routes.push((call) => {
    const match = /^\/api\/v1\/pos\/sales\/(sale-\d+)\/void$/.exec(call.url.pathname);
    if (!match || call.method !== "POST") return null;
    const reason = (call.body as { reason: string }).reason;
    sales = sales.map((s) => (s.id === match[1] ? { ...s, status: "VOIDED" as const, voidReason: reason } : s));
    const voided = sales.find((s) => s.id === match[1]);
    return json(200, { ...voided, creditNote: voided?.fiscalStatus === "SIGNED" ? { invoiceId: "inv-1", etimsInvoiceNumber: 17 } : null });
  });
  vi.stubGlobal("print", print);
  print.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const voidCalls = () => calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/void"));

async function openSale(role: Role, saleNumber: string) {
  const user = userEvent.setup();
  showSales(role);
  const table = await screen.findByRole("table", { name: "Sales" });
  await user.click(within(table).getByRole("button", { name: saleNumber }));
  const sheet = await screen.findByRole("dialog", { name: saleNumber });
  await within(sheet).findByRole("heading", { name: "Items" });
  return { user, sheet };
}

describe("the operational sale detail", () => {
  it("shows the lines, tenders, totals, payment and fiscal status, location and customer", async () => {
    sales[3] = {
      ...(sales[3] as SaleRecord),
      customerId: "c-1",
      lines: [
        { ...(sales[3] as SaleRecord).lines[0], discount: "5000", lineNet: "79500", lineTotal: "79500" } as SaleRecord["lines"][number],
        { lineNumber: 2, productId: "p-del", sku: "NKH-SVC-DEL", name: "Delivery", quantity: "1.000", unitPrice: "5000", discount: "0", vatRate: "16.00", taxClass: "STANDARD_RATED", taxCode: "B", lineNet: "5000", lineVat: "800", lineTotal: "5800", unitCogs: "0", lineCogs: "0" },
      ],
    };
    const { sheet } = await openSale("MSME_OWNER", "SALE-20261105-000004");
    const items = within(sheet).getByRole("table", { name: "Items sold" });
    const [, cement, delivery] = within(items).getAllByRole("row");
    expect(within(cement as HTMLElement).getAllByRole("cell").map((c) => c.textContent)).toEqual(["NKH-CEM-50", "Bamburi Cement 50kg", "1", "845.00", "50.00", "0% · D", "795.00"]);
    expect(within(delivery as HTMLElement).getAllByRole("cell").map((c) => c.textContent)).toEqual(["NKH-SVC-DEL", "Delivery", "1", "50.00", "—", "16% · B", "58.00"]);
    const payments = within(sheet).getByRole("heading", { name: "Payments" }).parentElement as HTMLElement;
    expect(payments).toHaveTextContent("Cash");
    expect(payments).toHaveTextContent("KES 500.00 handed over");
    expect(payments).toHaveTextContent("M-Pesa · STK");
    expect(payments).toHaveTextContent("Confirmed · M-Pesa ref SIM6B0E4315");
    expect(within(sheet).getByText("Kiptoo Hardware")).toBeInTheDocument();
    expect(within(sheet).getByText("Till 1")).toBeInTheDocument();
    expect(within(sheet).getByText("Paid in full")).toBeInTheDocument();
    expect(within(sheet).getByText("No KRA invoice requested")).toBeInTheDocument();
    expect(within(sheet).getByText("Total").nextSibling).toHaveTextContent("KES 845.00");
    expect(await axeViolations()).toEqual([]);
  });

  it("a voided sale shows its reason, and is not offered for voiding again", async () => {
    const { sheet } = await openSale("MSME_OWNER", "SALE-20261105-000002");
    expect(within(sheet).getAllByText("Voided").length).toBeGreaterThan(0);
    expect(within(sheet).getByText(/Reason: Customer changed their mind/)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Void sale" })).not.toBeInTheDocument();
  });

  it("a KRA-signed sale says so", async () => {
    sales[0] = { ...(sales[0] as SaleRecord), fiscalStatus: "SIGNED" };
    const { sheet } = await openSale("CASHIER", "SALE-20261105-000001");
    expect(within(sheet).getByText("Signed by KRA (eTIMS)")).toBeInTheDocument();
  });
});

describe("reprint", () => {
  it("View / print receipt shows the customer's receipt and prints it; Back returns to the details", async () => {
    const { user, sheet } = await openSale("CASHIER", "SALE-20261105-000001");
    await user.click(within(sheet).getByRole("button", { name: "View / print receipt" }));
    expect(await within(sheet).findByRole("article", { name: "Receipt" })).toBeInTheDocument();
    const back = within(sheet).getByRole("button", { name: "Back to the sale" });
    await waitFor(() => expect(back).toHaveFocus());
    await user.click(within(sheet).getByRole("button", { name: "Print receipt" }));
    expect(print).toHaveBeenCalledOnce();
    expect(sheet.querySelector(".print-area article")).not.toBeNull();
    await user.click(back);
    await waitFor(() => expect(within(sheet).getByRole("button", { name: "View / print receipt" })).toHaveFocus());
  });
});

describe("void — a manager's or owner's decision", () => {
  it("the owner voids with a reason, after confirming; the sale and the list both show Voided", async () => {
    const { user, sheet } = await openSale("MSME_OWNER", "SALE-20261105-000003");
    await user.click(within(sheet).getByRole("button", { name: "Void sale" }));
    await user.click(within(sheet).getByRole("button", { name: "Review the void" }));
    expect(within(sheet).getByText("Give a reason — it is kept with the sale.")).toBeInTheDocument();
    expect(voidCalls()).toHaveLength(0);
    await user.type(within(sheet).getByLabelText("Reason for the void"), "Rung twice");
    await user.click(within(sheet).getByRole("button", { name: "Review the void" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, void the sale" }));
    expect(await within(sheet).findByText(/This sale is voided\. Reason: Rung twice/)).toBeInTheDocument();
    expect(voidCalls().map((call) => call.body)).toEqual([{ reason: "Rung twice" }]);
    await user.keyboard("{Escape}");
    const row = within(screen.getByRole("table", { name: "Sales" })).getByRole("button", { name: "SALE-20261105-000003" }).closest("tr") as HTMLElement;
    await waitFor(() => expect(within(row).getByText("Voided")).toBeInTheDocument());
  });

  it("a manager may void too", async () => {
    const { sheet } = await openSale("MSME_MANAGER", "SALE-20261105-000003");
    expect(within(sheet).getByRole("button", { name: "Void sale" })).toBeEnabled();
  });

  it("a cashier and an accountant see it disabled: a manager must authorise a void", async () => {
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      const { sheet } = await openSale(role, "SALE-20261105-000003");
      const button = within(sheet).getByRole("button", { name: "Void sale" });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription("A manager must authorise a void.");
      cleanup();
    }
    expect(voidCalls()).toHaveLength(0);
  });

  it("a cash sale whose shift has closed: the refusal is shown with the way forward, and the reason kept", async () => {
    routes.unshift((call) =>
      call.method === "POST" && call.url.pathname.endsWith("/void")
        ? refusal(400, "Sale SALE-20261105-000003 took cash, and its shift is closed: the refund has to come out of an open till. Open a shift, or name the shift the cash is paid from.")
        : null,
    );
    const { user, sheet } = await openSale("MSME_OWNER", "SALE-20261105-000003");
    await user.click(within(sheet).getByRole("button", { name: "Void sale" }));
    await user.type(within(sheet).getByLabelText("Reason for the void"), "Returned");
    await user.click(within(sheet).getByRole("button", { name: "Review the void" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, void the sale" }));
    const alert = await within(sheet).findByRole("alert");
    expect(alert).toHaveTextContent("its shift is closed: the refund has to come out of an open till");
    expect(within(alert).getByRole("link", { name: "Open a shift on the till, then void again" })).toHaveAttribute("href", "/pos");
    expect(within(sheet).getByLabelText("Reason for the void")).toHaveValue("Returned");
  });

  it("voiding a KRA-signed sale says a credit note is owed", async () => {
    sales[2] = { ...(sales[2] as SaleRecord), fiscalStatus: "SIGNED" };
    const { user, sheet } = await openSale("MSME_OWNER", "SALE-20261105-000003");
    await user.click(within(sheet).getByRole("button", { name: "Void sale" }));
    await user.type(within(sheet).getByLabelText("Reason for the void"), "Wrong item");
    await user.click(within(sheet).getByRole("button", { name: "Review the void" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, void the sale" }));
    expect(await within(sheet).findByText(/a credit note \(eTIMS no. 17\) is owed to KRA/)).toBeInTheDocument();
  });
});
