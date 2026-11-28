// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/landing";
import { axeViolations } from "./support/catalog";
import { chooseLocation, installPosFetch, installStk, json, receipt, refusal, showTill, TILL, type Call, type Route } from "./support/pos";

// The till, Wave 1b-ii part 2: split tenders mixing M-Pesa with cash and credit, the cart locked
// while payment is taken (and never discarded over M-Pesa money received), the large total the
// customer reads, and the manager's void. The BFF is stubbed at fetch.

vi.mock("next/navigation", () => ({ usePathname: () => "/pos", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];
let stk: ReturnType<typeof installStk>;

const SALE_9 = { id: "sale-9", saleNumber: "SALE-20261105-000009", status: "COMPLETED", total: "84500", voidReason: null, fiscalStatus: "NOT_REQUESTED" };
let sale9: Record<string, unknown>;

beforeEach(() => {
  chooseLocation(TILL.id);
  ({ calls, routes } = installPosFetch());
  stk = installStk(routes);
  sale9 = { ...SALE_9 };
  routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales" ? json(201, { id: "sale-9" }) : null));
  routes.push((call) => (call.url.pathname === "/api/v1/pos/sales/sale-9/receipt" ? json(200, receipt({ status: sale9.status as "COMPLETED" | "VOIDED" })) : null));
  routes.push((call) => (call.method === "GET" && call.url.pathname === "/api/v1/pos/sales/sale-9" ? json(200, sale9) : null));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chooseLocation(null);
});

type SaleSent = { customerId?: string; sellingLocationId: string; tenders: Array<Record<string, string>> };
const saleSent = () => calls.filter((call) => call.method === "POST" && call.url.pathname === "/api/v1/pos/sales").at(-1)?.body as SaleSent | undefined;
const voidsSent = () => calls.filter((call) => call.method === "POST" && /\/void$/.test(call.url.pathname));

async function addToCart(user: ReturnType<typeof userEvent.setup>, query: string, name: RegExp) {
  await user.type(await screen.findByLabelText("Scan or search products"), query);
  await user.click(await screen.findByRole("button", { name }));
}

async function toPayment(user: ReturnType<typeof userEvent.setup>) {
  const pay = await screen.findByRole("button", { name: /^Take payment · KES/ });
  await waitFor(() => expect(pay).toBeEnabled());
  await user.click(pay);
  return screen.findByRole("region", { name: "Take payment" });
}

async function setAmount(user: ReturnType<typeof userEvent.setup>, field: HTMLElement, value: string) {
  await user.clear(field);
  await user.type(field, value);
}

async function confirmStk(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, id: string) {
  await user.type(within(panel).getByLabelText("Customer phone"), "0712345678");
  await user.click(within(panel).getByRole("button", { name: "Prompt customer (STK)" }));
  await within(panel).findByText(/Waiting for the customer/);
  await stk.deliver(id, "success");
  await user.click(within(panel).getByRole("button", { name: "Check now" }));
  await within(panel).findByText(/M-Pesa confirmed/);
}

async function chooseKiptoo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Add customer/ }));
  const sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
  await user.click(within(sheet).getByRole("button", { name: /Kiptoo Hardware/ }));
}

describe("split tenders including M-Pesa", () => {
  it("500 cash + 300 M-Pesa (STK) + 200 credit adds up to the 1,000.00 total and posts as three tenders", async () => {
    const user = userEvent.setup();
    showTill();
    await addToCart(user, "Bamburi", /Bamburi Cement 50kg/);
    await addToCart(user, "Wire", /Wire Nails 4in/);
    const [cementDiscount] = screen.getAllByLabelText("Discount (KES)");
    if (!cementDiscount) throw new Error("no discount field");
    await user.type(cementDiscount, "65"); // 845.00 − 65.00 + 220.00 = 1,000.00
    await chooseKiptoo(user);
    const panel = await toPayment(user);
    const display = screen.getByRole("region", { name: "Customer total" });
    expect(display).toHaveTextContent("KES 1,000.00");

    await setAmount(user, within(panel).getByLabelText("Cash amount (KES)"), "500");
    expect(within(display).getByText("Still to pay KES 500.00")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Add M-Pesa" }));
    await setAmount(user, within(panel).getByLabelText("M-Pesa amount (KES)"), "300");
    await confirmStk(user, panel, "ws_CO_1");
    expect(within(display).getByText("Still to pay KES 200.00")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Charge KES 1,000.00" })).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Add credit" }));
    expect(within(display).getByText("Paid in full")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Charge KES 1,000.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()).toMatchObject({
      customerId: "c-1",
      sellingLocationId: TILL.id,
      tenders: [
        { tenderType: "CASH", amount: "500.00" },
        { tenderType: "MPESA", amount: "300.00", mpesaChannel: "STK", mpesaCheckoutRequestId: "ws_CO_1" },
        { tenderType: "CREDIT", amount: "200.00" },
      ],
    });
    // Money crosses the wire in shillings on every request the till made.
    expect(calls.filter((call) => call.url.pathname === "/api/v1/pos/mpesa/stk-push").map((call) => call.body)).toEqual([{ phoneNumber: "254712345678", amount: "300.00" }]);
  });

  it("cash + manual M-Pesa (Till): an over-tendered split cannot be charged", async () => {
    const user = userEvent.setup();
    showTill();
    await addToCart(user, "Bamburi", /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await setAmount(user, within(panel).getByLabelText("Cash amount (KES)"), "500");
    await user.click(within(panel).getByRole("button", { name: "Add M-Pesa" }));
    await user.click(within(panel).getByRole("button", { name: "Enter the M-Pesa code instead" }));
    await user.type(within(panel).getByLabelText("M-Pesa code"), "RKT4XY78ZQ");
    await setAmount(user, within(panel).getByLabelText("M-Pesa amount (KES)"), "400");
    expect(within(panel).getByText("Over by")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Customer total" })).getByText("Over by KES 55.00")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();
    await setAmount(user, within(panel).getByLabelText("M-Pesa amount (KES)"), "345");
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()?.tenders).toEqual([
      { tenderType: "CASH", amount: "500.00" },
      { tenderType: "MPESA", amount: "345.00", mpesaChannel: "TILL", mpesaReference: "RKT4XY78ZQ" },
    ]);
  });
});

