// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exceeds, stepQuantity, toMilli } from "@/lib/pos/quantity";
import { cartReducer, cartToLines } from "@/lib/pos/cart";
import { cashierMessage } from "@/lib/pos/messages";
import { axeViolations } from "./support/catalog";
import { CEMENT, chooseLocation, installPosFetch, json, NAILS, quoteFor, refusal, shift, showTill, TILL, type Call, type Route } from "./support/pos";

// The till, Wave 1b-i part 1: the location and shift gates, search → cart, the live quote that
// prices every figure (sent with the selling location), per-line discounts in shillings, the
// sellable-quantity warning, and the customer. The BFF is stubbed at fetch.

vi.mock("next/navigation", () => ({ usePathname: () => "/pos", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let calls: Call[];
let routes: Route[];

beforeEach(() => {
  chooseLocation(TILL.id);
  ({ calls, routes } = installPosFetch());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chooseLocation(null);
});

const quotes = () => calls.filter((call) => call.url.pathname === "/api/v1/pos/sales/quote");
const lastQuote = () => quotes().at(-1)?.body as { lines: Array<{ productId: string; quantity: string; discount?: string }>; sellingLocationId: string; customerId?: string } | undefined;

async function addCement(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Scan or search products"), "cement");
  await user.click(await screen.findByRole("button", { name: /Bamburi Cement 50kg/ }));
}

describe("the gates", () => {
  it("asks an owner or manager to choose a location — it never sells from MAIN on the shell's fallback", async () => {
    chooseLocation(null);
    const user = userEvent.setup();
    showTill("MSME_MANAGER");
    expect(await screen.findByText("Choose the location you are selling from")).toBeInTheDocument();
    expect(calls.some((call) => call.url.pathname === "/api/v1/pos/shifts/current")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Sell from Till 1" }));
    expect(await screen.findByText(/Shift open/)).toBeInTheDocument();
    expect(document.cookie).toContain(`ag_location=${TILL.id}`);
  });

  it("opens a shift with the counted float, sent in shillings", async () => {
    let open = false;
    routes.push((call) => (call.url.pathname === "/api/v1/pos/shifts/current" && !open ? refusal(404, "No open shift.") : null));
    routes.push((call) => {
      if (call.method !== "POST" || call.url.pathname !== "/api/v1/pos/shifts/open") return null;
      open = true;
      return json(201, shift());
    });
    const user = userEvent.setup();
    showTill();
    expect(await screen.findByRole("heading", { name: "Open your shift" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Scan or search products")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Cash in the drawer (KES)"), "1,000");
    await user.click(screen.getByRole("button", { name: "Open shift" }));
    expect(await screen.findByText(/Shift open/)).toBeInTheDocument();
    expect(calls.find((call) => call.url.pathname === "/api/v1/pos/shifts/open")?.body).toEqual({ openingFloat: "1000.00" });
    expect(screen.getByText(/3 sales · KES 4,500.00/)).toBeInTheDocument();
  });
});

describe("selling", () => {
  it("search → cart; the quote is asked WITH the selling location and its total drives the screen", async () => {
    const user = userEvent.setup();
    showTill();
    await addCement(user);
    await waitFor(() => expect(lastQuote()).toEqual({ lines: [{ productId: CEMENT.id, quantity: "1" }], sellingLocationId: TILL.id }));
    const totals = screen.getByRole("region", { name: "Sale total" });
    expect(await within(totals).findByText("KES 845.00")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Cart" })).getByText("KES 845.00")).toBeInTheDocument();
    expect(screen.getByLabelText("Scan or search products")).toHaveValue("");
    expect(await axeViolations()).toEqual([]);
  });

  it("Enter adds the exact barcode match at once (a scanner)", async () => {
    const user = userEvent.setup();
    showTill();
    await user.type(await screen.findByLabelText("Scan or search products"), "6001234500012{Enter}");
    expect(await within(await screen.findByRole("list", { name: "Cart" })).findByText("Bamburi Cement 50kg")).toBeInTheDocument();
    expect(screen.getByLabelText("Scan or search products")).toHaveFocus();
  });

  it("steppers and a per-line discount in shillings re-price through the quote", async () => {
    const user = userEvent.setup();
    showTill();
    await addCement(user);
    await user.click(await screen.findByRole("button", { name: "One more Bamburi Cement 50kg" }));
    await user.type(screen.getByLabelText("Discount (KES)"), "50");
    await waitFor(() => expect(lastQuote()?.lines).toEqual([{ productId: CEMENT.id, quantity: "2", discount: "50.00" }]));
    // 2 × 845.00 − 50.00 = 1,640.00 — the server's figure, shown as it is.
    expect(await within(screen.getByRole("region", { name: "Sale total" })).findByText("KES 1,640.00")).toBeInTheDocument();
  });

  it("a mistyped discount is a line error and is never sent", async () => {
    const user = userEvent.setup();
    showTill();
    await addCement(user);
    await waitFor(() => expect(quotes().length).toBeGreaterThan(0));
    const sent = quotes().length;
    await user.type(screen.getByLabelText("Discount (KES)"), "12.345");
    expect(await screen.findByText("Enter the discount in shillings, e.g. 50 or 12.50.")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(quotes().length).toBe(sent);
  });

  it("warns before submit when a line asks for more than the location holds", async () => {
    routes.push((call) => (call.url.pathname === "/api/v1/pos/sales/quote" ? json(200, quoteFor(call.body as Parameters<typeof quoteFor>[0], "1.000")) : null));
    const user = userEvent.setup();
    showTill();
    await addCement(user);
    await user.click(await screen.findByRole("button", { name: "One more Bamburi Cement 50kg" }));
    expect(await screen.findByText("Only 1 bag left at Till 1.")).toBeInTheDocument();
    expect(screen.getByText(/A line asks for more than Till 1 holds/)).toBeInTheDocument();
  });

  it("shows the quote's refusal in words", async () => {
    routes.push((call) => (call.url.pathname === "/api/v1/pos/sales/quote" ? refusal(400, "Line 1: discount exceeds the line value.") : null));
    const user = userEvent.setup();
    showTill();
    await addCement(user);
    expect(await within(screen.getByRole("region", { name: "Sale total" })).findByText("Line 1: discount exceeds the line value.")).toBeInTheDocument();
  });
});

describe("the customer", () => {
  it("is picked from a client-filtered list (inactive ones hidden) and sent on the quote", async () => {
    const user = userEvent.setup();
    showTill();
    await addCement(user);
    await user.click(screen.getByRole("button", { name: /Add customer/ }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
    await user.type(within(sheet).getByLabelText("Search customers"), "kip");
    const list = await within(sheet).findByRole("list", { name: "Customers" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(within(sheet).queryByText("Old Client")).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Kiptoo Hardware/ }));
    expect(await screen.findByText(/Credit left KES 7,500.00/)).toBeInTheDocument();
    await waitFor(() => expect(lastQuote()?.customerId).toBe("c-1"));
  });

  it("is quick-created; only an owner or manager may give a credit limit", async () => {
    routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/customers" ? json(201, { ...(call.body as object), id: "c-new", loyaltyPoints: 0, creditLimit: "0", creditBalance: "0", isActive: true, email: null, kraPin: null, phone: "0733000000", createdAt: "x", updatedAt: "x" }) : null));
    const user = userEvent.setup();
    showTill("CASHIER");
    await user.click(await screen.findByRole("button", { name: /Add customer/ }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
    expect(within(sheet).queryByLabelText(/Credit limit/)).not.toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Name"), "Achieng Stores");
    await user.type(within(sheet).getByLabelText(/Phone/), "0733000000");
    await user.click(within(sheet).getByRole("button", { name: "Add and select" }));
    expect(await within(screen.getByRole("region", { name: "Customer" })).findByText("Achieng Stores")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST" && call.url.pathname === "/api/v1/customers")?.body).toEqual({ name: "Achieng Stores", phone: "0733000000" });
  });

  it("an owner may set a credit limit, sent in shillings", async () => {
    routes.push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/customers" ? json(201, { id: "c-new", name: "A", phone: null, email: null, kraPin: null, loyaltyPoints: 0, creditLimit: "500000", creditBalance: "0", isActive: true, createdAt: "x", updatedAt: "x" }) : null));
    const user = userEvent.setup();
    showTill("MSME_OWNER");
    await user.click(await screen.findByRole("button", { name: /Add customer/ }));
    const sheet = await screen.findByRole("dialog", { name: "Choose a customer" });
    await user.type(within(sheet).getByLabelText("Name"), "A");
    await user.type(within(sheet).getByLabelText(/Credit limit/), "5,000");
    await user.click(within(sheet).getByRole("button", { name: "Add and select" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST" && call.url.pathname === "/api/v1/customers")?.body).toEqual({ name: "A", creditLimit: "5000.00" }));
  });
});

describe("pure helpers: no JS numbers", () => {
  it("quantities step and compare as BigInt thousandths", () => {
    expect(toMilli("1.5")).toBe(1500n);
    expect(stepQuantity("1.5", 1)).toBe("2.5");
    expect(stepQuantity("0.5", -1)).toBe("0");
    expect(exceeds("2", "1.000")).toBe(true);
    expect(exceeds("1", "1.000")).toBe(false);
  });

  it("the cart sends discounts as the API's shilling strings, and nothing while a line is invalid", () => {
    const item = { id: NAILS.id, sku: NAILS.sku, name: NAILS.name, kind: "GOOD" as const, unitOfMeasure: "kg", price: NAILS.price };
    let lines = cartReducer([], { type: "add", product: item });
    lines = cartReducer(lines, { type: "add", product: item });
    lines = cartReducer(lines, { type: "discount", productId: item.id, discount: "1,250.5" });
    expect(cartToLines(lines)).toEqual([{ productId: item.id, quantity: "2", discount: "1250.50" }]);
    expect(cartToLines(cartReducer(lines, { type: "quantity", productId: item.id, quantity: "0" }))).toBeNull();
  });

  it("rewords the API's credit and tender refusals for a cashier", () => {
    expect(cashierMessage("Credit of KES 1,500.00 exceeds the customer's remaining credit of KES 1,000.00.")).toBe("This puts KES 1,500.00 on credit, but the customer has only KES 1,000.00 of credit left.");
    expect(cashierMessage("Tenders total KES 845.00 but the sale total is KES 900.00.")).toMatch(/total changed to KES 900.00 \(payment entered: KES 845.00\)/);
    expect(cashierMessage("Insufficient stock for X: requested 2.000, available 1.000.")).toBe("Insufficient stock for X: requested 2.000, available 1.000.");
  });
});
