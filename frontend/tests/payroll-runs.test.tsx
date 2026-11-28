// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "./support/catalog";
import { posted, refusal } from "./support/money";
import { installPayrollServer, showPayroll, type PayrollServer } from "./support/payroll";

// Payroll (Wave 6 part A): the employee master (add, edit terms, suspend / terminate / reinstate,
// HR only), and the monthly run — a DRAFT computed by the server against the statutory schedule in
// force, recomputed, approved and posted by the owner or a manager, or cancelled before posting.
// The accountant and auditor read; HR builds but cannot approve or post. Money goes up as shillings.

vi.mock("next/navigation", () => ({ usePathname: () => "/payroll", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: PayrollServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
const tab = async (user: User, name: string) => user.click(await screen.findByRole("tab", { name }));
const thisMonth = () => {
  const now = new Date();
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
};

async function newDraft(user: User) {
  await user.click(await screen.findByRole("button", { name: "New run" }));
  const form = screen.getByRole("form", { name: "New payroll run" });
  await user.click(within(form).getByRole("button", { name: "Compute the draft run" }));
  return screen.findByRole("dialog", { name: "Payroll run" });
}

describe("employees", () => {
  it("lists the employees and adds one with allowances, sending shillings", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("HR_OFFICER");
    await tab(user, "Employees");
    const list = await screen.findByRole("list", { name: "Employees" });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(within(list).getByRole("button", { name: /Wanjiku Mwangi/ })).toHaveTextContent("Permanent · Bank transfer · KES 100,000.00 a month");
    expect(screen.getByText(/2 people · gross monthly KES 130,000.00/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Add employee" }));
    const form = screen.getByRole("form", { name: "New employee" });
    await user.click(within(form).getByRole("button", { name: "Add employee" }));
    expect(within(form).getByText("Enter the first name.")).toBeInTheDocument();
    expect(posted(server, "/payroll/employees")).toEqual([]);

    await user.type(within(form).getByLabelText("First name"), "Akinyi");
    await user.type(within(form).getByLabelText("Last name"), "Odhiambo");
    await user.type(within(form).getByLabelText(/KRA PIN/), "a987654321b");
    await user.type(within(form).getByLabelText("Basic pay (KES / month)"), "45,000");
    await user.click(within(form).getByRole("button", { name: "Add an allowance" }));
    await user.type(within(form).getByLabelText("Allowance 1 name"), "Transport");
    await user.type(within(form).getByLabelText("Amount (KES)"), "5000");
    await user.click(within(form).getByLabelText("Taxable"));
    await user.selectOptions(within(form).getByLabelText("Payment method"), "MPESA");
    await user.type(within(form).getByLabelText("M-Pesa number"), "0711 222 333");
    await user.click(within(form).getByRole("button", { name: "Add employee" }));
    expect(await screen.findByText(/Akinyi Odhiambo is employee 3/)).toBeInTheDocument();
    expect(posted(server, "/payroll/employees")).toEqual([
      {
        firstName: "Akinyi",
        lastName: "Odhiambo",
        kraPin: "A987654321B",
        employmentType: "PERMANENT",
        hireDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown as string,
        basicSalary: "45000.00",
        paymentMethod: "MPESA",
        bankAccount: "0711222333",
        allowances: [{ name: "Transport", amount: "5000.00", taxable: false }],
      },
    ]);
  });

  it("edits standing terms and changes status with a confirmation; a termination needs its date", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("MSME_MANAGER");
    await tab(user, "Employees");
    await user.click(await screen.findByRole("button", { name: /Otieno Kamau/ }));
    const sheet = await screen.findByRole("dialog", { name: "Employee" });
    expect(await within(sheet).findAllByText("KES 30,000.00", { selector: "dd" })).toHaveLength(2);

    await user.click(within(sheet).getByRole("button", { name: "Edit terms" }));
    const basic = within(sheet).getByLabelText("Basic pay (KES / month)");
    expect(basic).toHaveValue("30000.00");
    await user.clear(basic);
    await user.type(basic, "32500.50");
    await user.click(within(sheet).getByRole("button", { name: "Save terms" }));
    expect(await within(sheet).findByText(/new terms apply from the next run/)).toBeInTheDocument();
    expect(posted(server, "/payroll/employees/e-2", "PATCH").at(-1)).toMatchObject({ basicSalary: "32500.50", paymentMethod: "MPESA", bankName: null, bankAccount: "0712345678", allowances: [], kraPin: null });

    await user.click(within(sheet).getByRole("button", { name: "Terminate" }));
    const ask = within(sheet).getByRole("alertdialog", { name: "Terminate Otieno Kamau?" });
    await user.clear(within(ask).getByLabelText("Last day"));
    await user.click(within(ask).getByRole("button", { name: "Yes, terminate" }));
    expect(within(ask).getByText("Enter their last day.")).toBeInTheDocument();
    await user.type(within(ask).getByLabelText("Last day"), "2026-11-30");
    await user.click(within(ask).getByRole("button", { name: "Yes, terminate" }));
    expect(await within(sheet).findByText("Otieno Kamau is terminated as of 30 Nov 2026.")).toBeInTheDocument();
    expect(posted(server, "/payroll/employees/e-2/status", "PATCH")).toEqual([{ status: "TERMINATED", terminationDate: "2026-11-30" }]);
    // Termination is final: no Reinstate, and the way back is a new employee record.
    expect(await within(sheet).findByText(/Termination is final. To take Otieno Kamau back on, add them as a new employee./)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Reinstate" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Terminate" })).not.toBeInTheDocument();
  });

  it("gives the accountant and the auditor the records without any action", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("VIEWER_AUDITOR");
    await tab(user, "Employees");
    expect(screen.queryByRole("button", { name: "Add employee" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Wanjiku Mwangi/ }));
    const sheet = await screen.findByRole("dialog", { name: "Employee" });
    expect(await within(sheet).findByText("A012345678Z")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Edit terms" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Terminate" })).not.toBeInTheDocument();
    expect(within(sheet).getByText(/HR keeps the employee records/)).toBeInTheDocument();
  });
});