describe("the cart is locked while payment is taken", () => {
  it("a confirmed M-Pesa payment blocks discarding the payments — and closing the shift", async () => {
    const user = userEvent.setup();
    showTill();
    await addToCart(user, "Bamburi", /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Remove cash payment" }));
    await user.click(within(panel).getByRole("button", { name: "Add M-Pesa" }));
    await confirmStk(user, panel, "ws_CO_1");
    await user.click(within(panel).getByRole("button", { name: "Back to the cart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("KES 845.00 has been received by M-Pesa for this basket, so the cart cannot change now.");
    expect(screen.queryByRole("button", { name: "Clear payments and edit the cart" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Cart" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close shift" })).toBeDisabled();
    // The sale completes with the money received.
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
  });

  it("a prompt the customer is still answering blocks it too", async () => {
    const user = userEvent.setup();
    showTill();
    await addToCart(user, "Bamburi", /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Remove cash payment" }));
    await user.click(within(panel).getByRole("button", { name: "Add M-Pesa" }));
    await user.type(within(panel).getByLabelText("Customer phone"), "0712345678");
    await user.click(within(panel).getByRole("button", { name: "Prompt customer (STK)" }));
    await within(panel).findByText(/Waiting for the customer/);
    await user.click(within(panel).getByRole("button", { name: "Back to the cart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The customer is still answering an M-Pesa prompt");
  });

  it("without M-Pesa money, editing the cart asks first, then clears the payments", async () => {
    const user = userEvent.setup();
    showTill();
    await addToCart(user, "Bamburi", /Bamburi Cement 50kg/);
    let panel = await toPayment(user);
    await user.type(within(panel).getByLabelText("Cash received (KES)"), "1000");
    await user.click(within(panel).getByRole("button", { name: "Back to the cart" }));
    const ask = await screen.findByRole("alertdialog", { name: "Edit the cart?" });
    expect(within(ask).getByRole("button", { name: "Stay on payment" })).toHaveFocus();
    await user.click(within(ask).getByRole("button", { name: "Stay on payment" }));
    expect(within(panel).getByLabelText("Cash received (KES)")).toHaveValue("1000");

    await user.click(within(panel).getByRole("button", { name: "Back to the cart" }));
    await user.click(await screen.findByRole("button", { name: "Clear payments and edit the cart" }));
    expect(await screen.findByRole("list", { name: "Cart" })).toBeInTheDocument();
    panel = await toPayment(user);
    expect(within(panel).getByLabelText("Cash received (KES)")).toHaveValue("");
  });
});

describe("the customer-facing total", () => {
  it("shows the quote's total large while selling, and what is still to pay while paying", async () => {
    const user = userEvent.setup();
    showTill();
    expect(screen.queryByRole("region", { name: "Customer total" })).not.toBeInTheDocument();
    await addToCart(user, "Bamburi", /Bamburi Cement 50kg/);
    const display = await screen.findByRole("region", { name: "Customer total" });
    await waitFor(() => expect(display).toHaveTextContent("KES 845.00"));
    const panel = await toPayment(user);
    expect(within(display).getByText("Paid in full")).toBeInTheDocument();
    await setAmount(user, within(panel).getByLabelText("Cash amount (KES)"), "45");
    expect(within(display).getByText("Still to pay KES 800.00")).toBeInTheDocument();
  });
});

async function sellThenComplete(role: Role) {
  const user = userEvent.setup();
  showTill(role);
  await addToCart(user, "Bamburi", /Bamburi Cement 50kg/);
  const panel = await toPayment(user);
  await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
  await screen.findByText("Sale complete");
  return user;
}

describe("void — a manager's or owner's decision", () => {
  beforeEach(() => {
    routes.unshift((call) => {
      if (call.method !== "POST" || call.url.pathname !== "/api/v1/pos/sales/sale-9/void") return null;
      const reason = (call.body as { reason: string }).reason;
      sale9 = { ...sale9, status: "VOIDED", voidReason: reason };
      return json(200, { ...sale9, creditNote: sale9.fiscalStatus === "SIGNED" ? { invoiceId: "inv-1", etimsInvoiceNumber: 17 } : null });
    });
  });

  it("a manager voids with a reason, after confirming; the voided status and reason show", async () => {
    const user = await sellThenComplete("MSME_MANAGER");
    await user.click(await screen.findByRole("button", { name: "Void sale" }));
    await user.click(screen.getByRole("button", { name: "Review the void" }));
    expect(screen.getByText("Give a reason — it is kept with the sale.")).toBeInTheDocument();
    expect(voidsSent()).toHaveLength(0);
    await user.type(screen.getByLabelText("Reason for the void"), "Customer changed their mind");
    await user.click(screen.getByRole("button", { name: "Review the void" }));
    const ask = screen.getByRole("alertdialog", { name: "Void SALE-20261105-000009 for KES 845.00?" });
    expect(within(ask).getByRole("button", { name: "Back" })).toHaveFocus();
    expect(await axeViolations()).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Yes, void the sale" }));
    expect(await screen.findByText("This sale is voided. Reason: Customer changed their mind")).toBeInTheDocument();
    expect(voidsSent().map((call) => call.body)).toEqual([{ reason: "Customer changed their mind" }]);
    expect(await within(screen.getByRole("article", { name: "Receipt" })).findByText("VOIDED")).toBeInTheDocument();
  });

  it("voiding a sale KRA signed says a credit note is owed", async () => {
    sale9 = { ...SALE_9, fiscalStatus: "SIGNED" };
    const user = await sellThenComplete("MSME_OWNER");
    await user.click(await screen.findByRole("button", { name: "Void sale" }));
    await user.type(screen.getByLabelText("Reason for the void"), "Wrong item rung");
    await user.click(screen.getByRole("button", { name: "Review the void" }));
    await user.click(screen.getByRole("button", { name: "Yes, void the sale" }));
    expect(await screen.findByText(/a credit note \(eTIMS no. 17\) is owed to KRA/)).toBeInTheDocument();
  });

  it("a cashier sees the void disabled: a manager must authorise it", async () => {
    await sellThenComplete("CASHIER");
    const button = await screen.findByRole("button", { name: "Void sale" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("A manager must authorise a void.");
    expect(voidsSent()).toHaveLength(0);
  });

  it("a refusal is shown and the reason kept, to try again", async () => {
    routes.unshift((call) =>
      call.method === "POST" && call.url.pathname === "/api/v1/pos/sales/sale-9/void" ? refusal(400, "This cash sale's shift has closed; open a shift to pay the refund from.") : null,
    );
    const user = await sellThenComplete("MSME_MANAGER");
    await user.click(await screen.findByRole("button", { name: "Void sale" }));
    await user.type(screen.getByLabelText("Reason for the void"), "Returned");
    await user.click(screen.getByRole("button", { name: "Review the void" }));
    await user.click(screen.getByRole("button", { name: "Yes, void the sale" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This cash sale's shift has closed; open a shift to pay the refund from.");
    expect(screen.getByLabelText("Reason for the void")).toHaveValue("Returned");
  });

  it("from the shift's sales: open a sale, reprint, and void it", async () => {
    routes.unshift((call) =>
      call.method === "GET" && call.url.pathname === "/api/v1/pos/sales" && call.url.searchParams.get("shiftId") === "shift-1"
        ? json(200, {
            data: [
              { ...sale9, createdAt: "2026-11-05T07:15:00.000Z" },
              { id: "sale-8", saleNumber: "SALE-20261105-000008", status: "VOIDED", total: "22000", voidReason: "Mistake", createdAt: "2026-11-05T07:00:00.000Z" },
            ],
            pagination: { take: 20, skip: 0, total: 2 },
          })
        : null,
    );
    const user = userEvent.setup();
    showTill("MSME_OWNER");
    await user.click(await screen.findByRole("button", { name: "Sales this shift" }));
    const sheet = await screen.findByRole("dialog", { name: "Sales this shift" });
    const list = await within(sheet).findByRole("list", { name: "Sales" });
    expect(within(list).getByText("Voided")).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /SALE-20261105-000009/ }));
    const detail = await screen.findByRole("dialog", { name: "SALE-20261105-000009" });
    expect(await within(detail).findByRole("article", { name: "Receipt" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Print receipt" })).toBeInTheDocument();
    await user.click(within(detail).getByRole("button", { name: "Void sale" }));
    await user.type(within(detail).getByLabelText("Reason for the void"), "Duplicate");
    await user.click(within(detail).getByRole("button", { name: "Review the void" }));
    await user.click(within(detail).getByRole("button", { name: "Yes, void the sale" }));
    expect(await within(detail).findByText("This sale is voided. Reason: Duplicate")).toBeInTheDocument();
  });
});
