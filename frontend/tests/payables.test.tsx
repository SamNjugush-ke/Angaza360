// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessToday } from "@/lib/datetime";
import { axeViolations } from "./support/catalog";
import { installMoneyServer, installPayables, posted, showExpenses, type MoneyServer } from "./support/money";

// Expenses & payables (Wave 3 part B): a paid expense recorded and voided; a supplier bill against
// a received purchase order — DRAFT, posted (clearing the GRNI its goods accrued, with the price
// variance shown), paid in part with the payment allocated against it; a bill charged straight to an
// account; cancelling an unpaid bill; the AP aging and a supplier statement; and who may do what.

vi.mock("next/navigation", () => ({ usePathname: () => "/expenses", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: MoneyServer;
const today = businessToday();
beforeEach(() => {
  server = installMoneyServer();
  installPayables(server);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function tab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("tab", { name }));
}

/** Enter + save a draft bill against PO 9 at the invoiced unit cost given. */
async function draftAgainstPo(user: ReturnType<typeof userEvent.setup>, unitCost = "145") {
  await tab(user, "Supplier bills");
  await user.click(await screen.findByRole("button", { name: "Enter a bill" }));
  const sheet = await screen.findByRole("dialog", { name: "Enter a supplier bill" });
  const supplier = within(sheet).getByLabelText("Supplier");
  await waitFor(() => expect(within(supplier).getAllByRole("option")).toHaveLength(2));
  await user.selectOptions(supplier, "sup-1");
  await user.type(within(sheet).getByLabelText("Supplier's invoice number"), "INV-77");
  await user.selectOptions(within(sheet).getByLabelText("Against a purchase order"), "po-9");
  const cost = within(sheet).getByLabelText("Wire Nails 4in (NKH-NAI-4) cost per unit (KES)");
  expect(within(sheet).getByLabelText("Wire Nails 4in (NKH-NAI-4) quantity")).toHaveValue("10");
  expect(cost).toHaveValue("140.00");
  await user.clear(cost);
  await user.type(cost, unitCost);
  await user.click(within(sheet).getByRole("button", { name: "Save as draft" }));
  return screen.findByRole("dialog", { name: "Bill INV-77" });
}

describe("expenses", () => {
  it("records a paid expense in shillings, against an operating-expense category only", async () => {
    const user = userEvent.setup();
    showExpenses("MSME_OWNER");
    await user.click(await screen.findByRole("button", { name: "Record expense" }));
    const sheet = await screen.findByRole("dialog", { name: "Record an expense" });
    const category = within(sheet).getByLabelText("Category");
    await waitFor(() => expect(within(category).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a category", "Rent", "Utilities"]));
    await user.click(within(sheet).getByRole("button", { name: "Record expense" }));
    expect(within(sheet).getByText("Choose what the money was spent on.")).toBeInTheDocument();
    await user.selectOptions(category, "6030");
    await user.type(within(sheet).getByLabelText("What it was for"), "KPLC tokens");
    await user.type(within(sheet).getByLabelText("Amount (KES)"), "1,500.5");
    await user.selectOptions(within(sheet).getByLabelText("Paid by"), "M-Pesa");
    await user.click(within(sheet).getByRole("button", { name: "Record expense" }));
    expect(await screen.findByText(/Recorded “KPLC tokens”: KES 1,500.50 paid by M-Pesa/)).toBeInTheDocument();
    expect(posted(server, "/expenses")).toEqual([{ expenseDate: today, category: "6030", description: "KPLC tokens", paymentMethod: "MPESA", amount: "1500.50" }]);
    expect(within(screen.getByRole("list", { name: "Expenses" })).getByText("KPLC tokens")).toBeInTheDocument();
  });

  it("voids a mistake with a reason; it leaves the list unless voided ones are shown", async () => {
    const user = userEvent.setup();
    showExpenses("ACCOUNTANT");
    await user.click(await screen.findByRole("button", { name: "Record expense" }));
    let sheet = await screen.findByRole("dialog", { name: "Record an expense" });
    await waitFor(() => expect(within(within(sheet).getByLabelText("Category")).getAllByRole("option").length).toBeGreaterThan(1));
    await user.selectOptions(within(sheet).getByLabelText("Category"), "6000");
    await user.type(within(sheet).getByLabelText("What it was for"), "November rent");
    await user.type(within(sheet).getByLabelText("Amount (KES)"), "25000");
    await user.click(within(sheet).getByRole("button", { name: "Record expense" }));
    await user.click(await screen.findByRole("button", { name: "Void November rent" }));
    await user.click(screen.getByRole("button", { name: "Yes, void it" }));
    expect(screen.getByText("Give a reason — it is kept with the expense.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Reason for the void"), "Entered twice");
    await user.click(screen.getByRole("button", { name: "Yes, void it" }));
    expect(await screen.findByText("“November rent” was voided.")).toBeInTheDocument();
    expect(posted(server, "/expenses/e-1/void")).toEqual([{ reason: "Entered twice" }]);
    await waitFor(() => expect(screen.getByText("No expenses recorded")).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: "Show voided expenses" }));
    sheet = await screen.findByRole("list", { name: "Expenses" });
    expect(within(sheet).getByText(/voided: Entered twice/)).toBeInTheDocument();
  });
});

describe("a bill after part of the order has been billed (T-B-PO-LINE-BILLEDQTY)", () => {
  it("starts each line at what was received but not yet billed", async () => {
    cleanup();
    vi.unstubAllGlobals();
    server = installMoneyServer();
    const { po } = installPayables(server);
    const line = po.lines[0];
    if (line) Object.assign(line, { billedQty: "4.000", unbilledQty: "6.000" });
    const user = userEvent.setup();
    showExpenses();
    await tab(user, "Supplier bills");
    await user.click(await screen.findByRole("button", { name: "Enter a bill" }));
    const sheet = await screen.findByRole("dialog", { name: "Enter a supplier bill" });
    const supplier = within(sheet).getByLabelText("Supplier");
    await waitFor(() => expect(within(supplier).getAllByRole("option")).toHaveLength(2));
    await user.selectOptions(supplier, "sup-1");
    await user.selectOptions(within(sheet).getByLabelText("Against a purchase order"), "po-9");
    expect(within(sheet).getByLabelText("Wire Nails 4in (NKH-NAI-4) quantity")).toHaveValue("6");
  });
});

describe("a supplier bill against a received purchase order", () => {
  it("DRAFT → post (clears GRNI, shows the price variance) → pay part of it", async () => {
    const user = userEvent.setup();
    showExpenses("MSME_OWNER");
    let sheet = await draftAgainstPo(user, "145");
    expect(within(sheet).getByRole("status")).toHaveTextContent("Bill INV-77 saved as a draft. Check it, then post it.");
    expect(posted(server, "/payables/bills")).toEqual([
      { supplierId: "sup-1", billNumber: "INV-77", billDate: today, poId: "po-9", lines: [{ description: "Wire Nails 4in", quantity: "10", unitCost: "145.00", purchaseOrderLineId: "pol-1" }] },
    ]);
    const lines = within(sheet).getByRole("table", { name: "Bill lines" });
    expect(within(lines).getAllByRole("row")[1]).toHaveTextContent("on posting");
    expect(await axeViolations()).toEqual([]);

    await user.click(within(sheet).getByRole("button", { name: "Post bill" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, post bill" }));
    sheet = await screen.findByRole("dialog", { name: "Bill INV-77" });
    expect(await within(sheet).findByText(/Bill INV-77 posted — KES 1,450.00 owed to Bamburi Distributors Ltd/)).toBeInTheDocument();
    const row = within(within(sheet).getByRole("table", { name: "Bill lines" })).getAllByRole("row")[1] as HTMLElement;
    expect(within(row).getAllByRole("cell").map((c) => c.textContent)).toEqual([expect.stringContaining("Wire Nails 4in"), "10", "1,450.00", "0.00", "1,400.00", "+50.00"]);
    expect(within(sheet).getByText(/booked to purchase price variance, not added to the stock/)).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Pay this supplier" }));
    sheet = await screen.findByRole("dialog", { name: "Pay Bamburi Distributors Ltd" });
    await user.type(within(sheet).getByLabelText("Amount paid (KES)"), "1000");
    await user.click(await within(sheet).findByRole("button", { name: "Allocate oldest first" }));
    expect(within(sheet).getByLabelText("Bill INV-77 — pay (KES)")).toHaveValue("1000.00");
    expect(within(sheet).getByText(/leaves KES 450.00/)).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText(/Reference/), "FT-2211");
    await user.click(within(sheet).getByRole("button", { name: "Record payment" }));
    expect(await within(sheet).findByRole("status")).toHaveTextContent("Payment 1 recorded: KES 1,000.00 to Bamburi Distributors Ltd by Bank, against bill INV-77 (KES 1,000.00).");
    expect(posted(server, "/payables/payments")).toEqual([{ supplierId: "sup-1", paymentDate: today, method: "BANK", amount: "1000.00", reference: "FT-2211", allocations: [{ billId: "bill-1", amount: "1000.00" }] }]);
    await user.click(within(sheet).getByRole("button", { name: "Back to the bill" }));
    sheet = await screen.findByRole("dialog", { name: "Bill INV-77" });
    await waitFor(() => expect(within(sheet).getByText("Part paid")).toBeInTheDocument());
    expect(within(sheet).getByText("Still owed").nextSibling).toHaveTextContent("KES 450.00");
    expect(within(sheet).queryByRole("button", { name: "Cancel bill" })).not.toBeInTheDocument();
  });

  it("the same invoice twice is refused, and the form keeps what was typed", async () => {
    const user = userEvent.setup();
    showExpenses("MSME_MANAGER");
    await draftAgainstPo(user);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Enter a bill" }));
    const sheet = await screen.findByRole("dialog", { name: "Enter a supplier bill" });
    await waitFor(() => expect(within(within(sheet).getByLabelText("Supplier")).getAllByRole("option")).toHaveLength(2));
    await user.selectOptions(within(sheet).getByLabelText("Supplier"), "sup-1");
    await user.type(within(sheet).getByLabelText("Supplier's invoice number"), "INV-77");
    await user.click(within(sheet).getByRole("button", { name: "Add a line charged to an account" }));
    await user.type(within(sheet).getByLabelText("What it is"), "Delivery charge");
    await waitFor(() => expect(within(within(sheet).getByLabelText("Account")).getAllByRole("option").length).toBeGreaterThan(1));
    // The bill's own control accounts and inventory are not offered.
    expect(within(within(sheet).getByLabelText("Account")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose an account", "1000 Cash on Hand", "1500 Equipment", "5000 Cost of Goods Sold", "6000 Rent", "6020 Salaries & Wages", "6030 Utilities", "6110 Turnover Tax"]);
    await user.selectOptions(within(sheet).getByLabelText("Account"), "6000");
    await user.type(within(sheet).getByLabelText("Line cost per unit (KES)"), "300");
    await user.click(within(sheet).getByRole("button", { name: "Save as draft" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Invoice INV-77 from this supplier has already been entered.");
    expect(within(sheet).getByLabelText("What it is")).toHaveValue("Delivery charge");
  });

  it("an unpaid posted bill can be cancelled with a reason", async () => {
    const user = userEvent.setup();
    showExpenses("MSME_OWNER");
    let sheet = await draftAgainstPo(user, "140");
    await user.click(within(sheet).getByRole("button", { name: "Post bill" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, post bill" }));
    sheet = await screen.findByRole("dialog", { name: "Bill INV-77" });
    await user.click(await within(sheet).findByRole("button", { name: "Cancel bill" }));
    await user.type(within(sheet).getByLabelText("Reason"), "Wrong supplier invoice");
    await user.click(within(sheet).getByRole("button", { name: "Yes, cancel bill" }));
    sheet = await screen.findByRole("dialog", { name: "Bill INV-77" });
    expect(await within(sheet).findByText("Bill INV-77 cancelled.")).toBeInTheDocument();
    expect(posted(server, "/payables/bills/bill-1/cancel")).toEqual([{ reason: "Wrong supplier invoice" }]);
  });
});

describe("payments, aging and statements", () => {
  it("a payment that over-allocates or does not add up is not sent", async () => {
    const user = userEvent.setup();
    showExpenses("MSME_OWNER");
    let sheet = await draftAgainstPo(user);
    await user.click(within(sheet).getByRole("button", { name: "Post bill" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, post bill" }));
    await user.keyboard("{Escape}");
    await tab(user, "Payments");
    await user.click(await screen.findByRole("button", { name: "Pay a supplier" }));
    sheet = await screen.findByRole("dialog", { name: "Pay a supplier" });
    const supplier = within(sheet).getByLabelText("Supplier");
    await waitFor(() => expect(within(supplier).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a supplier", "Bamburi Distributors Ltd"]));
    await user.selectOptions(supplier, "sup-1");
    await user.type(within(sheet).getByLabelText("Amount paid (KES)"), "2000");
    await user.click(await within(sheet).findByRole("button", { name: "Allocate oldest first" }));
    expect(within(sheet).getByText("KES 550.00 still to allocate — every shilling must go to an item.")).toBeInTheDocument();
    await user.clear(within(sheet).getByLabelText("Bill INV-77 — pay (KES)"));
    await user.type(within(sheet).getByLabelText("Bill INV-77 — pay (KES)"), "2000");
    expect(within(sheet).getByText("That is more than is owed on it.")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Record payment" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Allocate the whole payment across the bills below");
    expect(posted(server, "/payables/payments")).toEqual([]);
  });

  it("the AP aging lists what is owed by supplier, and opens their statement", async () => {
    const user = userEvent.setup();
    showExpenses("VIEWER_AUDITOR");
    await tab(user, "Aging");
    expect(await screen.findByText("Nothing owed to suppliers")).toBeInTheDocument();
    cleanup();
    showExpenses("MSME_OWNER");
    let sheet = await draftAgainstPo(user);
    await user.click(within(sheet).getByRole("button", { name: "Post bill" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, post bill" }));
    await user.keyboard("{Escape}");
    await tab(user, "Aging");
    const table = await screen.findByRole("table", { name: "Payables by age" });
    expect(within(table).getByRole("button", { name: "Bamburi Distributors Ltd" }).closest("tr")).toHaveTextContent(/1,450.00.*1,450.00/);
    await user.click(within(table).getByRole("button", { name: "Bamburi Distributors Ltd" }));
    sheet = await screen.findByRole("dialog", { name: "Statement — Bamburi Distributors Ltd" });
    expect(within(sheet).getByText("Owed to Bamburi Distributors Ltd").nextSibling).toHaveTextContent("KES 1,450.00");
    expect(within(sheet).getByRole("table", { name: /Statement for/ })).toHaveTextContent(/Bill INV-77.*Awaiting payment/);
  });
});

describe("role-adaptive", () => {
  it("the accountant enters bills and pays, choosing the supplier from purchase orders — no suppliers tab or list", async () => {
    const user = userEvent.setup();
    showExpenses("ACCOUNTANT");
    expect(await screen.findByRole("button", { name: "Record expense" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Suppliers" })).not.toBeInTheDocument();
    await tab(user, "Supplier bills");
    await user.click(await screen.findByRole("button", { name: "Enter a bill" }));
    const sheet = await screen.findByRole("dialog", { name: "Enter a supplier bill" });
    expect(within(sheet).getByText("Suppliers you have purchase orders with.")).toBeInTheDocument();
    await waitFor(() => expect(within(within(sheet).getByLabelText("Supplier")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a supplier", "Bamburi Distributors Ltd"]));
    expect(server.calls.some((c) => c.url.pathname === "/api/v1/inventory/suppliers")).toBe(false);
  });

  it("the auditor reads every tab and changes nothing", async () => {
    const user = userEvent.setup();
    showExpenses("VIEWER_AUDITOR");
    await screen.findByRole("tab", { name: "Expenses" });
    expect(screen.queryByRole("button", { name: "Record expense" })).not.toBeInTheDocument();
    await tab(user, "Supplier bills");
    await screen.findByText("No supplier bills yet");
    expect(screen.queryByRole("button", { name: "Enter a bill" })).not.toBeInTheDocument();
    await tab(user, "Payments");
    await screen.findByText("No supplier payments yet");
    expect(screen.queryByRole("button", { name: "Pay a supplier" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Suppliers" })).not.toBeInTheDocument();
  });

  it("the owner and manager also keep the suppliers here", async () => {
    const user = userEvent.setup();
    showExpenses("MSME_MANAGER");
    await tab(user, "Suppliers");
    expect(await screen.findByRole("list", { name: "Suppliers" })).toBeInTheDocument();
  });
});
