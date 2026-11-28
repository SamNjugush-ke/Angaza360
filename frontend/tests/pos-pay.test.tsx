// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceiptSlip } from "@/components/pos/receipt-view";
import { describeVariance } from "@/components/pos/close-shift";
import { evaluateTenders, newTender, tendersToBody } from "@/lib/pos/tender";
import { axeViolations } from "./support/catalog";
import { CEMENT, chooseLocation, customer, CUSTOMERS, installPosFetch, json, NAILS, quoteFor, receipt, refusal, shift, showTill, TILL, type Call, type Route } from "./support/pos";

// The till, Wave 1b-i part 2: taking payment against the quote's total (cash with change, bank
// transfer, credit to a customer, splits), the receipt and its print, and closing the shift with
// the server's expected cash and variance. The BFF is stubbed at fetch.

vi.mock("next/navigation", () => ({ usePathname: () => "/pos", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];

beforeEach(() => {
  chooseLocation(TILL.id);
  ({ calls, routes } = installPosFetch());
  routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales" ? json(201, { id: "sale-9" }) : null));
  routes.push((call) => (call.url.pathname === "/api/v1/pos/sales/sale-9/receipt" ? json(200, receipt()) : null));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chooseLocation(null);
});

type SaleSent = { shiftId: string; sellingLocationId: string; customerId?: string; lines: unknown[]; tenders: Array<Record<string, string>> };
const saleSent = () => calls.filter((call) => call.method === "POST" && call.url.pathname === "/api/v1/pos/sales").at(-1)?.body as SaleSent | undefined;

async function cartOf(user: ReturnType<typeof userEvent.setup>, ...names: RegExp[]) {
  for (const name of names) {
    await user.type(await screen.findByLabelText("Scan or search products"), name.source.split(" ")[0] ?? "");
    await user.click(await screen.findByRole("button", { name }));
  }
}

async function toPayment(user: ReturnType<typeof userEvent.setup>) {
  const pay = await screen.findByRole("button", { name: /^Take payment · KES/ });
  await waitFor(() => expect(pay).toBeEnabled());
  await user.click(pay);
  return screen.findByRole("region", { name: "Take payment" });
}

describe("taking payment", () => {
  it("cash, multi-line with a discount: the change is shown, cashReceived and the location go with the sale, and the receipt follows", async () => {
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/, /Wire Nails 4in/);
    const [cementDiscount] = screen.getAllByLabelText("Discount (KES)");
    if (!cementDiscount) throw new Error("no discount field");
    await user.type(cementDiscount, "45");
    // 845.00 − 45.00 + 220.00 = 1,020.00
    const panel = await toPayment(user);
    expect(within(panel).getByRole("button", { name: "Charge KES 1,020.00" })).toBeEnabled();
    await user.type(within(panel).getByLabelText("Cash received (KES)"), "1,500");
    expect(within(panel).getByText("Change to give").nextSibling).toHaveTextContent("KES 480.00");
    await user.click(within(panel).getByRole("button", { name: "Charge KES 1,020.00" }));

    expect(await screen.findByText("Sale complete")).toBeInTheDocument();
    expect(saleSent()).toEqual({
      shiftId: "shift-1",
      sellingLocationId: TILL.id,
      lines: [
        { productId: CEMENT.id, quantity: "1", discount: "45.00" },
        { productId: NAILS.id, quantity: "1" },
      ],
      tenders: [{ tenderType: "CASH", amount: "1020.00", cashReceived: "1500.00" }],
    });
    expect(await screen.findByRole("article", { name: "Receipt" })).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it("charge stays disabled until the tenders add up to the total, to the cent", async () => {
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    const amount = within(panel).getByLabelText("Cash amount (KES)");
    await user.clear(amount);
    await user.type(amount, "800");
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();
    expect(within(panel).getByText("Outstanding").nextSibling).toHaveTextContent("KES 45.00");
    await user.click(within(panel).getByRole("button", { name: "Pay the rest" }));
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeEnabled();
  });

  it("bank transfer: one tender for the whole total", async () => {
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Remove cash payment" }));
    await user.click(within(panel).getByRole("button", { name: "Add bank transfer" }));
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()?.tenders).toEqual([{ tenderType: "BANK_TRANSFER", amount: "845.00" }]);
  });

  it("credit needs a customer, and is checked against their credit left before it is sent", async () => {
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    let panel = await toPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Remove cash payment" }));
    await user.click(within(panel).getByRole("button", { name: "Add credit" }));
    expect(within(panel).getByText("Credit needs a customer. Add the customer before charging.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();

    // Wanjiru has no credit at all.
    await user.click(screen.getByRole("button", { name: /Add customer/ }));
    let sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
    await user.click(within(sheet).getByRole("button", { name: /Wanjiru Builders/ }));
    panel = screen.getByRole("region", { name: "Take payment" });
    expect(await within(panel).findByText("Wanjiru Builders has KES 0.00 of credit left; this puts KES 845.00 on credit.")).toBeInTheDocument();
    // Choosing a customer re-asks the quote; no charge until it answers.
    expect(within(panel).getByRole("button", { name: /Updating the total|Charge KES 845.00/ })).toBeDisabled();
    expect(await within(panel).findByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();

    // Kiptoo has 7,500.00 left.
    await user.click(within(screen.getByRole("region", { name: "Customer" })).getByRole("button", { name: /Change|Add customer/ }));
    sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
    await user.click(within(sheet).getByRole("button", { name: /Kiptoo Hardware/ }));
    await waitFor(() => expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeEnabled());
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()).toMatchObject({ customerId: "c-1", tenders: [{ tenderType: "CREDIT", amount: "845.00" }] });
  });

  it("splits cash and credit", async () => {
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    await user.click(screen.getByRole("button", { name: /Add customer/ }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
    await user.click(within(sheet).getByRole("button", { name: /Kiptoo Hardware/ }));
    const panel = await toPayment(user);
    const cash = within(panel).getByLabelText("Cash amount (KES)");
    await user.clear(cash);
    await user.type(cash, "500");
    await user.click(within(panel).getByRole("button", { name: "Add credit" }));
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()?.tenders).toEqual([
      { tenderType: "CASH", amount: "500.00" },
      { tenderType: "CREDIT", amount: "345.00" },
    ]);
  });

  it("insufficient stock: the refusal is shown and the cart and tenders are kept", async () => {
    routes.unshift((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales" ? refusal(400, "Insufficient stock for Bamburi Cement 50kg at Till 1: requested 1.000, available 0.000.") : null));
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await user.type(within(panel).getByLabelText("Cash received (KES)"), "1000");
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/Insufficient stock for Bamburi Cement 50kg/);
    expect(within(panel).getByLabelText("Cash received (KES)")).toHaveValue("1000");
    // The cart is locked while payment is taken: editing it clears the payments, after asking.
    await user.click(within(panel).getByRole("button", { name: "Back to the cart" }));
    await user.click(await screen.findByRole("button", { name: "Clear payments and edit the cart" }));
    expect(within(screen.getByRole("list", { name: "Cart" })).getByText("Bamburi Cement 50kg")).toBeInTheDocument();
  });

  it("a closed period (409) is shown as the server says it", async () => {
    routes.unshift((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales" ? refusal(409, "Accounting period 2026-11 is closed.") : null));
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Accounting period 2026-11 is closed.");
  });

  it("a total that changed underneath (tender mismatch) re-asks the quote and says so", async () => {
    routes.unshift((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales" ? refusal(400, "Tenders total KES 845.00 but the sale total is KES 900.00.") : null));
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    const before = calls.filter((call) => call.url.pathname === "/api/v1/pos/sales/quote").length;
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(/The total changed to KES 900.00/);
    await waitFor(() => expect(calls.filter((call) => call.url.pathname === "/api/v1/pos/sales/quote").length).toBeGreaterThan(before));
  });

  it("New sale clears the till and returns to search", async () => {
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    const next = await screen.findByRole("button", { name: "New sale" });
    await waitFor(() => expect(next).toHaveFocus());
    await user.click(next);
    expect(await screen.findByLabelText("Scan or search products")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Cart" })?.textContent ?? "").not.toContain("Bamburi");
    expect(screen.getByRole("button", { name: "Take payment" })).toBeDisabled();
  });
});

describe("the receipt", () => {
  it("a non-registered seller prints one D line and no fiscal block for an unfiled sale", () => {
    render(<ReceiptSlip receipt={receipt()} />);
    const codes = screen.getByRole("table", { name: "VAT by tax code" });
    expect(within(codes).getAllByRole("row")).toHaveLength(2);
    expect(within(codes).getByText("D No VAT — not VAT registered")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "KRA eTIMS" })).not.toBeInTheDocument();
    expect(screen.getByText("Change").nextSibling).toHaveTextContent("360.00");
    expect(screen.getByText("Asante — karibu tena!")).toBeInTheDocument();
  });

  it("prints the eTIMS block only when the sale was SIGNED", () => {
    const pending = receipt({ etims: { fiscalStatus: "PENDING_ETIMS", invoiceNumber: "17", kraReceiptNumber: null, rcptSign: null, intrlData: null, sdcDateTime: null, qrCode: null } });
    const { unmount } = render(<ReceiptSlip receipt={pending} />);
    expect(screen.queryByRole("region", { name: "KRA eTIMS" })).not.toBeInTheDocument();
    unmount();
    render(<ReceiptSlip receipt={receipt({ etims: { fiscalStatus: "SIGNED", invoiceNumber: "17", kraReceiptNumber: "KRA-1", rcptSign: "SIG", intrlData: null, sdcDateTime: "20261105101500", qrCode: "https://etims.kra.go.ke/x" } })} />);
    const block = screen.getByRole("region", { name: "KRA eTIMS" });
    expect(within(block).getByText("Invoice no. 17")).toBeInTheDocument();
    expect(within(block).getByText("Signature SIG")).toBeInTheDocument();
  });

  it("prints through the browser's print, from a thermal-width print area", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const user = userEvent.setup();
    showTill();
    await cartOf(user, /Bamburi Cement 50kg/);
    const panel = await toPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    const slip = await screen.findByRole("article", { name: "Receipt" });
    expect(slip.closest(".print-area")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Print receipt" }));
    expect(print).toHaveBeenCalledOnce();
  });
});

describe("closing the shift", () => {
  function closes(over: Parameters<typeof shift>[0]) {
    routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/shifts/shift-1/close" ? json(200, shift({ status: "CLOSED", ...over })) : null));
  }

  it("counts, confirms, sends shillings, and shows a SHORT drawer from the server's figures", async () => {
    closes({ closingFloat: "395000", expectedCash: "400000", variance: "-5000", closedAt: "2026-11-05T15:00:00.000Z" });
    const user = userEvent.setup();
    showTill();
    await user.click(await screen.findByRole("button", { name: "Close shift" }));
    const sheet = await screen.findByRole("dialog", { name: "Close your shift" });
    await user.type(within(sheet).getByLabelText("Cash counted (KES)"), "3,950");
    await user.click(within(sheet).getByRole("button", { name: "Review and close" }));
    expect(within(sheet).getByText("Close the shift with KES 3,950.00 counted?")).toBeInTheDocument();
    expect(calls.some((call) => call.url.pathname.endsWith("/close"))).toBe(false);
    await user.click(within(sheet).getByRole("button", { name: "Yes, close the shift" }));

    const result = await screen.findByRole("dialog", { name: "Shift closed" });
    expect(calls.find((call) => call.url.pathname.endsWith("/close"))?.body).toEqual({ closingFloat: "3950.00" });
    expect(within(result).getByText("Expected in the drawer").nextSibling).toHaveTextContent("KES 4,000.00");
    expect(within(result).getByText("Short").nextSibling).toHaveTextContent("−KES 50.00");
    expect(within(result).getByRole("table", { name: "Takings by payment type" })).toHaveTextContent(/Cash\s*KES 3,000.00/);
    expect(await axeViolations()).toEqual([]);
  });

  it("an OVER drawer is shown as over", async () => {
    closes({ closingFloat: "410000", expectedCash: "400000", variance: "10000" });
    const user = userEvent.setup();
    showTill();
    await user.click(await screen.findByRole("button", { name: "Close shift" }));
    const sheet = await screen.findByRole("dialog", { name: "Close your shift" });
    await user.type(within(sheet).getByLabelText("Cash counted (KES)"), "4100");
    await user.click(within(sheet).getByRole("button", { name: "Review and close" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, close the shift" }));
    const result = await screen.findByRole("dialog", { name: "Shift closed" });
    expect(within(result).getByText("Over").nextSibling).toHaveTextContent("+KES 100.00");
  });

  it("the variance is read from the server, never worked out from the change given", () => {
    expect(describeVariance("-5000")).toEqual({ label: "Short", amount: "−KES 50.00", tone: "short" });
    expect(describeVariance("0")).toEqual({ label: "Balanced", amount: "KES 0.00", tone: "even" });
    expect(describeVariance("10000")).toEqual({ label: "Over", amount: "+KES 100.00", tone: "over" });
  });
});

describe("role-adaptive", () => {
  it("a cashier sells and closes their own shift; the credit-limit field stays an owner's", async () => {
    showTill("CASHIER");
    expect(await screen.findByRole("button", { name: "Close shift" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take payment" })).toBeDisabled();
  });
});

describe("pure tender math: BigInt cents, never numbers", () => {
  it("change is cash received minus the cash amount, and does not count towards the total", () => {
    const cash = { ...newTender("CASH", 102000n), cashReceived: "1500" };
    const result = evaluateTenders([cash], 102000n, null);
    expect(result).toMatchObject({ tendered: 102000n, outstanding: 0n, change: 48000n, canCharge: true });
    expect(tendersToBody([cash])).toEqual([{ tenderType: "CASH", amount: "1020.00", cashReceived: "1500.00" }]);
  });

  it("refuses cash received below the amount, and a non-amount", () => {
    const short = { ...newTender("CASH", 84500n), cashReceived: "500" };
    expect(evaluateTenders([short], 84500n, null).canCharge).toBe(false);
    expect(evaluateTenders([{ ...newTender("CASH", 0n), amount: "abc" }], 84500n, null).canCharge).toBe(false);
  });

  it("checks credit against limit − balance", () => {
    const credit = newTender("CREDIT", 750001n);
    expect(evaluateTenders([credit], 750001n, customer()).blocking).toMatch(/KES 7,500.00 of credit left/);
    expect(evaluateTenders([newTender("CREDIT", 750000n)], 750000n, customer()).canCharge).toBe(true);
    expect(CUSTOMERS[1] && evaluateTenders([newTender("CREDIT", 1n)], 1n, CUSTOMERS[1]).canCharge).toBe(false);
  });

  it("quote fixture sanity: the sale total is the quote's", () => {
    expect(quoteFor({ lines: [{ productId: CEMENT.id, quantity: "1", discount: "45.00" }, { productId: NAILS.id, quantity: "1" }] }).total).toBe("102000");
  });
});
