// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "./support/catalog";
import { posted, refusal } from "./support/money";
import { installPayrollServer, showPayroll, type PayrollServer } from "./support/payroll";

// Payroll (Wave 6 part B): the payslip document an employee is handed (printable), paying a posted
// run's net pay and the per-employee lines it records, the four statutory filing schedules with
// remitting a head (never more than is owed), the remittances list, and the muster roll. Paying and
// remitting are the owner's or a manager's; HR, the accountant and the auditor read.

vi.mock("next/navigation", () => ({ usePathname: () => "/payroll", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: PayrollServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
async function openRun(user: User) {
  await user.click(await screen.findByRole("button", { name: /October 2026 · run 1/ }));
  return screen.findByRole("dialog", { name: "Payroll run" });
}

describe("the run lifecycle to paid", () => {
  it("approves, posts, pays net pay and remits PAYE as the owner", async () => {
    server = installPayrollServer();
    server.seedRun("DRAFT");
    const user = userEvent.setup();
    showPayroll("MSME_OWNER");
    const sheet = await openRun(user);
    // A draft has no money side yet.
    expect(within(sheet).queryByRole("form", { name: "Pay net pay" })).not.toBeInTheDocument();
    await user.click(await within(sheet).findByRole("button", { name: "Approve" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, approve" }));
    await user.click(await within(sheet).findByRole("button", { name: "Post to the books" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, post it" }));

    const pay = await within(sheet).findByRole("form", { name: "Pay net pay" });
    expect(pay).toHaveTextContent("Pay net pay — KES 96,635.40");
    await user.selectOptions(within(pay).getByLabelText("Paid from"), "MPESA");
    await user.clear(within(pay).getByLabelText("Payment date"));
    await user.type(within(pay).getByLabelText("Payment date"), "2026-10-28");
    await user.click(within(pay).getByRole("button", { name: "Pay net pay" }));
    await user.click(within(pay).getByRole("button", { name: "Yes, record the payment" }));
    const net = await within(sheet).findByRole("region", { name: "Net pay settlement" });
    expect(posted(server, "/payroll/runs/run-1/settle-net")).toEqual([{ paymentDate: "2026-10-28", method: "MPESA" }]);
    expect(net).toHaveTextContent("KES 96,635.40 on 28 Oct 2026 from m-pesa till (account 1010)");
    expect(within(net).getByRole("row", { name: /Wanjiku Mwangi/ })).toHaveTextContent("Bank transferKCB · 110022334470,441.65");
    expect(within(net).getByRole("row", { name: /Otieno Kamau/ })).toHaveTextContent("M-Pesa0712345678");
    expect(within(sheet).getByText("Paid")).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Statutory schedules & remittances" }));
    const paye = await within(sheet).findByRole("region", { name: /^PAYE/ });
    expect(paye).toHaveTextContent("Due KES 20,039.60 · remitted KES 0.00 · outstanding KES 20,039.60");
    await user.click(within(paye).getByRole("button", { name: "Remit PAYE" }));
    const remit = within(paye).getByRole("form", { name: "Remit PAYE" });
    const amount = within(remit).getByLabelText("Amount (KES)");
    expect(amount).toHaveValue("20039.60");
    await user.clear(amount);
    await user.type(amount, "25,000");
    await user.click(within(remit).getByRole("button", { name: "Record the PAYE payment" }));
    expect(within(remit).getByText(/more than is owed for this run \(KES 20,039.60\)/)).toBeInTheDocument();
    await user.clear(amount);
    await user.type(amount, "20,039.60");
    await user.type(within(remit).getByLabelText(/Authority’s reference/), "PRN-2026-10");
    await user.click(within(remit).getByRole("button", { name: "Record the PAYE payment" }));
    expect(await within(paye).findByText("PAYE of KES 20,039.60 remitted to KRA.")).toBeInTheDocument();
    expect(posted(server, "/payroll/remittances")).toEqual([
      { statutoryType: "PAYE", amount: "20039.60", remittanceDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown as string, method: "BANK", payrollRunId: "run-1", reference: "PRN-2026-10" },
    ]);
    await waitFor(() => expect(within(sheet).getByRole("region", { name: /^PAYE/ })).toHaveTextContent("outstanding KES 0.00"));
    expect(within(sheet).queryByRole("button", { name: "Remit PAYE" })).not.toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("tab", { name: "Remittances" }));
    await user.click(await screen.findByRole("button", { name: /PAYE to KRA/ }));
    const detail = await screen.findByRole("dialog", { name: "Statutory remittance" });
    expect(await within(detail).findByText("Dr 2200 / Cr 1020")).toBeInTheDocument();
    expect(within(detail).getByText("PRN-2026-10")).toBeInTheDocument();
  });

  it("shows the server's refusal when a remittance exceeds what is owed, keeping the form", async () => {
    server = installPayrollServer();
    server.seedRun("POSTED");
    server.routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/payroll/remittances" ? refusal(400, "Remitting would exceed the head's current GL credit balance of 0 cents.") : null));
    const user = userEvent.setup();
    showPayroll("MSME_MANAGER");
    const sheet = await openRun(user);
    await user.click(await within(sheet).findByRole("button", { name: "Statutory schedules & remittances" }));
    const nssf = await within(sheet).findByRole("region", { name: /^NSSF/ });
    await user.click(within(nssf).getByRole("button", { name: "Remit NSSF" }));
    await user.click(within(nssf).getByRole("button", { name: "Record the NSSF payment" }));
    expect(await within(nssf).findByRole("alert")).toHaveTextContent("would exceed the head's current GL credit balance");
    expect(within(nssf).getByLabelText("Amount (KES)")).toHaveValue("15600.00");
  });
});

describe("documents", () => {
  it("opens a payslip as a printable document with the full breakdown", async () => {
    server = installPayrollServer();
    server.seedRun("POSTED");
    const user = userEvent.setup();
    showPayroll("ACCOUNTANT");
    const sheet = await openRun(user);
    await user.click(await within(sheet).findByRole("button", { name: "Wanjiku Mwangi" }));
    const doc = await within(sheet).findByRole("region", { name: "Payslip" });
    expect(doc).toHaveTextContent("Nakuru Hardware · October 2026 · pay date 28 Oct 2026");
    const earnings = within(doc).getByRole("table", { name: "Earnings" });
    expect(within(earnings).getByRole("row", { name: /House/ })).toHaveTextContent("20,000.00");
    expect(within(earnings).getByRole("row", { name: /Gross pay/ })).toHaveTextContent("100,000.00");
    const tax = within(doc).getByRole("table", { name: "How PAYE was worked out" });
    expect(within(tax).getByRole("row", { name: /Taxable pay/ })).toHaveTextContent("89,750.00");
    expect(within(tax).getByRole("row", { name: /Tax on taxable pay/ })).toHaveTextContent("21,708.35");
    expect(within(tax).getByRole("row", { name: /^PAYE/ })).toHaveTextContent("19,308.35");
    expect(within(doc).getByRole("table", { name: "Deductions" })).toHaveTextContent("Total deductions29,558.35");
    expect(doc).toHaveTextContent("Net payKES 70,441.65");
    expect(doc).toHaveTextContent("Not yet paid");
    expect(doc).toHaveClass("print-area", "print-document");
    expect(within(doc).getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Back to the run" }));
    expect(await within(sheet).findByRole("table", { name: /Payslips of run 1/ })).toBeInTheDocument();
  });

  it("prints the muster roll with totals that reconcile", async () => {
    server = installPayrollServer();
    server.seedRun("DRAFT");
    const user = userEvent.setup();
    showPayroll("HR_OFFICER");
    const sheet = await openRun(user);
    await user.click(await within(sheet).findByRole("button", { name: "Muster roll" }));
    const muster = await within(sheet).findByRole("region", { name: "Muster roll" });
    expect(muster).toHaveTextContent("October 2026 · run 1 · 2 employees");
    const totals = within(muster).getByRole("row", { name: /Totals/ });
    expect(within(totals).getAllByRole("cell").map((c) => c.textContent)).toEqual(["130,000.00", "7,800.00", "3,575.00", "1,950.00", "20,039.60", "33,364.60", "96,635.40", "7,800.00", "1,950.00"]);
    expect(muster).toHaveTextContent("Every row adds up");
    expect(muster).toHaveClass("print-document");
  });
});

describe("who may pay and remit", () => {
  it("lets HR and the accountant read a posted run's schedules but not pay or remit, and flags missing identifiers", async () => {
    for (const role of ["HR_OFFICER", "ACCOUNTANT", "VIEWER_AUDITOR"] as const) {
      server = installPayrollServer();
      server.seedRun("POSTED");
      const user = userEvent.setup();
      showPayroll(role);
      const sheet = await openRun(user);
      expect(await within(sheet).findByText(/The owner or a manager records paying it/)).toBeInTheDocument();
      expect(within(sheet).queryByRole("form", { name: "Pay net pay" })).not.toBeInTheDocument();
      await user.click(within(sheet).getByRole("button", { name: "Statutory schedules & remittances" }));
      const paye = await within(sheet).findByRole("region", { name: /^PAYE/ });
      expect(within(sheet).queryByRole("button", { name: /^Remit / })).not.toBeInTheDocument();
      expect(paye).toHaveTextContent("Not ready to file — missing: Otieno Kamau’s KRA PIN");
      expect(within(sheet).getByRole("region", { name: "Statutory schedules" })).toHaveTextContent("Not yet ready to file");
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(posted(server, "/payroll/remittances")).toEqual([]);
  });
});
