// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allocateOldestFirst, allocationsToBody, checkAllocation } from "@/lib/allocation";
import { businessToday } from "@/lib/datetime";
import { axeViolations } from "./support/catalog";
import { installMoneyServer, posted, refusal, showCustomers, type MoneyServer } from "./support/money";

// Customers & receivables (Wave 3 part A): the directory, a customer's statement, credit and open
// items, recording a receipt allocated across open credit sales (oldest first, checked to the cent,
// over-allocation refused), the AR aging and the receipts list — and who sees which: a cashier gets
// the directory only; the accountant and auditor, who cannot read the directory, get receivables.

vi.mock("next/navigation", () => ({ usePathname: () => "/customers", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: MoneyServer;
const today = businessToday();
beforeEach(() => {
  server = installMoneyServer();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const receivableCalls = () => server.calls.filter((c) => c.url.pathname.startsWith("/api/v1/receivables"));

async function openKiptoo(user: ReturnType<typeof userEvent.setup>) {
  const list = await screen.findByRole("list", { name: "Customers" });
  await user.click(within(list).getByRole("button", { name: /Kiptoo Construction Ltd/ }));
  return screen.findByRole("dialog", { name: "Kiptoo Construction Ltd" });
}

describe("a customer's account", () => {
  it("the owner sees balances, the statement with its running balance, the credit limit and what is still owed", async () => {
    const user = userEvent.setup();
    showCustomers("MSME_OWNER");
    const list = await screen.findByRole("list", { name: "Customers" });
    expect(within(list).getByRole("button", { name: /Kiptoo/ })).toHaveTextContent("Owes KES 5,000.00");
    const sheet = await openKiptoo(user);
    const credit = await within(sheet).findByRole("region", { name: "Credit" });
    expect(credit).toHaveTextContent("Owes nowKES 5,000.00");
    expect(credit).toHaveTextContent("Credit limitKES 100,000.00");
    expect(credit).toHaveTextContent("KES 5,000.00 of it used");
    const statement = within(sheet).getByRole("table", { name: "Statement for Kiptoo Construction Ltd" });
    expect(within(statement).getAllByRole("row")[2]).toHaveTextContent(/SALE-20261101-000004.*3,000.00.*5,000.00/);
    const owed = within(sheet).getByRole("list", { name: "Open credit sales" });
    expect(within(owed).getAllByRole("listitem")[0]).toHaveTextContent("SALE-20260901-000001");
    expect(sheet).toHaveTextContent("Loyalty points40");
    expect(await axeViolations()).toEqual([]);
  });

  it("records a receipt split oldest first, shows what it clears, and the balance drops", async () => {
    const user = userEvent.setup();
    showCustomers("MSME_OWNER");
    const sheet = await openKiptoo(user);
    await user.click(await within(sheet).findByRole("button", { name: "Record receipt" }));
    const form = await screen.findByRole("dialog", { name: "Record a receipt — Kiptoo Construction Ltd" });
    await user.type(within(form).getByLabelText("Amount received (KES)"), "3,000");
    await user.click(await within(form).findByRole("button", { name: "Allocate oldest first" }));
    expect(within(form).getByLabelText("SALE-20260901-000001 — pay (KES)")).toHaveValue("2000.00");
    expect(within(form).getByLabelText("SALE-20261101-000004 — pay (KES)")).toHaveValue("1000.00");
    expect(within(form).getByText(/owes KES 2,000.00 of 2,000.00 · 70 days · this clears it/)).toBeInTheDocument();
    expect(within(form).getByText(/leaves KES 2,000.00/)).toBeInTheDocument();
    expect(within(form).getByText("All KES 3,000.00 is allocated.")).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/Reference/), "QK7AB12CDE");
    await user.click(within(form).getByRole("button", { name: "Record receipt" }));
    expect(await within(form).findByRole("status")).toHaveTextContent("Receipt 1 recorded: KES 3,000.00 from Kiptoo Construction Ltd by M-Pesa");
    expect(posted(server, "/receivables/receipts")).toEqual([
      { customerId: "c-1", receiptDate: today, method: "MPESA", amount: "3000.00", reference: "QK7AB12CDE", allocations: [{ saleId: "s-1", amount: "2000.00" }, { saleId: "s-2", amount: "1000.00" }] },
    ]);
    await user.click(within(form).getByRole("button", { name: "Back to Kiptoo Construction Ltd" }));
    const after = await screen.findByRole("dialog", { name: "Kiptoo Construction Ltd" });
    await waitFor(() => expect(within(after).getByRole("region", { name: "Credit" })).toHaveTextContent("Owes nowKES 2,000.00"));
  });

  it("over-allocation is refused before sending; a total that does not add up cannot be saved; a server refusal keeps the input", async () => {
    const user = userEvent.setup();
    showCustomers("MSME_MANAGER");
    const sheet = await openKiptoo(user);
    await user.click(await within(sheet).findByRole("button", { name: "Record receipt" }));
    const form = await screen.findByRole("dialog", { name: /Record a receipt/ });
    await user.type(within(form).getByLabelText("Amount received (KES)"), "2500");
    await user.type(await within(form).findByLabelText("SALE-20260901-000001 — pay (KES)"), "2500");
    expect(within(form).getByText("That is more than is owed on it.")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Record receipt" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Allocate the whole amount across the sales below");
    await user.clear(within(form).getByLabelText("SALE-20260901-000001 — pay (KES)"));
    await user.type(within(form).getByLabelText("SALE-20260901-000001 — pay (KES)"), "2000");
    expect(within(form).getByText("KES 500.00 still to allocate — every shilling must go to an item.")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("SALE-20261101-000004 — pay (KES)"), "500");
    server.routes.unshift((call) => (call.method === "POST" && call.url.pathname === "/api/v1/receivables/receipts" ? refusal(409, "Accounting period 2026-11 is closed.") : null));
    await user.click(within(form).getByRole("button", { name: "Record receipt" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Accounting period 2026-11 is closed.");
    expect(within(form).getByLabelText("Amount received (KES)")).toHaveValue("2500");
    expect(within(form).getByLabelText("SALE-20261101-000004 — pay (KES)")).toHaveValue("500");
  });

  it("the header's Record receipt picks a customer from those who owe", async () => {
    const user = userEvent.setup();
    showCustomers("MSME_OWNER");
    await user.click(await screen.findByRole("button", { name: "Record receipt" }));
    const form = await screen.findByRole("dialog", { name: "Record a receipt" });
    const picker = within(form).getByLabelText("Customer");
    await waitFor(() => expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a customer", "Kiptoo Construction Ltd — owes KES 5,000.00"]));
    await user.click(within(form).getByRole("button", { name: "Record receipt" }));
    expect(within(form).getByText("Choose the customer who paid.")).toBeInTheDocument();
  });

  it("the manager edits a customer's credit limit in shillings", async () => {
    const user = userEvent.setup();
    showCustomers("MSME_MANAGER");
    const sheet = await openKiptoo(user);
    await user.click(within(sheet).getByRole("button", { name: "Edit customer" }));
    const form = await screen.findByRole("dialog", { name: "Edit Kiptoo Construction Ltd" });
    const limit = within(form).getByLabelText(/Credit limit/);
    expect(limit).toHaveValue("100000.00");
    await user.clear(limit);
    await user.type(limit, "150,000");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    await screen.findByRole("dialog", { name: "Kiptoo Construction Ltd" });
    expect(posted(server, "/customers/c-1", "PATCH")).toEqual([{ name: "Kiptoo Construction Ltd", phone: "0712345678", email: "", kraPin: "", creditLimit: "150000.00", isActive: true }]);
  });
});

describe("aging and receipts", () => {
  it("AR aging buckets each customer by the age of their credit sales", async () => {
    const user = userEvent.setup();
    showCustomers("ACCOUNTANT");
    await user.click(await screen.findByRole("tab", { name: "Aging" }));
    const table = await screen.findByRole("table", { name: "Receivables by age" });
    const kiptoo = within(table).getByRole("button", { name: "Kiptoo Construction Ltd" }).closest("tr") as HTMLElement;
    expect(within(kiptoo).getAllByRole("cell").map((c) => c.textContent)).toEqual(["—", "3,000.00", "—", "2,000.00", "—", "5,000.00"]);
    expect(screen.getByText("Total outstanding: KES 5,000.00")).toBeInTheDocument();
    expect(server.calls.find((c) => c.url.pathname === "/api/v1/receivables/aging")?.url.search).toBe(`?asOf=${today}`);
  });

  it("the receipts list filters by method", async () => {
    const user = userEvent.setup();
    showCustomers("VIEWER_AUDITOR");
    await user.click(await screen.findByRole("tab", { name: "Receipts" }));
    expect(await screen.findByText("No receipts yet")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Paid by"), "Cash");
    expect(await screen.findByText("No Cash receipts")).toBeInTheDocument();
    expect(server.calls.at(-1)?.url.search).toBe("?method=CASH");
  });
});

describe("role-adaptive", () => {
  it("a cashier sees only the directory: no balances owed, statement, receipts or aging — and never asks for them", async () => {
    const user = userEvent.setup();
    showCustomers("CASHIER");
    const list = await screen.findByRole("list", { name: "Customers" });
    expect(within(list).getByRole("button", { name: /Kiptoo/ })).not.toHaveTextContent("Owes");
    expect(screen.queryByRole("tab", { name: "Aging" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Receipts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record receipt" })).not.toBeInTheDocument();
    const sheet = await openKiptoo(user);
    expect(within(sheet).getByText("Balances owed are kept by the owner, manager and accountant.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Edit customer" })).not.toBeInTheDocument();
    expect(receivableCalls()).toEqual([]);
    // A cashier may still add a customer — without a credit limit.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Add customer" }));
    const form = await screen.findByRole("dialog", { name: "Add a customer" });
    expect(within(form).queryByLabelText(/Credit limit/)).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("Customer name"), "Mama Njeri");
    await user.click(within(form).getByRole("button", { name: "Add customer" }));
    expect(await screen.findByText("Mama Njeri was added.")).toBeInTheDocument();
    expect(posted(server, "/customers")).toEqual([{ name: "Mama Njeri" }]);
    expect(receivableCalls()).toEqual([]);
  });

  it("the accountant, who cannot read the directory, works from the customers who owe and records receipts", async () => {
    const user = userEvent.setup();
    showCustomers("ACCOUNTANT");
    const list = await screen.findByRole("list", { name: "Customers" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(/The full directory is kept by the owner, manager and cashiers/)).toBeInTheDocument();
    expect(server.calls.some((c) => c.url.pathname === "/api/v1/customers")).toBe(false);
    await user.click(within(list).getByRole("button", { name: /Kiptoo/ }));
    const sheet = await screen.findByRole("dialog", { name: "Kiptoo Construction Ltd" });
    expect(await within(sheet).findByRole("button", { name: "Record receipt" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Edit customer" })).not.toBeInTheDocument();
    // …and from the page header too.
    expect(screen.getAllByRole("button", { name: "Record receipt" })).toHaveLength(2);
  });

  it("the auditor reads receivables but records nothing", async () => {
    const user = userEvent.setup();
    showCustomers("VIEWER_AUDITOR");
    const list = await screen.findByRole("list", { name: "Customers" });
    expect(screen.queryByRole("button", { name: "Record receipt" })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Kiptoo/ }));
    const sheet = await screen.findByRole("dialog", { name: "Kiptoo Construction Ltd" });
    await within(sheet).findByRole("table", { name: /Statement/ });
    expect(within(sheet).queryByRole("button", { name: "Record receipt" })).not.toBeInTheDocument();
  });
});

describe("allocation, pure: BigInt cents, never numbers", () => {
  const items = [
    { id: "a", outstanding: "200000" },
    { id: "b", outstanding: "300000" },
  ];
  it("fills the oldest first, each up to what it owes", () => {
    expect(allocateOldestFirst(items, 250000n)).toEqual({ a: "2000.00", b: "500.00" });
    expect(allocateOldestFirst(items, 100001n)).toEqual({ a: "1000.01", b: "" });
    expect(allocateOldestFirst(items, 999999n)).toEqual({ a: "2000.00", b: "3000.00" });
  });
  it("checks every share and the total to the cent, and sends only the shares", () => {
    expect(checkAllocation(items, { a: "2000.00", b: "500.00" }, 250000n).ok).toBe(true);
    expect(checkAllocation(items, { a: "2000.01" }, 200001n).problems.a).toBe("That is more than is owed on it.");
    expect(checkAllocation(items, { a: "2000" }, 200001n)).toMatchObject({ ok: false, unallocated: 1n });
    expect(allocationsToBody(items, { a: "2,000", b: "" }, "saleId")).toEqual([{ saleId: "a", amount: "2000.00" }]);
  });
});
