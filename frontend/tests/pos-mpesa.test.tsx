// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stkTiming } from "@/lib/pos/hooks";
import { evaluateTenders, markStale, newTender, tendersToBody, toMsisdn, type TenderLine } from "@/lib/pos/tender";
import { axeViolations } from "./support/catalog";
import { chooseLocation, installPosFetch, installStk, json, quoteFor, receipt, showTill, TILL, type Call, type Route } from "./support/pos";

// The till, Wave 1b-ii part 1: M-Pesa. A PRE-SALE STK prompt (push, wait, confirm) whose checkout
// id goes with the sale; a refused, timed-out or unanswered prompt that never dead-ends; and the
// manual tender — the code off the customer's message, with its channel. The BFF is stubbed at
// fetch, and M-Pesa's answer is driven through the dev deliver route, as on the live server.

vi.mock("next/navigation", () => ({ usePathname: () => "/pos", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];
let stk: ReturnType<typeof installStk>;
const timing = { ...stkTiming };

beforeEach(() => {
  chooseLocation(TILL.id);
  ({ calls, routes } = installPosFetch());
  stk = installStk(routes);
  routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales" ? json(201, { id: "sale-9" }) : null));
  routes.push((call) => (call.url.pathname === "/api/v1/pos/sales/sale-9/receipt" ? json(200, receipt()) : null));
  routes.push((call) => (call.url.pathname === "/api/v1/pos/sales/sale-9" ? json(200, { id: "sale-9", saleNumber: "SALE-20261105-000009", status: "COMPLETED", total: "84500", voidReason: null }) : null));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chooseLocation(null);
  Object.assign(stkTiming, timing);
});

type SaleSent = { sellingLocationId: string; tenders: Array<Record<string, string>> };
const saleSent = () => calls.filter((call) => call.method === "POST" && call.url.pathname === "/api/v1/pos/sales").at(-1)?.body as SaleSent | undefined;
const pushesSent = () => calls.filter((call) => call.method === "POST" && call.url.pathname === "/api/v1/pos/mpesa/stk-push").map((call) => call.body);

async function cementToPayment(user: ReturnType<typeof userEvent.setup>) {
  showTill();
  await user.type(await screen.findByLabelText("Scan or search products"), "Bamburi");
  await user.click(await screen.findByRole("button", { name: /Bamburi Cement 50kg/ }));
  const pay = await screen.findByRole("button", { name: /^Take payment · KES/ });
  await waitFor(() => expect(pay).toBeEnabled());
  await user.click(pay);
  const panel = await screen.findByRole("region", { name: "Take payment" });
  // Start from an M-Pesa tender for the whole total.
  await user.click(within(panel).getByRole("button", { name: "Remove cash payment" }));
  await user.click(within(panel).getByRole("button", { name: "Add M-Pesa" }));
  return panel;
}

async function prompt(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement, phone = "0712 345 678") {
  await user.type(within(panel).getByLabelText("Customer phone"), phone);
  await user.click(within(panel).getByRole("button", { name: "Prompt customer (STK)" }));
  await within(panel).findByText(/Waiting for the customer to enter their M-Pesa PIN/);
}

describe("M-Pesa STK — prompt the customer's phone before the sale", () => {
  it("pushes the amount in shillings, waits, and on CALLBACK_OK charges with the checkout id", async () => {
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await prompt(user, panel);
    expect(pushesSent()).toEqual([{ phoneNumber: "254712345678", amount: "845.00" }]);
    // Nothing is charged while the customer is still answering; the amount is fixed to the prompt.
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();
    expect(within(panel).getByLabelText("M-Pesa amount (KES)")).toHaveAttribute("readonly");
    expect(await axeViolations()).toEqual([]);

    await stk.deliver("ws_CO_1", "success");
    await user.click(within(panel).getByRole("button", { name: "Check now" }));
    expect(await within(panel).findByText(/M-Pesa confirmed · receipt QK1ABC1234/)).toBeInTheDocument();
    // Money received cannot be removed from the sale.
    expect(within(panel).queryByRole("button", { name: "Remove M-Pesa payment" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()).toMatchObject({
      sellingLocationId: TILL.id,
      tenders: [{ tenderType: "MPESA", amount: "845.00", mpesaChannel: "STK", mpesaCheckoutRequestId: "ws_CO_1" }],
    });
    expect(saleSent()?.tenders[0]).not.toHaveProperty("mpesaReference");
  });

  it("polls on its own until M-Pesa answers", async () => {
    stkTiming.pollMs = 30;
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await prompt(user, panel);
    await stk.deliver("ws_CO_1", "success");
    expect(await within(panel).findByText(/M-Pesa confirmed/)).toBeInTheDocument();
  });

  it("a refused prompt never dead-ends: prompt again, or take the code instead — the cart is kept", async () => {
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await prompt(user, panel);
    await stk.deliver("ws_CO_1", "failure");
    await user.click(within(panel).getByRole("button", { name: "Check now" }));
    expect(await within(panel).findByText("The customer did not complete the M-Pesa payment (Request cancelled by user).")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();

    // Prompt again: a second push for the same amount.
    await user.click(within(panel).getByRole("button", { name: "Prompt again" }));
    await within(panel).findByText(/Waiting for the customer/);
    expect(pushesSent()).toHaveLength(2);
    await stk.deliver("ws_CO_2", "failure");
    await user.click(within(panel).getByRole("button", { name: "Check now" }));
    await within(panel).findByText(/did not complete/);

    // The customer paid some other way they can show: switch this line to the code.
    await user.click(within(panel).getByRole("button", { name: "Enter the M-Pesa code instead" }));
    expect(within(panel).getByRole("radio", { name: "Phone prompt (answered late)" })).toBeChecked();
    await user.type(within(panel).getByLabelText("M-Pesa code"), "qk7ab12cde");
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()?.tenders).toEqual([{ tenderType: "MPESA", amount: "845.00", mpesaChannel: "STK", mpesaReference: "QK7AB12CDE" }]);
  });

  it("a prompt the server times out can be removed and paid another way", async () => {
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await prompt(user, panel);
    stk.timeOut("ws_CO_1");
    await user.click(within(panel).getByRole("button", { name: "Check now" }));
    expect(await within(panel).findByText("The M-Pesa prompt timed out before the customer paid.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Remove this payment" }));
    expect(within(panel).queryByLabelText("M-Pesa amount (KES)")).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Add cash" }));
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()?.tenders).toEqual([{ tenderType: "CASH", amount: "845.00" }]);
  });

  it("a prompt nobody answers stops waiting and says what to do, rather than spinning forever", async () => {
    stkTiming.pollMs = 30;
    stkTiming.quietAfterMs = 0;
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await user.type(within(panel).getByLabelText("Customer phone"), "0712345678");
    await user.click(within(panel).getByRole("button", { name: "Prompt customer (STK)" }));
    expect(await within(panel).findByText("No answer from M-Pesa yet.")).toBeInTheDocument();
    expect(within(panel).getByText(/if they have paid, enter the code from their M-Pesa message/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Keep waiting" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Prompt again" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Remove this payment" })).toBeInTheDocument();
  });

  it("refuses a number M-Pesa cannot prompt, without sending anything", async () => {
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await user.type(within(panel).getByLabelText("Customer phone"), "12345");
    await user.click(within(panel).getByRole("button", { name: "Prompt customer (STK)" }));
    expect(within(panel).getByText("Enter the customer's M-Pesa number, e.g. 0712 345 678.")).toBeInTheDocument();
    expect(pushesSent()).toEqual([]);
  });

  it("a till without M-Pesa set up says so and offers the code instead", async () => {
    routes.unshift((call) => (call.url.pathname === "/api/v1/pos/mpesa/stk-push" ? json(400, { statusCode: 400, error: "IntegrationNotConfigured", message: "M-Pesa is not set up for this business." }) : null));
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await user.type(within(panel).getByLabelText("Customer phone"), "0712345678");
    await user.click(within(panel).getByRole("button", { name: "Prompt customer (STK)" }));
    expect(await within(panel).findByText("The prompt was not sent: M-Pesa is not set up for this business.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Enter the M-Pesa code instead" }));
    expect(within(panel).getByRole("radio", { name: "Till (Buy Goods)" })).toBeChecked();
  });
});

describe("M-Pesa manual — the code off the customer's message", () => {
  it("Till: carries the channel and the code, confirmed at once", async () => {
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Enter the M-Pesa code instead" }));
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();
    expect(within(panel).getByText("Enter the M-Pesa code from the customer's message.")).toBeInTheDocument();
    await user.type(within(panel).getByLabelText("M-Pesa code"), "RKT4XY78ZQ");
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()?.tenders).toEqual([{ tenderType: "MPESA", amount: "845.00", mpesaChannel: "TILL", mpesaReference: "RKT4XY78ZQ" }]);
    expect(pushesSent()).toEqual([]);
  });

  it("Paybill", async () => {
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Enter the M-Pesa code instead" }));
    await user.click(within(panel).getByRole("radio", { name: "Paybill" }));
    await user.type(within(panel).getByLabelText("M-Pesa code"), "RKT4XY78ZQ");
    await user.click(within(panel).getByRole("button", { name: "Charge KES 845.00" }));
    await screen.findByText("Sale complete");
    expect(saleSent()?.tenders[0]).toMatchObject({ mpesaChannel: "PAYBILL", mpesaReference: "RKT4XY78ZQ" });
  });

  it("refuses a code with anything but letters and numbers", async () => {
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    await user.click(within(panel).getByRole("button", { name: "Enter the M-Pesa code instead" }));
    await user.type(within(panel).getByLabelText("M-Pesa code"), "RKT-4XY");
    expect(within(panel).getByText(/letters and numbers only/)).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Charge KES 845.00" })).toBeDisabled();
  });
});

describe("a total that moves under an M-Pesa prompt not yet sent", () => {
  it("clears the prompt's amount and says so, so the phone is never asked for the old total", async () => {
    // A customer re-prices the basket (the server's quote, not the till's arithmetic).
    routes.unshift((call) => {
      if (call.method !== "POST" || call.url.pathname !== "/api/v1/pos/sales/quote") return null;
      const body = call.body as Parameters<typeof quoteFor>[0] & { customerId?: string };
      const quote = quoteFor(body);
      return json(200, body.customerId ? { ...quote, total: "80000", subtotal: "80000" } : quote);
    });
    const user = userEvent.setup();
    const panel = await cementToPayment(user);
    expect(within(panel).getByLabelText("M-Pesa amount (KES)")).toHaveValue("845.00");
    await user.click(screen.getByRole("button", { name: /Add customer/ }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
    await user.click(within(sheet).getByRole("button", { name: /Kiptoo Hardware/ }));
    expect(await within(panel).findByText("The total changed to KES 800.00. Check the payments before charging.")).toBeInTheDocument();
    expect(within(panel).getByLabelText("M-Pesa amount (KES)")).toHaveValue("");
    expect(within(panel).getByText("The total changed. Enter this amount again.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Pay the rest" }));
    expect(within(panel).getByLabelText("M-Pesa amount (KES)")).toHaveValue("800.00");
  });
});

describe("pure M-Pesa tender math", () => {
  const confirmed = (amount: bigint): TenderLine => {
    const line = newTender("MPESA", amount);
    return { ...line, mpesa: { mode: "stk", phone: "0712345678", stage: "confirmed", checkoutRequestId: "ws_CO_9", sentAt: 1, receiptNumber: "QK9", failure: null } };
  };

  it("only a confirmed push, or a manual code, can be charged", () => {
    expect(evaluateTenders([newTender("MPESA", 84500n)], 84500n, null).canCharge).toBe(false);
    expect(evaluateTenders([confirmed(84500n)], 84500n, null).canCharge).toBe(true);
    const manual = { ...newTender("MPESA", 84500n), mpesa: { mode: "manual" as const, channel: "PAYBILL" as const, reference: " rkt4xy78zq " } };
    expect(evaluateTenders([manual], 84500n, null).canCharge).toBe(true);
    expect(tendersToBody([manual])).toEqual([{ tenderType: "MPESA", amount: "845.00", mpesaChannel: "PAYBILL", mpesaReference: "RKT4XY78ZQ" }]);
    expect(tendersToBody([confirmed(84500n)])).toEqual([{ tenderType: "MPESA", amount: "845.00", mpesaChannel: "STK", mpesaCheckoutRequestId: "ws_CO_9" }]);
  });

  it("a re-quote clears only a push not yet answered for", () => {
    const draft = newTender("MPESA", 84500n);
    const cash = newTender("CASH", 10000n);
    const [after, kept, cashAfter] = markStale([draft, confirmed(50000n), cash]);
    expect(after).toMatchObject({ amount: "", stale: true });
    expect(kept).toMatchObject({ amount: "500.00", stale: false });
    expect(cashAfter).toMatchObject({ amount: "100.00", stale: false });
  });

  it("reads a Kenyan number the way a cashier types it", () => {
    expect(toMsisdn("0712 345 678")).toBe("254712345678");
    expect(toMsisdn("+254 112 345 678")).toBe("254112345678");
    expect(toMsisdn("712345678")).toBe("254712345678");
    expect(toMsisdn("0812345678")).toBeNull();
    expect(toMsisdn("12345")).toBeNull();
  });
});