describe("payroll runs", () => {
  it("computes a draft with the server's statutory deductions and recomputes it", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("HR_OFFICER");
    expect(await screen.findByText("No payroll runs yet")).toBeInTheDocument();
    const sheet = await newDraft(user);
    const { year, month } = thisMonth();
    expect(posted(server, "/payroll/runs")).toEqual([{ periodYear: year, periodMonth: month, payDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown as string }]);
    const table = await within(sheet).findByRole("table");
    const wanjiku = within(table).getByRole("row", { name: /Wanjiku Mwangi/ });
    // KE-2026-02's worked example, exactly as the server computed it.
    expect(within(wanjiku).getAllByRole("cell").map((c) => c.textContent)).toEqual(["100,000.00", "19,308.35", "6,000.00", "2,750.00", "1,500.00", "29,558.35", "70,441.65"]);
    expect(within(table).getByRole("row", { name: /2 employees/ })).toHaveTextContent("96,635.40");
    expect(within(sheet).getByText(/rates KE-2026-02/)).toBeInTheDocument();
    // HR computes; it does not approve.
    expect(within(sheet).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(within(sheet).getByText("The owner or a manager approves and posts the run.")).toBeInTheDocument();

    await user.click(within(sheet).getByRole("button", { name: "Recompute" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, recompute" }));
    expect(await within(sheet).findByText(/Recomputed: 2 payslips, net pay KES 96,635.40/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it("refuses a second run for the month in the server's words, keeping the form", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("MSME_OWNER");
    await newDraft(user);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: "New run" }));
    const form = screen.getByRole("form", { name: "New payroll run" });
    await user.type(within(form).getByLabelText(/Notes/), "second try");
    await user.click(within(form).getByRole("button", { name: "Compute the draft run" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("already exists");
    expect(within(form).getByLabelText(/Notes/)).toHaveValue("second try");
  });

  it("approves and posts as the owner, each step only when the status allows", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("MSME_OWNER");
    const sheet = await newDraft(user);
    expect(await within(sheet).findByText("Draft")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Post to the books" })).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Approve" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, approve" }));
    expect(await within(sheet).findByText(/is approved. Post it to book the payroll/)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Recompute" })).not.toBeInTheDocument();

    // A closed period is the server's to refuse; the run stays approved and the step can be retried.
    server.routes.push((call) => (call.url.pathname.endsWith("/post") && server.calls.filter((c) => c.url.pathname.endsWith("/post")).length === 1 ? refusal(409, "Period 2026-11 is closed; the accrual cannot be posted into it.") : null));
    await user.click(within(sheet).getByRole("button", { name: "Post to the books" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, post it" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Period 2026-11 is closed");
    await user.click(within(sheet).getByRole("button", { name: "Yes, post it" }));
    expect(await within(sheet).findByText(/is posted. Net pay KES 96,635.40 is now owed to staff/)).toBeInTheDocument();
    expect(within(sheet).getByText("Posted — net pay owed")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
    expect(server.runs[0]?.status).toBe("POSTED");
  });

  it("cancels an unposted run with a reason", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("MSME_MANAGER");
    const sheet = await newDraft(user);
    await user.click(await within(sheet).findByRole("button", { name: "Cancel run" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, cancel the run" }));
    expect(within(sheet).getByText(/Say why it is cancelled/)).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Why it is cancelled"), "Wrong pay date");
    await user.click(within(sheet).getByRole("button", { name: "Yes, cancel the run" }));
    expect(await within(sheet).findByText(/is cancelled\./)).toBeInTheDocument();
    expect(posted(server, "/payroll/runs/run-1/cancel")).toEqual([{ reason: "Wrong pay date" }]);
  });

  it("lets the accountant read runs and payslips but act on none", async () => {
    server = installPayrollServer();
    server.runs.push({ id: "run-9", runNumber: 9, periodYear: 2026, periodMonth: 10, status: "DRAFT", payDate: "2026-10-28", notes: null, payslips: [] });
    const user = userEvent.setup();
    showPayroll("ACCOUNTANT");
    expect(screen.queryByRole("button", { name: "New run" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /October 2026 · run 9 · Draft/ }));
    const sheet = await screen.findByRole("dialog", { name: "Payroll run" });
    await waitFor(() => expect(within(sheet).getByText(/HR prepares the run/)).toBeInTheDocument());
    for (const action of ["Recompute", "Approve", "Post to the books", "Cancel run"]) expect(within(sheet).queryByRole("button", { name: action })).not.toBeInTheDocument();
    // Reading the documents is open to every read role.
    expect(within(sheet).getByRole("button", { name: "Muster roll" })).toBeInTheDocument();
  });
});

describe("suspension", () => {
  it("suspends and reinstates, which termination does not allow", async () => {
    server = installPayrollServer();
    const user = userEvent.setup();
    showPayroll("HR_OFFICER");
    await user.click(await screen.findByRole("tab", { name: "Employees" }));
    await user.click(await screen.findByRole("button", { name: /Wanjiku Mwangi/ }));
    const sheet = await screen.findByRole("dialog", { name: "Employee" });
    await user.click(await within(sheet).findByRole("button", { name: "Suspend" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, suspend" }));
    expect(await within(sheet).findByText(/is suspended and left out of new runs/)).toBeInTheDocument();
    await user.click(await within(sheet).findByRole("button", { name: "Reinstate" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, reinstate" }));
    expect(await within(sheet).findByText(/is active again/)).toBeInTheDocument();
    expect(posted(server, "/payroll/employees/e-1/status", "PATCH")).toEqual([{ status: "SUSPENDED" }, { status: "ACTIVE" }]);
  });
});
