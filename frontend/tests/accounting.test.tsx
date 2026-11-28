// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posted } from "./support/money";
import { asked, installLedgerServer, showAccounting, type LedgerServer } from "./support/accounting";
import { axeViolations } from "./support/catalog";
import { refusal } from "./support/money";

// Accounting & reports (Wave 4 part A): the chart of accounts and an account's ledger; a manual
// journal entry posted balanced (shillings on the request, control accounts not offered), refused
// when it does not balance, and reversed; the periods closed and reopened by the roles the API
// allows; and each statement laid out for its readers, with the period picker and the comparative.

vi.mock("next/navigation", () => ({ usePathname: () => "/accounting", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: LedgerServer;
beforeEach(() => {
  server = installLedgerServer();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
async function tab(user: User, name: string) {
  await user.click(await screen.findByRole("tab", { name }));
}

describe("the chart of accounts", () => {
  it("groups the accounts by class and opens an account's ledger with its running balance", async () => {
    const user = userEvent.setup();
    showAccounting();
    await tab(user, "Chart of accounts");
    const assets = await screen.findByRole("list", { name: "Assets" });
    expect(within(assets).getByText("Cash on Hand")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Equity" })).getByText("Owner's Capital")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Expenses" })).getByText("inactive")).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await user.type(screen.getByLabelText("Find an account"), "cash");
    expect(screen.queryByRole("list", { name: "Equity" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("list", { name: "Assets" })).getByRole("button", { name: /Cash on Hand/ }));
    const sheet = await screen.findByRole("dialog", { name: "1000 Cash on Hand" });
    const table = await within(sheet).findByRole("table", { name: "Ledger for 1000 Cash on Hand" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent("JE-000001");
    expect(rows[1]).toHaveTextContent("Opening capital");
    expect(rows[1]).toHaveTextContent("50,000.00");
    expect(rows[2]).toHaveTextContent("Sale SALE-20261102-000001");
    expect(rows[2]).toHaveTextContent("51,160.00");
    expect(within(sheet).getByText("51,160.00", { selector: "span" })).toBeInTheDocument();
  });
});

async function openForm(user: User) {
  await tab(user, "Journal");
  await user.click(await screen.findByRole("button", { name: "Post a journal entry" }));
  const sheet = await screen.findByRole("dialog", { name: "Post a journal entry" });
  const first = within(sheet).getByLabelText("Line 1 account");
  await waitFor(() => expect(within(first).getAllByRole("option").length).toBeGreaterThan(2));
  return sheet;
}

describe("the journal", () => {
  it("lists the entries and opens one", async () => {
    const user = userEvent.setup();
    showAccounting("VIEWER_AUDITOR");
    await tab(user, "Journal");
    const list = await screen.findByRole("list", { name: "Journal entries" });
    const items = within(list).getAllByRole("button");
    expect(items[0]).toHaveAccessibleName("JE-000002 · Sale SALE-20261102-000001");
    await user.click(items[0] as HTMLElement);
    const sheet = await screen.findByRole("dialog", { name: "Journal entry" });
    const lines = await within(sheet).findByRole("table", { name: "Entry lines" });
    expect(within(lines).getByText("Sales Revenue")).toBeInTheDocument();
    // The auditor reads the books; posting and reversing are not theirs.
    expect(within(sheet).queryByRole("button", { name: "Reverse entry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post a journal entry" })).not.toBeInTheDocument();
  });

  it("posts a balanced manual entry in shillings, without offering the control accounts", async () => {
    const user = userEvent.setup();
    showAccounting("ACCOUNTANT");
    const sheet = await openForm(user);
    const codes = within(within(sheet).getByLabelText("Line 1 account")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    for (const control of ["1100", "1200", "2000", "2050"]) expect(codes).not.toContain(control);
    expect(codes).not.toContain("6999"); // inactive
    expect(codes).toContain("6030");

    await user.type(within(sheet).getByLabelText("Description"), "October electricity, paid late");
    await user.selectOptions(within(sheet).getByLabelText("Line 1 account"), "6030");
    await user.type(within(sheet).getByLabelText("Line 1 debit (KES)"), "1,250.50");
    await user.selectOptions(within(sheet).getByLabelText("Line 2 account"), "1000");
    await user.type(within(sheet).getByLabelText("Line 2 credit (KES)"), "1250.5");
    expect(within(sheet).getByText("Balanced")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Post entry" }));

    expect(await screen.findByText("Entry JE-000003 posted.")).toBeInTheDocument();
    const [body] = posted(server, "/ledger/entries") as Array<Record<string, unknown>>;
    expect(body).toMatchObject({ description: "October electricity, paid late", source: "MANUAL", lines: [{ accountCode: "6030", debit: "1250.50" }, { accountCode: "1000", credit: "1250.50" }] });
    // The new entry opens on its own.
    const detail = await screen.findByRole("dialog", { name: "Journal entry" });
    expect(await within(detail).findByText("Utilities")).toBeInTheDocument();
  });

  it("refuses an entry that does not balance before sending it, and keeps a server refusal with the input", async () => {
    const user = userEvent.setup();
    showAccounting("MSME_OWNER");
    const sheet = await openForm(user);
    await user.type(within(sheet).getByLabelText("Description"), "Rent");
    await user.selectOptions(within(sheet).getByLabelText("Line 1 account"), "6000");
    await user.type(within(sheet).getByLabelText("Line 1 debit (KES)"), "15000");
    await user.selectOptions(within(sheet).getByLabelText("Line 2 account"), "1000");
    await user.type(within(sheet).getByLabelText("Line 2 credit (KES)"), "14000");
    expect(within(sheet).getByText("KES 1,000.00 more debit")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Post entry" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Debits and credits must be equal");
    expect(posted(server, "/ledger/entries")).toHaveLength(0);

    // Balanced now, but dated in the closed month: the server refuses and the input stays.
    await user.clear(within(sheet).getByLabelText("Line 2 credit (KES)"));
    await user.type(within(sheet).getByLabelText("Line 2 credit (KES)"), "15000");
    const date = within(sheet).getByLabelText("Entry date");
    await user.clear(date);
    await user.type(date, "2026-10-15");
    await user.click(within(sheet).getByRole("button", { name: "Post entry" }));
    expect(await within(sheet).findByText(/Accounting period 2026-10 is closed/)).toBeInTheDocument();
    expect(within(sheet).getByLabelText("Description")).toHaveValue("Rent");
    expect(within(sheet).getByLabelText("Line 1 debit (KES)")).toHaveValue("15000");
    expect(posted(server, "/ledger/entries")).toEqual([expect.objectContaining({ entryDate: "2026-10-15", lines: [{ accountCode: "6000", debit: "15000.00" }, { accountCode: "1000", credit: "15000.00" }] })]);
  });

  it("refuses an entry with fewer than two lines or a line carrying both sides", async () => {
    const user = userEvent.setup();
    showAccounting();
    const sheet = await openForm(user);
    await user.type(within(sheet).getByLabelText("Description"), "One-sided");
    await user.selectOptions(within(sheet).getByLabelText("Line 1 account"), "6000");
    await user.type(within(sheet).getByLabelText("Line 1 debit (KES)"), "100");
    await user.type(within(sheet).getByLabelText("Line 1 credit (KES)"), "100");
    await user.click(within(sheet).getByRole("button", { name: "Post entry" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("at least two lines");
    expect(within(sheet).getByText("Enter a debit or a credit — one, not both.")).toBeInTheDocument();
    expect(posted(server, "/ledger/entries")).toHaveLength(0);
  });

  it("reverses an entry with a reason, and then offers no second reversal", async () => {
    const user = userEvent.setup();
    showAccounting("MSME_OWNER");
    await tab(user, "Journal");
    await user.click(await screen.findByRole("button", { name: "JE-000002 · Sale SALE-20261102-000001" }));
    const sheet = await screen.findByRole("dialog", { name: "Journal entry" });
    await user.click(await within(sheet).findByRole("button", { name: "Reverse entry" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, reverse it" }));
    expect(within(sheet).getByText("Give a reason — it is kept with the reversal.")).toBeInTheDocument();
    expect(posted(server, "/ledger/entries/je-2/reverse")).toHaveLength(0);

    await user.type(within(sheet).getByLabelText("Reason for the reversal"), "Posted twice");
    await user.click(within(sheet).getByRole("button", { name: "Yes, reverse it" }));
    expect(await within(sheet).findByText("Reversed: entry JE-000003 posts the opposite of every line.")).toBeInTheDocument();
    expect(posted(server, "/ledger/entries/je-2/reverse")).toEqual([{ reason: "Posted twice" }]);
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: "Reverse entry" })).not.toBeInTheDocument());
    expect(within(sheet).getByRole("button", { name: "its reversing entry" })).toBeInTheDocument();
    expect(server.entries.at(-1)?.lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
      ["1000", 0n, 116000n],
      ["4000", 116000n, 0n],
    ]);
  });

  it("gives a manager the journal to read but nothing to post", async () => {
    const user = userEvent.setup();
    showAccounting("MSME_MANAGER");
    await tab(user, "Journal");
    await screen.findByRole("list", { name: "Journal entries" });
    expect(screen.queryByRole("button", { name: "Post a journal entry" })).not.toBeInTheDocument();
  });

  it("refuses a backwards date range without asking the server", async () => {
    const user = userEvent.setup();
    showAccounting();
    await tab(user, "Journal");
    await screen.findByRole("list", { name: "Journal entries" });
    await user.type(screen.getByLabelText("From"), "2026-11-05");
    await user.type(screen.getByLabelText("To"), "2026-11-01");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(asked(server, "/ledger/entries").some((q) => q.to === "2026-11-01")).toBe(false);
  });
});

describe("accounting periods", () => {
  it("lets the owner close an open month and reopen a closed one", async () => {
    const user = userEvent.setup();
    showAccounting("MSME_OWNER");
    await tab(user, "Periods");
    const list = await screen.findByRole("list", { name: "Accounting periods" });
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("November 2026");
    await user.click(within(list).getByRole("button", { name: "Close November 2026" }));
    expect(screen.getByRole("alertdialog", { name: "Close November 2026?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, close it" }));
    expect(await screen.findByText("November 2026 is closed.")).toBeInTheDocument();
    expect(posted(server, "/ledger/periods/2026/11/close")).toHaveLength(1);

    await user.click(await screen.findByRole("button", { name: "Reopen October 2026" }));
    await user.click(screen.getByRole("button", { name: "Yes, reopen it" }));
    expect(await screen.findByText("October 2026 is open again.")).toBeInTheDocument();
    expect(posted(server, "/ledger/periods/2026/10/reopen")).toHaveLength(1);
  });

  it("lets the accountant close but not reopen, and shows why a close is refused", async () => {
    server.routes.push((call) => (call.url.pathname.endsWith("/2026/11/close") ? refusal(409, "Cannot close 2026-11: device TILL-1 still holds a live lease and has not synced.") : null));
    const user = userEvent.setup();
    showAccounting("ACCOUNTANT");
    await tab(user, "Periods");
    await screen.findByRole("list", { name: "Accounting periods" });
    expect(screen.queryByRole("button", { name: "Reopen October 2026" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close November 2026" }));
    await user.click(screen.getByRole("button", { name: "Yes, close it" }));
    expect(await screen.findByText(/device TILL-1 still holds a live lease/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Close November 2026?" })).toBeInTheDocument();
  });

  it.each(["MSME_MANAGER", "VIEWER_AUDITOR"] as const)("shows %s the periods with nothing to change", async (role) => {
    const user = userEvent.setup();
    showAccounting(role);
    await tab(user, "Periods");
    const list = await screen.findByRole("list", { name: "Accounting periods" });
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(within(list).getByText("Closed")).toBeInTheDocument();
  });
});

describe("the financial statements", () => {
  it("lays out the income statement with the comparative, and drops it on request", async () => {
    const user = userEvent.setup();
    showAccounting("VIEWER_AUDITOR");
    const doc = await screen.findByRole("region", { name: "Income statement" });
    const table = within(doc).getByRole("table", { name: "Income statement" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers).toHaveLength(3);
    expect(within(table).getByRole("rowheader", { name: "Revenue" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Total revenue/ })).toHaveTextContent("91,200.00");
    expect(within(table).getByRole("row", { name: /Sales Returns/ })).toHaveTextContent("(250.00)");
    expect(within(table).getByRole("row", { name: /Net profit/ })).toHaveTextContent("48,200.00");
    expect(within(table).getByRole("row", { name: /Net profit/ })).toHaveTextContent("(10,800.00)");
    expect(within(doc).getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    expect(asked(server, "/reports/income-statement")[0]).toEqual({});

    await user.click(screen.getByLabelText("Compare with the period before"));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Income statement" })).getAllByRole("columnheader")).toHaveLength(2));
    expect(asked(server, "/reports/income-statement").at(-1)).toEqual({ comparative: "false" });
  });

  it("asks for a chosen month, and refuses a custom range that runs backwards", async () => {
    const user = userEvent.setup();
    showAccounting("ACCOUNTANT");
    await screen.findByRole("region", { name: "Income statement" });
    await user.selectOptions(screen.getByLabelText("Period", { selector: "select" }), "month");
    await user.selectOptions(screen.getByLabelText("Year"), "2026");
    await user.selectOptions(screen.getByLabelText("Month"), "10");
    await waitFor(() => expect(asked(server, "/reports/income-statement").at(-1)).toEqual({ year: "2026", month: "10" }));

    await user.selectOptions(screen.getByLabelText("Period", { selector: "select" }), "custom");
    const before = asked(server, "/reports/income-statement").length;
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    await user.clear(from);
    await user.type(from, "2026-11-08");
    await user.clear(to);
    await user.type(to, "2026-11-02");
    expect(await screen.findByText("The start date is after the end date.")).toBeInTheDocument();
    expect(asked(server, "/reports/income-statement").some((q) => q.from === "2026-11-08" && q.to === "2026-11-02")).toBe(false);
    expect(asked(server, "/reports/income-statement").length).toBeGreaterThanOrEqual(before);
  });

  it("lays out the balance sheet as at a date, balanced, with the month-end before", async () => {
    const user = userEvent.setup();
    showAccounting("MSME_MANAGER");
    await user.selectOptions(await screen.findByLabelText("Report"), "balance");
    const doc = await screen.findByRole("region", { name: "Balance sheet" });
    const table = within(doc).getByRole("table", { name: "Balance sheet" });
    expect(within(table).getByRole("row", { name: /^Total assets/ })).toHaveTextContent("51,160.00");
    expect(within(table).getByRole("row", { name: /Total liabilities and equity/ })).toHaveTextContent("51,160.00");
    expect(within(table).getByRole("row", { name: /Current-year earnings/ })).toHaveTextContent("1,160.00");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    const asOf = screen.getByLabelText("As at", { selector: "input" });
    await user.clear(asOf);
    await user.type(asOf, "2026-11-05");
    await waitFor(() => expect(asked(server, "/reports/balance-sheet").at(-1)).toEqual({ asOf: "2026-11-05" }));
    await user.click(screen.getByLabelText("Compare with the month-end before"));
    await waitFor(() => expect(asked(server, "/reports/balance-sheet").at(-1)).toEqual({ asOf: "2026-11-05", comparative: "false" }));
  });

  it("lays out the trial balance with equal totals, the cash flow, the reconciliation and the top sellers", async () => {
    const user = userEvent.setup();
    showAccounting("MSME_OWNER");
    const report = await screen.findByLabelText("Report");

    await user.selectOptions(report, "trial");
    const trial = await screen.findByRole("table", { name: "Trial balance" });
    const totals = within(trial).getByRole("row", { name: /Totals/ });
    expect(within(totals).getAllByText("51,160.00")).toHaveLength(2);
    expect(within(trial).getAllByRole("columnheader")).toHaveLength(5);

    await user.selectOptions(report, "cash");
    const cash = await screen.findByRole("table", { name: "Cash flow statement" });
    expect(within(cash).getByRole("row", { name: /Cash at the end/ })).toHaveTextContent("51,160.00");

    await user.selectOptions(report, "controls");
    const controls = await screen.findByRole("region", { name: "Control-account reconciliation" });
    expect(within(controls).getByText(/every control reconciles/)).toBeInTheDocument();
    expect(within(controls).getByRole("row", { name: /M-Pesa payments that failed/ })).toHaveTextContent("348.00");
    expect(within(controls).queryByLabelText("Period")).not.toBeInTheDocument();

    await user.selectOptions(report, "top");
    const top = await screen.findByRole("table", { name: "Top-selling products" });
    expect(within(top).getAllByRole("row")[1]).toHaveTextContent("Cement 50kg");
    expect(screen.queryByLabelText("Compare with the period before")).not.toBeInTheDocument();
    expect(asked(server, "/reports/top-products").at(-1)).toEqual({ by: "revenue", limit: "20" });
    await user.selectOptions(screen.getByLabelText("Rank by"), "quantity");
    await waitFor(() => expect(asked(server, "/reports/top-products").at(-1)).toEqual({ by: "quantity", limit: "20" }));
  });

  it("says so when a statement cannot be prepared", async () => {
    server.routes.push((call) => (call.url.pathname === "/api/v1/reports/income-statement" ? refusal(500, "Balance sheet does not balance") : null));
    showAccounting();
    expect(await screen.findByText("Couldn’t prepare the income statement", undefined, { timeout: 5_000 })).toBeInTheDocument();
  });
});
